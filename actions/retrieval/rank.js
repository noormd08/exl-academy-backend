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

// Pure, deterministic ranking — no LLM, no network (golden rule #6/#7). Turns a learner-context
// object (+ optional catalog results) into a ranked `candidates` shortlist and an enriched `cohorts`
// detail block. Tier is the primary sort key; within a tier, lower `score` ranks higher.

const TIER_SEQUENCE = ['continue', 'cohort-prep', 'skill-next', 'related']

// cohort-prep score (lower ranks higher): upcoming sessions first (soonest), then self-paced, then
// past sessions — a session that already happened is stale as "prep" and must never outrank an
// upcoming one.
const SELF_PACED_BAND = 1e6
const PAST_BAND = 2e6
function cohortPrepScore (startsInDays) {
  if (startsInDays == null) return SELF_PACED_BAND
  if (startsInDays >= 0) return startsInDays
  return PAST_BAND + Math.abs(startsInDays)
}

function loName (lo) {
  const entries = lo.attributes?.localizedMetadata || []
  const match = entries.find(m => m.locale === 'en-US') || entries[0]
  return match?.name
}

// Every cohort (open and completed) enriched with a status + prep-completion rollup. Kept as the full
// detail/history block; only open cohorts become candidates (see rank).
function enrichCohorts (ctx) {
  const completed = new Set(ctx.progress?.completedIds || [])
  return (ctx.cohorts || []).map(cohort => {
    const items = (cohort.requiredAssets || []).map(loId => ({ loId, completed: completed.has(loId) }))
    return {
      ...cohort,
      status: completed.has(cohort.id) ? 'completed' : 'open',
      prep: { total: items.length, completed: items.filter(i => i.completed).length, items }
    }
  })
}

// Maps ALM catalog learningObjects into candidates, skipping anything in `exclude` and de-duping
// within the tier (e.g. the same related LO surfaced from two seed courses).
function catalogCandidates (los, tier, reason, exclude) {
  const seen = new Set()
  const out = []
  for (const [i, lo] of (los || []).entries()) {
    if (exclude.has(lo.id) || seen.has(lo.id)) continue
    seen.add(lo.id)
    out.push({
      loId: lo.id,
      title: loName(lo),
      type: lo.attributes?.loType || 'course',
      tier,
      reason,
      score: i // preserve the catalog's own ordering (ALM already ranked these)
    })
  }
  return out
}

// `perTier` caps each tier so one flooded tier (e.g. a skill with dozens of matches) can't crowd the
// others out; `limit` is an overall safety cap. Final order is tier sequence, then score within tier.
function rank (ctx, catalog = {}, { perTier = 5, limit = 20 } = {}) {
  const completed = new Set(ctx.progress?.completedIds || [])
  const enrolled = new Set((ctx.enrollments || []).map(e => e.loId))
  const cohorts = enrichCohorts(ctx)
  const byTier = { continue: [], 'cohort-prep': [], 'skill-next': [], related: [] }

  // continue — courses actively in progress; closer to done ranks higher.
  for (const c of ctx.progress?.byCourse || []) {
    if (c.state === 'STARTED' && c.progressPercent < 100) {
      byTier.continue.push({
        loId: c.loId, title: c.title, type: 'course', tier: 'continue',
        reason: `${c.progressPercent}% complete`, score: 100 - c.progressPercent
      })
    }
  }

  // cohort-prep — each open cohort as a unit with its prep rollup, ranked by session urgency.
  for (const c of cohorts.filter(x => x.status === 'open')) {
    byTier['cohort-prep'].push({
      loId: c.id, title: c.name, type: 'learningProgram', tier: 'cohort-prep',
      sessionDate: c.sessionDate, startsInDays: c.startsInDays, prep: c.prep,
      reason: `cohort — ${c.prep.completed} of ${c.prep.total} prep items done`,
      score: cohortPrepScore(c.startsInDays)
    })
  }

  // Discovery tiers come from the catalog. `exclude` grows as tiers are added so no loId appears twice,
  // and completed/enrolled items are never re-surfaced.
  const exclude = new Set([...completed, ...enrolled, ...byTier['cohort-prep'].map(c => c.loId)])
  byTier['skill-next'] = catalogCandidates(catalog.bySkill, 'skill-next', 'builds a skill you already have', exclude)
  byTier['skill-next'].forEach(c => exclude.add(c.loId))
  byTier.related = catalogCandidates(catalog.related, 'related', 'related to what you\'ve learned', exclude)

  const candidates = []
  for (const tier of TIER_SEQUENCE) {
    candidates.push(...byTier[tier].sort((a, b) => a.score - b.score).slice(0, perTier))
  }
  return { candidates: candidates.slice(0, limit), cohorts }
}

module.exports = { rank }
