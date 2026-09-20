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

const { main } = require('../actions/retrieval')
const { rank } = require('../actions/retrieval/rank')

// A literal learner-context object (the shape learner-context emits). Synthetic test input.
const ctx = {
  profile: {
    userId: 'u1',
    roles: ['Learner'],
    skillLevels: [{ skillId: 's1', skillName: 'JavaScript', level: '2', levelName: 'Level 2' }]
  },
  progress: {
    active: 2,
    // note: prepDone and the completed cohort are here; prepTodo is not
    completedIds: ['course:done', 'course:prepDone', 'learningProgram:doneCohort'],
    byCourse: [
      { loId: 'course:mid', title: 'Mid Course', progressPercent: 40, state: 'STARTED', lastAccessDate: '2026-02-01T00:00:00Z' },
      { loId: 'course:done', title: 'Done Course', progressPercent: 100, state: 'COMPLETED', lastAccessDate: '2026-01-01T00:00:00Z' }
    ],
    byLearningProgram: []
  },
  cohorts: [
    { id: 'learningProgram:openSoon', name: 'Open Soon', sessionDate: '2026-02-10T00:00:00Z', startsInDays: 5, requiredAssets: ['course:prepDone', 'course:prepTodo'] },
    { id: 'learningProgram:openLater', name: 'Open Later (self-paced)', sessionDate: null, startsInDays: null, requiredAssets: ['course:x'] },
    { id: 'learningProgram:doneCohort', name: 'Done Cohort', sessionDate: null, startsInDays: null, requiredAssets: ['course:y'] }
  ],
  enrollments: [
    { loId: 'course:mid', title: 'Mid Course', type: 'course', progressPercent: 40, state: 'STARTED', completionDeadline: null },
    { loId: 'course:done', title: 'Done Course', type: 'course', progressPercent: 100, state: 'COMPLETED', completionDeadline: null }
  ],
  achievements: { earned: [], next: null }
}

const lo = (id, name) => ({ id, attributes: { loType: 'course', localizedMetadata: [{ locale: 'en-US', name }] } })
const catalog = {
  bySkill: [lo('course:skillA', 'Advanced JavaScript'), lo('course:done', 'Done Course')], // done one must be excluded
  related: [lo('course:recA', 'Related A'), lo('course:skillA', 'Advanced JavaScript')] // skillA already chosen -> excluded
}

