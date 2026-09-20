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

const { Core } = require('@adobe/aio-sdk')
const { almClient } = require('../shared/alm')
const { rank } = require('./rank')

// layer 3: rank catalog candidates from learner-context (+ catalog).
// The continue + cohort-prep tiers need no network — they come straight from learner-context — so a
// catalog-fetch failure degrades to those tiers rather than failing the action (golden rule #2).
async function main (params) {
  const logger = Core.Logger('retrieval', { level: params.LOG_LEVEL || 'info' })

  // In the Runtime sequence, learner-context's output merges into params. Standalone (tests / the
  // dev check script) it can be passed as a flat context. Tolerate both until compose-plan pins the
  // exact wiring. `params.body` is the wrapped form; a flat context has `profile` directly.
  const ctx = (params.body && params.body.profile) ? params.body : params

  if (!ctx || !ctx.profile || ctx.contextDegraded) {
    logger.info('no usable learner-context; returning empty candidates')
    return { statusCode: 200, body: { candidates: [], cohorts: [] } }
  }

  let catalog = { bySkill: [], related: [] }
  try {
    const alm = almClient({ apiBase: params.PL_API_BASE, apiKey: params.PL_API_KEY })
    const skillNames = (ctx.profile.skillLevels || []).map(s => s.skillName).filter(Boolean)
    // Seed the "related" tier from a few recent courses; capped to keep the relatedLOs fan-out small.
    const seedLoIds = (ctx.progress?.byCourse || []).map(c => c.loId).slice(0, 3)

    const [bySkillLists, relatedLists] = await Promise.all([
      Promise.all(skillNames.map(name =>
        alm.getLearningObjectsBySkill(name).then(r => r.data || []).catch(() => []))),
      Promise.all(seedLoIds.map(loId =>
        alm.getRelatedLOs(loId).then(r => r.data || []).catch(() => [])))
    ])
    catalog = { bySkill: bySkillLists.flat(), related: relatedLists.flat() }
  } catch (err) {
    logger.error(`catalog fetch failed, ranking continue/cohort-prep tiers only: ${err.message}`)
  }

  return { statusCode: 200, body: rank(ctx, catalog) }
}

exports.main = main
