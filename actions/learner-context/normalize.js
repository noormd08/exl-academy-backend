/*
Copyright 2026 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

// Transforms the raw ALM Prime API v2 responses (fetched by api.js) into the learner-context output.
// No `goal` field (out of scope). Downstream depends on the names `progress.completedIds` and
// `cohorts[].id` — do not rename.
//
// Enrollments split by learning-object type: `course` -> progress.byCourse + enrollments;
// `learningProgram` -> a cohort (progress.byLearningProgram + cohorts). `active`/`completedIds` span
// both. Sub-courses surface via includeHierarchicalEnrollments=true, so completedIds reflects real
// sub-course completion — needed for accurate cohort prep tracking downstream.

function daysUntil (dateString, now) {
  if (!dateString) return null
  return Math.ceil((new Date(dateString).getTime() - now) / (1000 * 60 * 60 * 24))
}

// Resolves a JSON:API relationship ref ({ id, type }) against an `included` array.
function findIncluded (included, ref) {
  if (!ref) return undefined
  return (included || []).find(item => item.id === ref.id && item.type === ref.type)
}

function localizedName (attributes, locale = 'en-US') {
  const entries = attributes?.localizedMetadata || []
  const match = entries.find(m => m.locale === locale) || entries[0]
  return match?.name
}

// One enrollment + its included learningObject -> a single course/program entry.
function mapEnrollment (enrollment, included) {
  const lo = findIncluded(included, enrollment.relationships.learningObject.data)
  const attrs = enrollment.attributes

  return {
    loId: enrollment.relationships.learningObject.data.id,
    title: lo ? localizedName(lo.attributes) : undefined,
    type: lo?.attributes.loType,
    progressPercent: attrs.progressPercent,
    state: attrs.state, // ALM learnerState: enrolled | started | completed
    // ALM has no true "last accessed" field; dateStarted is the closest proxy.
    lastAccessDate: attrs.dateStarted || attrs.dateEnrolled || null,
    completionDeadline: attrs.completionDeadline || null,
    loInstanceId: enrollment.relationships.loInstance?.data?.id
  }
}

// Each enrolled learningProgram becomes a cohort. Its session date is the enrolled instance's
// startDate, fetched inline via include=loInstance — present for scheduled (Virtual Classroom)
// cohorts, null for self-paced ones (no session, which is correct — not a missing value).
function mapCohorts (enrollmentsResponse, now) {
  const included = enrollmentsResponse.included || []

  return (enrollmentsResponse.data || [])
    .map(enrollment => ({ enrollment, lo: findIncluded(included, enrollment.relationships.learningObject.data) }))
    .filter(({ lo }) => lo?.attributes.loType === 'learningProgram')
    .map(({ enrollment, lo }) => {
      const instance = findIncluded(included, enrollment.relationships.loInstance?.data)
      const sessionDate = instance?.attributes.startDate || null

      const requiredAssets = (lo.attributes.sections || [])
        .filter(section => section.mandatory)
        .flatMap(section => section.loIds || [])

      return {
        id: lo.id,
        name: localizedName(lo.attributes),
        sessionDate,
        startsInDays: daysUntil(sessionDate, now),
        requiredAssets
      }
    })
}

// Earned badge names, from userBadges. `next` is intentionally always null: choosing the next
// achievement is a ranking decision that belongs to orchestrate, not learner-context (golden rule #7).
function mapAchievements (badgesResponse) {
  const included = badgesResponse.included || []
  const earned = (badgesResponse.data || []).map(userBadge => {
    const badge = findIncluded(included, userBadge.relationships.badge.data)
    return badge?.attributes.name || userBadge.relationships.badge.data.id
  })

  return { earned, next: null }
}

// The learner's skills, from GET /users/{id}/userSkills?include=skill,skillLevel — the authoritative
// source (name, level, and pointsEarned inline). One entry per skill (highest level kept), sorted by
// pointsEarned so the strongest come first. Represents "what the learner is best in".
function mapSkillLevels (userSkillsResponse) {
  const included = userSkillsResponse?.included || []
  const skillsById = new Map(included.filter(i => i.type === 'skill').map(s => [s.id, s]))
  const levelsById = new Map(included.filter(i => i.type === 'skillLevel').map(l => [l.id, l]))
  const bestBySkillId = new Map()

  for (const userSkill of userSkillsResponse?.data || []) {
    const skillRef = userSkill.relationships.skill?.data
    const level = levelsById.get(userSkill.relationships.skillLevel?.data?.id)
    const skill = skillsById.get(skillRef?.id)
    const skillId = skillRef?.id

    const entry = {
      skillId,
      skillName: skill?.attributes.name ?? null,
      level: level?.attributes.level,
      levelName: level?.attributes.name,
      pointsEarned: userSkill.attributes.pointsEarned
    }

    const existing = bestBySkillId.get(skillId)
    if (!existing || Number(entry.level) > Number(existing.level)) {
      bestBySkillId.set(skillId, entry)
    }
  }

  return [...bestBySkillId.values()].sort((a, b) => (b.pointsEarned || 0) - (a.pointsEarned || 0))
}

function toProgressEntry ({ loId, title, progressPercent, state, lastAccessDate }) {
  return { loId, title, progressPercent, state, lastAccessDate }
}

function normalizeLearnerContext ({ user, enrollments, badges, userSkills }, { now = Date.now() } = {}) {
  const included = enrollments.included || []
  const allEnrollments = (enrollments.data || []).map(e => mapEnrollment(e, included))
  const courses = allEnrollments.filter(e => e.type === 'course')
  const learningPrograms = allEnrollments.filter(e => e.type === 'learningProgram')

  const progress = {
    active: allEnrollments.filter(e => e.state !== 'COMPLETED').length,
    completedIds: allEnrollments.filter(e => e.state === 'COMPLETED').map(e => e.loId),
    byCourse: courses.map(toProgressEntry),
    byLearningProgram: learningPrograms.map(toProgressEntry)
  }

  const enrollmentsOut = courses.map(({ loId, title, type, progressPercent, state, completionDeadline }) => (
    { loId, title, type, progressPercent, state, completionDeadline }
  ))

  return {
    // roles and skillLevels are both arrays: a learner can hold several ALM RBAC roles at once, and a
    // level per individual skill — not the single job-role/skillLevel scalars the spec first envisioned.
    profile: {
      userId: user.data.id,
      roles: user.data.attributes.roles || [],
      skillLevels: mapSkillLevels(userSkills)
    },
    progress,
    cohorts: mapCohorts(enrollments, now),
    enrollments: enrollmentsOut,
    achievements: mapAchievements(badges)
  }
}

// Minimal valid output when ALM is unreachable, so the sequence keeps running (golden rule #2).
function degradedContext (userId) {
  return {
    profile: { userId, roles: [], skillLevels: [] },
    progress: null,
    cohorts: [],
    enrollments: [],
    achievements: null,
    contextDegraded: true
  }
}

module.exports = { normalizeLearnerContext, degradedContext }
