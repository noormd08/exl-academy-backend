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

// Pure, deterministic layout resolver — no LLM, no network. DECISIONS ONLY: given the real outputs of
// learner-context (`context`) and retrieval (`retrieval`), it decides the display `mode`, and for each
// block whether to show it, its order, emphasis, and an optional `reason` code. It does NOT build any
// block content — the EDS frontend blocks fetch their own data directly from ALM.
//
// Output: { meta: { mode, aiUsed }, layout: { blocks: [ { id, show, order, emphasis, reason? } ] } }
//
// Block ids use the frontend's `pl-` (premium learning) namespace. `pl-my-goal` and `pl-practice-next`
// are part of the frontend set but have no backend decision inputs yet, so they aren't emitted here.

const BLOCK_IDS = ['pl-todays-plan', 'pl-cohort-readiness', 'pl-my-priorities', 'pl-recommended']

// Nominal order/emphasis per mode. A block with show:false is later forced to order:0 regardless.
const ORDERING = {
  prepare: {
    'pl-cohort-readiness': { order: 1, emphasis: true },
    'pl-todays-plan': { order: 2, emphasis: false },
    'pl-my-priorities': { order: 3, emphasis: false },
    'pl-recommended': { order: 4, emphasis: false }
  },
  continue: {
    'pl-todays-plan': { order: 1, emphasis: true },
    'pl-my-priorities': { order: 2, emphasis: false },
    'pl-recommended': { order: 3, emphasis: false },
    'pl-cohort-readiness': { order: 4, emphasis: false }
  },
  learn: {
    'pl-recommended': { order: 1, emphasis: true },
    'pl-my-priorities': { order: 2, emphasis: false },
    'pl-todays-plan': { order: 3, emphasis: false },
    'pl-cohort-readiness': { order: 0, emphasis: false }
  }
}

function isInProgress (item) {
  return item.state === 'STARTED' && item.progressPercent > 0 && item.progressPercent < 100
}

// retrieval.candidates are flat but tagged with a tier; group them to compute show flags.
function candidatesByTier (candidates) {
  const groups = { continue: [], 'cohort-prep': [], 'skill-next': [], related: [] }
  for (const c of candidates) {
    if (groups[c.tier]) groups[c.tier].push(c)
  }
  return groups
}

function resolveLayout (context = {}, retrieval = {}) {
  const progress = context.progress || {}
  const candidates = retrieval.candidates || []

  const tiers = candidatesByTier(candidates)
  const continueCandidates = tiers.continue
  const progressItems = [...(progress.byCourse || []), ...(progress.byLearningProgram || [])]
  const inProgressItems = progressItems.filter(isInProgress)

  // Prep rollups (completed/total) live on retrieval.cohorts, keyed by cohort id.
  const prepById = new Map((retrieval.cohorts || []).map(c => [c.id, c.prep]))

  // Cohorts that are upcoming (future, dated session) AND still have prep to do — nearest session first.
  const upcomingIncompleteCohorts = (context.cohorts || [])
    .map(cohort => ({ cohort, prep: prepById.get(cohort.id) }))
    .filter(({ cohort, prep }) =>
      cohort.sessionDate != null && cohort.startsInDays != null && cohort.startsInDays >= 0 &&
      prep && prep.completed < prep.total)
    .sort((a, b) => a.cohort.startsInDays - b.cohort.startsInDays)

  // --- mode (first match wins) — unchanged ---
  let mode
  if (upcomingIncompleteCohorts.length > 0) mode = 'prepare'
  else if (inProgressItems.length > 0 || continueCandidates.length > 0) mode = 'continue'
  else mode = 'learn'

  // --- show rules (data-driven decisions only) ---
  const qualifyingCohort = upcomingIncompleteCohorts[0]
  const shown = {
    'pl-todays-plan': continueCandidates.length > 0 || inProgressItems.length > 0,
    'pl-cohort-readiness': qualifyingCohort != null,
    'pl-my-priorities': candidates.length > 0 || inProgressItems.length > 0,
    'pl-recommended': tiers['skill-next'].length > 0 || tiers.related.length > 0
  }

  // --- per-block reason codes, derived from the same signals (no new ALM calls) ---
  const reasons = {
    'pl-todays-plan': { code: 'CONTINUE_IN_PROGRESS' },
    'pl-cohort-readiness': qualifyingCohort
      ? { code: 'COHORT_PREP', params: { done: qualifyingCohort.prep.completed, total: qualifyingCohort.prep.total } }
      : undefined,
    'pl-my-priorities': { code: 'PERSONALIZED_PRIORITIES' },
    'pl-recommended': { code: 'BASED_ON_YOUR_SKILLS' }
  }

  const blocks = BLOCK_IDS.map(id => {
    if (!shown[id]) return { id, show: false, order: 0, emphasis: false }
    const { order, emphasis } = ORDERING[mode][id]
    const block = { id, show: true, order, emphasis }
    if (reasons[id]) block.reason = reasons[id]
    return block
  })

  return { meta: { mode, aiUsed: false }, layout: { blocks } }
}

module.exports = { resolveLayout }
