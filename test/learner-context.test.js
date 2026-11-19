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
const { fetchEnrollmentPages } = require('../actions/shared/alm')

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
      { loId: 'course:111', title: 'Course 111', progressPercent: 100, state: 'COMPLETED', lastAccessDate: '2026-01-01T00:00:00Z', dueDate: null }
    ])
    expect(result.progress.byLearningProgram).toEqual([
      { loId: 'learningProgram:222', title: 'Cohort 222', progressPercent: 40, state: 'STARTED', lastAccessDate: '2026-02-01T00:00:00Z', dueDate: '2026-03-01T00:00:00Z' },
      { loId: 'learningProgram:444', title: 'Cohort 444', progressPercent: 100, state: 'COMPLETED', lastAccessDate: '2026-01-15T00:00:00Z', dueDate: null }
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

  it.each([
    ['2026-02-04T23:59:00Z', -1],
    ['2026-02-05T00:01:00Z', 1],
    ['invalid-date', null]
  ])('does not treat a past or invalid session as upcoming (%s)', (date, expectedDays) => {
    const enrollments = {
      ...literalEnrollments,
      included: literalEnrollments.included.map(item => item.id === 'learningProgram:222_i1'
        ? { ...item, attributes: { startDate: date } }
        : item)
    }
    const result = normalizeLearnerContext({ ...literalBundle, enrollments }, { now })
    expect(result.cohorts[0].startsInDays).toBe(expectedDays)
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

  describe('enrollment pagination', () => {
    const apiBase = 'https://alm.example.com/primeapi/v2'

    it('includes completion and learning-object relationships from later pages', async () => {
      const get = jest.fn()
        .mockResolvedValueOnce({
          data: [literalEnrollments.data[1]],
          included: [literalEnrollments.included[1], literalEnrollments.included[3]],
          links: { next: `${apiBase}/enrollments?page[cursor]=next` }
        })
        .mockResolvedValueOnce({
          data: [literalEnrollments.data[0]],
          included: [literalEnrollments.included[0]]
        })
      const enrollments = await fetchEnrollmentPages(apiBase, get)
      const context = normalizeLearnerContext({ ...literalBundle, enrollments })
      expect(context.progress.completedIds).toEqual(['course:111'])
      expect(context.cohorts).toHaveLength(1)
      expect(get).toHaveBeenCalledTimes(2)
    })

    it.each([
      'https://other.example.com/primeapi/v2/enrollments?page=2',
      '/primeapi/v2/user',
      'https://user:password@alm.example.com/primeapi/v2/enrollments?page=2'
    ])('rejects pagination outside the approved enrollment endpoint', async (next) => {
      const get = jest.fn().mockResolvedValue({ data: [], links: { next } })
      await expect(fetchEnrollmentPages(apiBase, get))
        .rejects.toThrow('pagination URL is not allowed')
      expect(get).toHaveBeenCalledTimes(1)
    })

    it('rejects cycles and failed later pages rather than silently returning partial learner data', async () => {
      const get = jest.fn().mockResolvedValue({ data: [], links: { next: '?page=2' } })
      await expect(fetchEnrollmentPages(apiBase, get)).rejects.toThrow('pagination cycle')
      expect(get).toHaveBeenCalledTimes(2)

      const failingGet = jest.fn()
        .mockResolvedValueOnce({ data: [], links: { next: '?page=2' } })
        .mockRejectedValueOnce(new Error('ALM /enrollments returned 503'))
      await expect(fetchEnrollmentPages(apiBase, failingGet)).rejects.toThrow('returned 503')
    })
  })

  it('degradedContext returns the minimal shape with contextDegraded:true', () => {
    expect(degradedContext()).toEqual({
      profile: { userId: null, roles: [], skillLevels: [] },
      progress: null,
      cohorts: [],
      enrollments: [],
      achievements: null,
      contextDegraded: true
    })
  })
})

describe('internal learner-context action (configured ALM account + degrade paths)', () => {
  const originalToken = process.env.ALM_ACCESS_TOKEN
  beforeEach(() => {
    jest.restoreAllMocks()
    delete process.env.ALM_ACCESS_TOKEN
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.ALM_ACCESS_TOKEN
    else process.env.ALM_ACCESS_TOKEN = originalToken
  })

  it('returns an explicit configuration error when the ALM credential is unavailable', async () => {
    global.fetch = jest.fn()
    const result = await main({})

    expect(result.statusCode).toBe(503)
    expect(result.body.code).toBe('ALM_NOT_CONFIGURED')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('normalizes the configured account data without reading caller identity', async () => {
    global.fetch = jest.fn()
    const loadLearnerState = jest.fn().mockResolvedValue(literalBundle)
    const result = await main({}, loadLearnerState)

    expect(result.statusCode).toBe(200)
    expect(result.body.profile.userId).toBe('u1')
    expect(result.body.cohorts.map(cohort => cohort.id)).toEqual([
      'learningProgram:222', 'learningProgram:444'
    ])
    expect(loadLearnerState).toHaveBeenCalledWith()
  })

  it('degrades safely when ALM fails without exposing upstream error details', async () => {
    global.fetch = jest.fn()
    const loadLearnerState = jest.fn().mockRejectedValue(new Error('synthetic upstream failure'))
    const result = await main({}, loadLearnerState)
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual(degradedContext())
    expect(global.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/upstream failure/)
  })
})