describe('rank (pure)', () => {
  it('continue tier: only STARTED-and-partial courses, closer-to-done ranked higher', () => {
    const { candidates } = rank(ctx, catalog)
    const cont = candidates.filter(c => c.tier === 'continue')
    expect(cont).toEqual([
      { loId: 'course:mid', title: 'Mid Course', type: 'course', tier: 'continue', reason: '40% complete', score: 60 }
    ])
  })

  it('cohort-prep tier: OPEN cohorts as units with an accurate prep rollup; completed cohort excluded', () => {
    const { candidates } = rank(ctx, catalog)
    const prep = candidates.filter(c => c.tier === 'cohort-prep')
    expect(prep.map(c => c.loId)).toEqual(['learningProgram:openSoon', 'learningProgram:openLater'])

    const soon = prep.find(c => c.loId === 'learningProgram:openSoon')
    expect(soon.prep).toEqual({
      total: 2,
      completed: 1, // course:prepDone is in completedIds, course:prepTodo is not
      items: [{ loId: 'course:prepDone', completed: true }, { loId: 'course:prepTodo', completed: false }]
    })
    expect(soon.reason).toBe('cohort — 1 of 2 prep items done')
    // scheduled cohort (startsInDays 5) ranks before the self-paced one (null -> last)
    expect(prep[0].loId).toBe('learningProgram:openSoon')
  })

  it('enriches ALL cohorts (incl. completed) with status + prep, as the detail block', () => {
    const { cohorts } = rank(ctx, catalog)
    expect(cohorts.map(c => [c.id, c.status])).toEqual([
      ['learningProgram:openSoon', 'open'],
      ['learningProgram:openLater', 'open'],
      ['learningProgram:doneCohort', 'completed']
    ])
  })

  it('discovery tiers exclude completed, enrolled, and already-chosen loIds', () => {
    const { candidates } = rank(ctx, catalog)
    const ids = candidates.map(c => c.loId)
    expect(ids).not.toContain('course:done') // completed -> excluded from skill-next
    expect(candidates.filter(c => c.loId === 'course:skillA')).toHaveLength(1) // not duplicated into related
    expect(candidates.find(c => c.loId === 'course:skillA').tier).toBe('skill-next')
    expect(candidates.find(c => c.loId === 'course:recA').tier).toBe('related')
  })

  it('orders tiers continue -> cohort-prep -> skill-next -> related', () => {
    const { candidates } = rank(ctx, catalog)
    const tiers = candidates.map(c => c.tier)
    const order = ['continue', 'cohort-prep', 'skill-next', 'related']
    const idx = tiers.map(t => order.indexOf(t))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('cohort-prep ordering: upcoming soonest first, then self-paced, then past sessions last', () => {
    const sessionsCtx = {
      profile: { skillLevels: [] },
      progress: { completedIds: [], byCourse: [], byLearningProgram: [] },
      enrollments: [],
      cohorts: [
        { id: 'lp:past', name: 'Past', sessionDate: '2026-01-01T00:00:00Z', startsInDays: -10, requiredAssets: [] },
        { id: 'lp:selfPaced', name: 'Self-paced', sessionDate: null, startsInDays: null, requiredAssets: [] },
        { id: 'lp:soon', name: 'Soon', sessionDate: '2026-02-08T00:00:00Z', startsInDays: 3, requiredAssets: [] },
        { id: 'lp:later', name: 'Later', sessionDate: '2026-03-01T00:00:00Z', startsInDays: 20, requiredAssets: [] }
      ]
    }
    const { candidates } = rank(sessionsCtx)
    expect(candidates.map(c => c.loId)).toEqual(['lp:soon', 'lp:later', 'lp:selfPaced', 'lp:past'])
  })

  it('caps each tier (default 5) so one flooded tier cannot crowd others out', () => {
    const manyCohorts = Array.from({ length: 7 }, (_, i) => (
      { id: `lp:${i}`, name: `LP ${i}`, sessionDate: null, startsInDays: i, requiredAssets: [] }
    ))
    const floodCtx = {
      profile: { skillLevels: [] },
      progress: { completedIds: [], byCourse: [], byLearningProgram: [] },
      enrollments: [],
      cohorts: manyCohorts
    }
    const bigCatalog = { bySkill: Array.from({ length: 8 }, (_, i) => lo(`course:skill${i}`, `Skill ${i}`)), recommended: [] }

    const { candidates } = rank(floodCtx, bigCatalog)
    expect(candidates.filter(c => c.tier === 'cohort-prep')).toHaveLength(5)
    expect(candidates.filter(c => c.tier === 'skill-next')).toHaveLength(5)
  })
})

describe('retrieval action', () => {
  beforeEach(() => jest.restoreAllMocks())

  it('degrades to continue + cohort-prep when no ALM creds (catalog fetch throws)', async () => {
    global.fetch = jest.fn()
    const result = await main({ ...ctx }) // no PL_API_BASE -> almClient throws -> caught

    expect(result.statusCode).toBe(200)
    const tiers = new Set(result.body.candidates.map(c => c.tier))
    expect(tiers.has('continue')).toBe(true)
    expect(tiers.has('cohort-prep')).toBe(true)
    expect(tiers.has('skill-next')).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns empty candidates for a degraded context', async () => {
    const result = await main({ contextDegraded: true, profile: { userId: 'u1', roles: [] } })
    expect(result.body).toEqual({ candidates: [], cohorts: [] })
  })

  it('fetches catalog and includes skill-next + related tiers when creds are present', async () => {
    global.fetch = jest.fn((url) => {
      const body = url.includes('filter.skillName') ? { data: catalog.bySkill }
        : url.includes('relatedLOs') ? { data: catalog.related }
          : { data: [] }
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
    })

    const result = await main({ ...ctx, PL_API_BASE: 'https://alm.example.com', PL_API_KEY: 'k' })

    expect(result.statusCode).toBe(200)
    const tiers = new Set(result.body.candidates.map(c => c.tier))
    expect(tiers.has('skill-next')).toBe(true)
    expect(tiers.has('related')).toBe(true)
  })
})
