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

const { fetchLearnerState } = require('../learner-context/api')
const { normalizeLearnerContext } = require('../learner-context/normalize')
const { main: runRetrieval } = require('../retrieval')
const { almClient, AlmError } = require('../shared/alm')
const { resolveLayout } = require('./resolve-layout')

const BLOCK_IDS = ['pl-todays-plan', 'pl-cohort-readiness', 'pl-my-priorities', 'pl-recommended']
const PRIORITY_GROUPS = [
  { key: 'now', label: 'Now' },
  { key: 'next', label: 'Next' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'upcoming', label: 'Upcoming' }
]

function isInProgress (item) {
  return item.state === 'STARTED' && item.progressPercent > 0 && item.progressPercent < 100
}

function cleanItem (item, type, enrolled = true) {
  if (!item || !item.loId || !item.title) return null
  const output = {
    loId: item.loId,
    title: item.title,
    type: item.type || type
  }
  if (Number.isFinite(item.progressPercent)) output.progressPercent = item.progressPercent
  if (item.state) output.state = item.state
  if (item.dueDate) output.dueDate = item.dueDate
  output.enrolled = enrolled
  if (Number.isFinite(item.durationMinutes)) output.durationMinutes = item.durationMinutes
  return output
}

function localizedName (attributes = {}) {
  const entries = attributes.localizedMetadata || []
  const match = entries.find(entry => entry.locale && entry.locale.startsWith('en')) || entries[0]
  return match?.name || attributes.name || ''
}

function cohortReadiness (context, raw) {
  const completed = new Set(context.progress?.completedIds || [])
  const included = new Map((raw.enrollments.included || []).map(item => [`${item.type}:${item.id}`, item]))
  const cohorts = (context.cohorts || [])
    .filter(cohort => {
      const timestamp = Date.parse(cohort.sessionDate)
      return Number.isFinite(timestamp) && timestamp > Date.now() &&
        !completed.has(cohort.id) && cohort.requiredAssets.length > 0
    })
    .sort((a, b) => Date.parse(a.sessionDate) - Date.parse(b.sessionDate))

  for (const cohort of cohorts) {
    const prerequisites = cohort.requiredAssets.map(loId => {
      const lo = included.get(`learningObject:${loId}`)
      return {
        loId,
        name: lo ? localizedName(lo.attributes) : String(loId),
        done: completed.has(loId)
      }
    })
    const total = prerequisites.length
    const done = prerequisites.filter(item => item.done).length
    if (done === total) continue
    return {
      loId: cohort.id,
      title: cohort.name,
      sessionDate: cohort.sessionDate,
      readinessPercent: total ? Math.round((100 * done) / total) : 0,
      prerequisites
    }
  }
  return null
}

function recommendationItems (response, completedIds) {
  const completed = new Set(completedIds)
  return (response.data || [])
    .filter(item => item && !completed.has(item.id))
    .map(item => {
      const attributes = item.attributes || {}
      const duration = attributes.duration
      return cleanItem({
        loId: item.id,
        title: localizedName(attributes),
        type: attributes.loType || item.type,
        durationMinutes: Number.isFinite(duration) ? Math.round(duration / 60) : undefined
      }, 'course', false)
    })
    .filter(Boolean)
    .slice(0, 5)
}

function buildBlocksData (context, retrieval, raw, recommendations) {
  const progress = context.progress || {}
  const completed = new Set(progress.completedIds || [])
  const allProgress = [
    ...(progress.byCourse || []).map(item => ({ ...item, type: 'course' })),
    ...(progress.byLearningProgram || []).map(item => ({ ...item, type: 'learningProgram' }))
  ].filter(item => !completed.has(item.loId))

  const inProgress = allProgress
    .filter(isInProgress)
    .sort((a, b) => b.progressPercent - a.progressPercent)
    .map(item => cleanItem(item, item.type))
    .filter(Boolean)

  const candidates = retrieval.candidates || []
  const priorityItems = {
    now: inProgress,
    next: (progress.byLearningProgram || [])
      .filter(item => item.state === 'ENROLLED' && !completed.has(item.loId))
      .map(item => cleanItem(item, 'learningProgram'))
      .filter(Boolean),
    thisWeek: candidates
      .filter(item => item.tier === 'skill-next' || item.tier === 'related')
      .map(item => cleanItem(item, item.type, false))
      .filter(Boolean),
    upcoming: allProgress
      .filter(item => item.dueDate && Date.parse(item.dueDate) > Date.now())
      .sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate))
      .map(item => cleanItem(item, item.type))
      .filter(Boolean)
  }

  const groups = PRIORITY_GROUPS
    .map(group => ({ key: group.key, label: group.label, items: priorityItems[group.key] }))
    .filter(group => group.items.length > 0)

  return {
    'pl-todays-plan': inProgress.slice(0, 3),
    'pl-cohort-readiness': cohortReadiness(context, raw),
    'pl-my-priorities': groups,
    'pl-recommended': recommendations
  }
}

function buildPlan (context, retrieval, raw, recommendations, recommendationsAvailable = true) {
  const resolved = resolveLayout(context, retrieval)
  const meta = {
    mode: resolved.meta.mode,
    aiUsed: false,
    dataScope: 'configured-alm-account'
  }
  if (!recommendationsAvailable) meta.contentWarnings = ['recommendations-unavailable']
  return {
    meta,
    layout: resolved.layout,
    blocksData: buildBlocksData(context, retrieval, raw, recommendations)
  }
}

async function composePlan (dependencies = {}) {
  const loadState = dependencies.fetchLearnerState || fetchLearnerState
  const retrieve = dependencies.runRetrieval || runRetrieval
  const getRecommendations = dependencies.fetchRecommendations || (async () => {
    const alm = almClient()
    return alm.getRecommendations()
  })

  const raw = await loadState()
  const context = normalizeLearnerContext(raw)
  if (context.contextDegraded) throw new Error('Configured ALM account data is unavailable')

  const retrievalResult = await retrieve({
    ...context
  })
  if (retrievalResult.statusCode !== 200 || !retrievalResult.body) {
    if ([401, 403, 503].includes(retrievalResult.statusCode)) {
      throw new AlmError(retrievalResult.body.code, retrievalResult.body.error, retrievalResult.statusCode)
    }
    throw new Error('ALM retrieval is unavailable')
  }

  let recommendations = []
  let recommendationsAvailable = true
  try {
    const response = await getRecommendations()
    recommendations = recommendationItems(response, context.progress.completedIds)
  } catch (error) {
    if (error instanceof AlmError && [401, 403, 503].includes(error.statusCode)) throw error
    console.warn('[compose-plan] ALM recommendations unavailable')
    recommendationsAvailable = false
  }

  return buildPlan(context, retrievalResult.body, raw, recommendations, recommendationsAvailable)
}

module.exports = { BLOCK_IDS, buildPlan, composePlan, recommendationItems }
