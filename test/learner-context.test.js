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

const { main } = require('../actions/learner-context')
const { normalizeLearnerContext, degradedContext } = require('../actions/learner-context/normalize')

// Small literal ALM-shaped fixtures for testing the pure transform logic in normalize.js. This is
// synthetic test input, not a real capture and not a persona — learner-context always calls the real
// ALM API now (no mock mode), so there's nothing here meant to represent an actual learner.
const literalUser = {
  data: { id: 'u1', attributes: { roles: ['Learner', 'Author'] } }
}

const literalEnrollments = {
  data: [
    {
      relationships: {
        learningObject: { data: { id: 'course:111', type: 'learningObject' } },
        loInstance: { data: { id: 'course:111_i1', type: 'learningObjectInstance' } }
      },
      attributes: { progressPercent: 100, state: 'COMPLETED', dateStarted: '2026-01-01T00:00:00Z' }
    },
    {
      relationships: {
        learningObject: { data: { id: 'learningProgram:222', type: 'learningObject' } },
        loInstance: { data: { id: 'learningProgram:222_i1', type: 'learningObjectInstance' } }
      },
      attributes: { progressPercent: 40, state: 'STARTED', dateStarted: '2026-02-01T00:00:00Z', completionDeadline: '2026-03-01T00:00:00Z' }
    },
    {
      // A second enrolled learningProgram, with no matching learningObjects instance data — exercises
      // a learner enrolled in more than one cohort at once, and sessionDate staying null when the
      // instance-date call hasn't resolved it.
      relationships: {
        learningObject: { data: { id: 'learningProgram:444', type: 'learningObject' } },
        loInstance: { data: { id: 'learningProgram:444_i1', type: 'learningObjectInstance' } }
      },
      attributes: { progressPercent: 100, state: 'COMPLETED', dateStarted: '2026-01-15T00:00:00Z' }
    }
  ],
  included: [
    { id: 'course:111', type: 'learningObject', attributes: { loType: 'course', localizedMetadata: [{ locale: 'en-US', name: 'Course 111' }] } },
    {
      id: 'learningProgram:222',
      type: 'learningObject',
      attributes: {
        loType: 'learningProgram',
        localizedMetadata: [{ locale: 'en-US', name: 'Cohort 222' }],
        sections: [{ mandatory: true, loIds: ['course:333'] }]
      }
    },
    {
      id: 'learningProgram:444',
      type: 'learningObject',
      attributes: {
        loType: 'learningProgram',
        localizedMetadata: [{ locale: 'en-US', name: 'Cohort 444' }],
        sections: []
      }
    },
    // loInstance now arrives inline in the enrollments response (include=loInstance). Cohort 222's
    // instance is scheduled (has a startDate); Cohort 444's instance has none (self-paced).
    { id: 'learningProgram:222_i1', type: 'learningObjectInstance', attributes: { startDate: '2026-02-10T00:00:00Z' } },
    { id: 'learningProgram:444_i1', type: 'learningObjectInstance', attributes: {} }
  ]
}

// userBadges now feed only achievements.earned (skills come from userSkills, below).
const literalBadges = {
  data: [
    { relationships: { badge: { data: { id: 'b1', type: 'badge' } } } },
    { relationships: { badge: { data: { id: 'b2', type: 'badge' } } } },
    { relationships: { badge: { data: { id: 'b3', type: 'badge' } } } }
  ],
  included: [
    { id: 'b1', type: 'badge', attributes: { name: 'ROCKSTAR' } },
    { id: 'b2', type: 'badge', attributes: { name: 'NINJA' } },
    { id: 'b3', type: 'badge', attributes: { name: 'GURU' } }
  ]
}

// GET /users/{id}/userSkills?include=skill,skillLevel — the authoritative skills source. s1 has two
// levels earned (dedup should keep Level 2); s2 has one.
const literalUserSkills = {
  data: [
    { attributes: { pointsEarned: 100 }, relationships: { skill: { data: { id: 's1' } }, skillLevel: { data: { id: 's1_1' } } } },
    { attributes: { pointsEarned: 250 }, relationships: { skill: { data: { id: 's1' } }, skillLevel: { data: { id: 's1_2' } } } },
    { attributes: { pointsEarned: 40 }, relationships: { skill: { data: { id: 's2' } }, skillLevel: { data: { id: 's2_1' } } } }
  ],
  included: [
    { id: 's1', type: 'skill', attributes: { name: 'JavaScript' } },
    { id: 's2', type: 'skill', attributes: { name: 'Python' } },
    { id: 's1_1', type: 'skillLevel', attributes: { level: '1', name: 'Level 1' } },
    { id: 's1_2', type: 'skillLevel', attributes: { level: '2', name: 'Level 2' } },
    { id: 's2_1', type: 'skillLevel', attributes: { level: '1', name: 'Level 1' } }
  ]
}

const literalBundle = {
  user: literalUser,
  enrollments: literalEnrollments,
  badges: literalBadges,
  userSkills: literalUserSkills
}

function paramsFor (userId, overrides = {}) {
  return {
    __ow_headers: { authorization: `Bearer token-for-${userId}` },
    ...overrides
  }
}

// Routes checked in order — put more specific substrings (e.g. "userBadges") before shorter ones
// they'd otherwise also match (e.g. "/user").
function mockFetchRouter (routes) {
  return jest.fn((url) => {
    const match = routes.find(([pattern]) => url.includes(pattern))
    if (!match) throw new Error(`Unexpected fetch: ${url}`)
    return Promise.resolve({ ok: true, status: 200, json: async () => match[1] })
  })
}

