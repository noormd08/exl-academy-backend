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

const { main } = require('../actions/compose-plan')

// Routes checked in order; put more specific substrings before general ones ('/user' matches '/users/...').
function mockFetchRouter (routes) {
  return jest.fn((url) => {
    const match = routes.find(([pattern]) => url.includes(pattern))
    if (!match) throw new Error(`Unexpected fetch: ${url}`)
    const [, body, status = 200] = match
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
  })
}

const HAPPY_ROUTES = [
  ['ims-na1.adobelogin.com', { userId: 'ims-u' }],
  ['userBadges', { data: [], included: [] }],
  ['userSkills', { data: [], included: [] }],
  ['/enrollments', {
    data: [{ relationships: { learningObject: { data: { id: 'course:1', type: 'learningObject' } } }, attributes: { progressPercent: 40, state: 'STARTED', dateStarted: '2026-01-01' } }],
    included: [{ id: 'course:1', type: 'learningObject', attributes: { loType: 'course', localizedMetadata: [{ locale: 'en-US', name: 'JS' }] } }]
  }],
  ['relatedLOs', { data: [] }],
  ['filter.skillName', { data: [] }],
  ['/user', { data: { id: 'alm-u', attributes: { roles: ['Learner'] } } }]
]

const params = (overrides = {}) => ({
  __ow_headers: { authorization: 'Bearer t' },
  PL_API_BASE: 'https://alm.example.com',
  PL_API_KEY: 'k',
  ...overrides
})

describe('compose-plan endpoint', () => {
  beforeEach(() => jest.restoreAllMocks())

  it('returns { meta, layout } only — no blocksData', async () => {
    global.fetch = mockFetchRouter(HAPPY_ROUTES)

    const result = await main(params())

    expect(result.statusCode).toBe(200)
    expect(Object.keys(result.body)).toEqual(['meta', 'layout'])
    expect(result.body).not.toHaveProperty('blocksData')
    expect(result.body.meta.mode).toBe('continue') // one STARTED course
    const todaysPlan = result.body.layout.blocks.find(b => b.id === 'pl-todays-plan')
    expect(todaysPlan).toMatchObject({ show: true, order: 1, emphasis: true })
    // every block is a decision, not content
    for (const b of result.body.layout.blocks) expect(b).not.toHaveProperty('items')
  })

  it('CORS preflight returns 204 with CORS headers', async () => {
    const result = await main({ __ow_method: 'OPTIONS' })
    expect(result.statusCode).toBe(204)
    expect(result.headers['Access-Control-Allow-Origin']).toBeDefined()
  })

  it('missing token -> 401 (no data fetched)', async () => {
    global.fetch = jest.fn()
    const result = await main({ __ow_headers: {} })
    expect(result.statusCode).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('pipeline failure after auth -> 200 safe default (pl-todays-plan shown, others hidden, no blocksData)', async () => {
    global.fetch = mockFetchRouter([
      ['ims-na1.adobelogin.com', { userId: 'ims-u' }],
      ['/user', {}, 500] // ALM /user fails -> fetchLearnerState throws -> safe default
    ])

    const result = await main(params())

    expect(result.statusCode).toBe(200)
    expect(result.body).not.toHaveProperty('blocksData')
    expect(result.body.meta.mode).toBe('learn')
    const byId = Object.fromEntries(result.body.layout.blocks.map(b => [b.id, b]))
    expect(byId['pl-todays-plan']).toMatchObject({ show: true, order: 1 })
    expect(byId['pl-cohort-readiness'].show).toBe(false)
  })
})
