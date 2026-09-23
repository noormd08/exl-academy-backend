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

const { resolveLayout } = require('../actions/compose-plan/resolve-layout')

const blockById = (result, id) => result.layout.blocks.find(b => b.id === id)

describe('resolveLayout — decisions only (no block content)', () => {
  it('never emits blocksData or any per-block content', () => {
    const context = {
      profile: { userId: 'a' },
      progress: { byCourse: [{ loId: 'course:1', title: 'JS', progressPercent: 40, state: 'STARTED' }], byLearningProgram: [] },
      cohorts: []
    }
    const retrieval = { candidates: [{ tier: 'continue', loId: 'course:1', title: 'JS' }], cohorts: [] }

    const result = resolveLayout(context, retrieval)

    expect(result).not.toHaveProperty('blocksData')
    expect(Object.keys(result)).toEqual(['meta', 'layout'])
    // layout blocks carry decisions only — no items/prep/etc.
    for (const b of result.layout.blocks) {
      expect(Object.keys(b).sort()).toEqual(expect.arrayContaining(['emphasis', 'id', 'order', 'show']))
      expect(b).not.toHaveProperty('items')
      expect(b).not.toHaveProperty('prep')
    }
  })

  it('continue: in-progress course -> todays-plan first (emphasis) with a reason; cohort-readiness hidden', () => {
    const context = {
      profile: { userId: 'a' },
      progress: { byCourse: [{ loId: 'course:1', title: 'JS Basics', progressPercent: 40, state: 'STARTED' }], byLearningProgram: [] },
      cohorts: []
    }
    const retrieval = { candidates: [{ tier: 'continue', loId: 'course:1', title: 'JS Basics' }], cohorts: [] }

    const result = resolveLayout(context, retrieval)

    expect(result.meta).toEqual({ mode: 'continue', aiUsed: false })
    expect(blockById(result, 'pl-todays-plan')).toEqual({
      id: 'pl-todays-plan', show: true, order: 1, emphasis: true, reason: { code: 'CONTINUE_IN_PROGRESS' }
    })
    expect(blockById(result, 'pl-cohort-readiness')).toEqual({ id: 'pl-cohort-readiness', show: false, order: 0, emphasis: false })
  })

  it('prepare: upcoming incomplete cohort -> cohort-readiness first + emphasis + COHORT_PREP reason with counts', () => {
    const context = {
      profile: { userId: 'b' },
      progress: { byCourse: [], byLearningProgram: [{ loId: 'lp:1', title: 'AEP Cohort', progressPercent: 0, state: 'ENROLLED' }] },
      cohorts: [{ id: 'lp:1', name: 'AEP Cohort', sessionDate: '2026-12-01T00:00:00Z', startsInDays: 10, requiredAssets: ['course:a', 'course:b', 'course:c'] }]
    }
    const retrieval = {
      candidates: [{ tier: 'cohort-prep', loId: 'lp:1', title: 'AEP Cohort' }],
      cohorts: [{ id: 'lp:1', status: 'open', prep: { total: 3, completed: 1, items: [] } }]
    }

    const result = resolveLayout(context, retrieval)

    expect(result.meta.mode).toBe('prepare')
    expect(blockById(result, 'pl-cohort-readiness')).toEqual({
      id: 'pl-cohort-readiness', show: true, order: 1, emphasis: true, reason: { code: 'COHORT_PREP', params: { done: 1, total: 3 } }
    })
    expect(blockById(result, 'pl-todays-plan').show).toBe(false) // no in-progress/continue
  })

  it('past-only cohorts: cohort-readiness hidden (session already happened), mode continue', () => {
    const context = {
      profile: { userId: 'c' },
      progress: { byCourse: [{ loId: 'course:x', title: 'X', progressPercent: 50, state: 'STARTED' }], byLearningProgram: [] },
      cohorts: [{ id: 'lp:past', name: 'Past', sessionDate: '2026-01-01T00:00:00Z', startsInDays: -30, requiredAssets: ['course:p'] }]
    }
    const retrieval = {
      candidates: [{ tier: 'continue', loId: 'course:x', title: 'X' }],
      cohorts: [{ id: 'lp:past', status: 'open', prep: { total: 1, completed: 0, items: [] } }]
    }

    const result = resolveLayout(context, retrieval)

    expect(result.meta.mode).toBe('continue')
    expect(blockById(result, 'pl-cohort-readiness').show).toBe(false)
    expect(blockById(result, 'pl-todays-plan').show).toBe(true)
  })

  it('empty / degraded context: learn mode, nothing forced on, no blocksData', () => {
    const result = resolveLayout({ profile: {}, progress: null, cohorts: [], contextDegraded: true }, { candidates: [], cohorts: [] })

    expect(result.meta).toEqual({ mode: 'learn', aiUsed: false })
    expect(result).not.toHaveProperty('blocksData')
    for (const b of result.layout.blocks) expect(b.show).toBe(false)
  })

  it('my-priorities: shown with a reason when any candidates/in-progress exist; hidden otherwise', () => {
    const withData = resolveLayout(
      { profile: {}, progress: { byCourse: [], byLearningProgram: [] }, cohorts: [] },
      { candidates: [{ tier: 'skill-next', loId: 'course:s1', title: 'S1', type: 'course' }], cohorts: [] }
    )
    expect(blockById(withData, 'pl-my-priorities')).toMatchObject({ show: true, reason: { code: 'PERSONALIZED_PRIORITIES' } })

    const empty = resolveLayout({ profile: {}, progress: { byCourse: [], byLearningProgram: [] }, cohorts: [] }, { candidates: [], cohorts: [] })
    expect(blockById(empty, 'pl-my-priorities').show).toBe(false)
  })

  it('recommended: learn mode makes it prominent (order 1, emphasis) with BASED_ON_YOUR_SKILLS reason', () => {
    const context = { profile: {}, progress: { byCourse: [], byLearningProgram: [] }, cohorts: [] }
    const retrieval = { candidates: [{ tier: 'skill-next', loId: 'course:s1', title: 'S1', type: 'course' }], cohorts: [] }

    const result = resolveLayout(context, retrieval)

    expect(result.meta.mode).toBe('learn')
    expect(blockById(result, 'pl-recommended')).toEqual({
      id: 'pl-recommended', show: true, order: 1, emphasis: true, reason: { code: 'BASED_ON_YOUR_SKILLS' }
    })
    expect(blockById(result, 'pl-cohort-readiness').show).toBe(false)
  })

  it('real account 30851403 shape: in-progress programs -> continue; past/self-paced cohorts -> readiness hidden', () => {
    const context = {
      profile: { userId: '30851403', roles: ['Learner', 'Admin', 'Author', 'Instructor'] },
      progress: {
        byCourse: [
          { loId: 'course:17010513', title: 'Test_Module_Sud_1', progressPercent: 100, state: 'COMPLETED' },
          { loId: 'course:17010514', title: 'Test_Module_Sud_2', progressPercent: 100, state: 'COMPLETED' }
        ],
        byLearningProgram: [
          { loId: 'learningProgram:168995', title: 'Flexible LP', progressPercent: 67, state: 'STARTED' },
          { loId: 'learningProgram:169705', title: 'Copy of Copy of Flexible LP - TEST11', progressPercent: 22, state: 'STARTED' },
          { loId: 'learningProgram:170072', title: 'LP_SUD', progressPercent: 50, state: 'STARTED' },
          { loId: 'learningProgram:171635', title: 'Cohort for LP1', progressPercent: 0, state: 'ENROLLED' }
        ]
      },
      cohorts: [
        { id: 'learningProgram:171635', name: 'Cohort for LP1', sessionDate: '2026-09-01T14:59:59Z', startsInDays: -8, requiredAssets: ['course:a', 'course:b'] },
        { id: 'learningProgram:169570', name: 'benefitIO', sessionDate: '2026-07-08T18:29:59Z', startsInDays: -63, requiredAssets: ['course:c'] },
        { id: 'learningProgram:168995', name: 'Flexible LP', sessionDate: null, startsInDays: null, requiredAssets: ['course:d'] }
      ]
    }
    const retrieval = {
      candidates: [{ tier: 'cohort-prep', loId: 'learningProgram:168995', title: 'Flexible LP' }],
      cohorts: context.cohorts.map(c => ({ ...c, status: 'open', prep: { total: c.requiredAssets.length, completed: 0, items: [] } }))
    }

    const result = resolveLayout(context, retrieval)

    expect(result.meta.mode).toBe('continue')
    expect(blockById(result, 'pl-todays-plan')).toEqual({
      id: 'pl-todays-plan', show: true, order: 1, emphasis: true, reason: { code: 'CONTINUE_IN_PROGRESS' }
    })
    expect(blockById(result, 'pl-cohort-readiness').show).toBe(false)
    expect(result).not.toHaveProperty('blocksData')
  })
})