describe('normalizeLearnerContext (pure transform)', () => {
  const now = new Date('2026-02-05T00:00:00Z').getTime()

  it('has no goal field and carries the real learner id', () => {
    const result = normalizeLearnerContext(literalBundle, { now })

    expect(result).not.toHaveProperty('goal')
    expect(result.profile.userId).toBe('u1')
  })

  it('progress.active/completedIds span both courses and learningPrograms', () => {
    const result = normalizeLearnerContext(literalBundle, { now })

    // course:111 COMPLETED, learningProgram:222 STARTED, learningProgram:444 COMPLETED
    expect(result.progress.active).toBe(1)
    expect(result.progress.completedIds).toEqual(['course:111', 'learningProgram:444'])
  })

  it('splits progress into byCourse and byLearningProgram', () => {
    const result = normalizeLearnerContext(literalBundle, { now })

    expect(result.progress.byCourse).toEqual([
      { loId: 'course:111', title: 'Course 111', progressPercent: 100, state: 'COMPLETED', lastAccessDate: '2026-01-01T00:00:00Z' }
    ])
    expect(result.progress.byLearningProgram).toEqual([
      { loId: 'learningProgram:222', title: 'Cohort 222', progressPercent: 40, state: 'STARTED', lastAccessDate: '2026-02-01T00:00:00Z' },
      { loId: 'learningProgram:444', title: 'Cohort 444', progressPercent: 100, state: 'COMPLETED', lastAccessDate: '2026-01-15T00:00:00Z' }
    ])
  })

  it('the flat enrollments array stays course-only (learningPrograms live in cohorts instead)', () => {
    const result = normalizeLearnerContext(literalBundle, { now })

    expect(result.enrollments).toEqual([
      { loId: 'course:111', title: 'Course 111', type: 'course', progressPercent: 100, state: 'COMPLETED', completionDeadline: null }
    ])
  })

  it('treats every enrolled learningProgram as a cohort (a learner can have more than one)', () => {
    const result = normalizeLearnerContext(literalBundle, { now })

    expect(result.cohorts).toEqual([
      {
        id: 'learningProgram:222',
        name: 'Cohort 222',
        sessionDate: '2026-02-10T00:00:00Z',
        startsInDays: 5,
        requiredAssets: ['course:333']
      },
      {
        id: 'learningProgram:444',
        name: 'Cohort 444',
        sessionDate: null,
        startsInDays: null,
        requiredAssets: []
      }
    ])
  })

  it('maps earned badges to their real badge names, and never fills achievements.next', () => {
    const result = normalizeLearnerContext(literalBundle, { now })

    expect(result.achievements).toEqual({ earned: ['ROCKSTAR', 'NINJA', 'GURU'], next: null })
  })

  it('carries roles, and skills from userSkills (highest level per skill, with pointsEarned)', () => {
    const result = normalizeLearnerContext(literalBundle, { now })

    expect(result.profile.roles).toEqual(['Learner', 'Author'])
    // s1 earned Level 1 then Level 2 — only Level 2 survives; s2 has one level.
    expect(result.profile.skillLevels).toEqual([
      { skillId: 's1', skillName: 'JavaScript', level: '2', levelName: 'Level 2', pointsEarned: 250 },
      { skillId: 's2', skillName: 'Python', level: '1', levelName: 'Level 1', pointsEarned: 40 }
    ])
  })

  it('degradedContext returns the minimal shape with contextDegraded:true', () => {
    expect(degradedContext('u1')).toEqual({
      profile: { userId: 'u1', roles: [], skillLevels: [] },
      progress: null,
      cohorts: [],
      enrollments: [],
      achievements: null,
      contextDegraded: true
    })
  })
})

describe('learner-context action (auth + real ALM call + degrade paths)', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('returns 401 when the Authorization header is missing', async () => {
    global.fetch = jest.fn()

    const result = await main({ __ow_headers: {} })

    expect(result.statusCode).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns 401 when the IMS token is invalid', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 })

    const result = await main(paramsFor('learner-1'))

    expect(result.statusCode).toBe(401)
  })

  it('returns 502 when IMS is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'))

    const result = await main(paramsFor('learner-1'))

    expect(result.statusCode).toBe(502)
  })

  it('returns a degraded context (not a throw) when PL_API_BASE is not configured', async () => {
    global.fetch = mockFetchRouter([['ims-na1.adobelogin.com', { userId: 'learner-1' }]])

    const result = await main(paramsFor('learner-1', { PL_API_BASE: '' }))

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual(degradedContext('learner-1'))
  })

  it('returns the normalized context end-to-end against a routed real-shaped ALM call', async () => {
    global.fetch = mockFetchRouter([
      ['ims-na1.adobelogin.com', { userId: 'ims-user-1' }],
      ['userBadges', literalBadges],   // check /users/{id}/userBadges and /userSkills before the
      ['userSkills', literalUserSkills], // general '/user' route (a substring of '/users/...')
      ['/enrollments', literalEnrollments],
      ['/user', literalUser]
    ])

    const result = await main(paramsFor('ims-user-1', { PL_API_BASE: 'https://alm.example.com', PL_API_KEY: 'k' }))

    expect(result.statusCode).toBe(200)
    // GET /user is what actually drives the ALM identity (see api.js) — not the IMS userId.
    expect(result.body.profile.userId).toBe('u1')
    expect(result.body.cohorts.map(c => c.id)).toEqual(['learningProgram:222', 'learningProgram:444'])
    expect(result.body.profile.skillLevels).toEqual([
      { skillId: 's1', skillName: 'JavaScript', level: '2', levelName: 'Level 2', pointsEarned: 250 },
      { skillId: 's2', skillName: 'Python', level: '1', levelName: 'Level 1', pointsEarned: 40 }
    ])
  })
})
