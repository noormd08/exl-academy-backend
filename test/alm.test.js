const { almClient, almErrorResponse } = require('../actions/shared/alm')
const { fetchLearnerState } = require('../actions/learner-context/api')
const { main: currentLearner } = require('../actions/current-learner')

const user = {
  data: {
    id: 'configured-learner',
    attributes: { name: 'Synthetic Learner', roles: ['Learner'], extra: 'not-returned' },
    relationships: { account: { data: { id: 'account-1', type: 'account' } } }
  },
  included: [{ id: 'account-1', type: 'account', attributes: { name: 'Synthetic Account' } }],
  access_token: 'upstream-field-must-not-be-returned'
}
const ok = body => ({ ok: true, status: 200, json: async () => body })
const originalFetch = global.fetch
const originalToken = process.env.ALM_ACCESS_TOKEN
const originalBase = process.env.ALM_API_BASE_URL

beforeEach(() => {
  process.env.ALM_ACCESS_TOKEN = 'synthetic-server-token'
  process.env.ALM_API_BASE_URL = 'https://alm.example.com/primeapi/v2'
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
  global.fetch = originalFetch
  for (const [key, value] of [['ALM_ACCESS_TOKEN', originalToken], ['ALM_API_BASE_URL', originalBase]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it('validates /user first and scopes every learner-specific path to that identity', async () => {
  const fetchImpl = jest.fn().mockImplementation(async url =>
    ok(url.endsWith('/user') ? user : { data: [] }))
  const raw = await fetchLearnerState({
    fetchImpl, apiKey: 'ignored-client-token', apiBase: 'https://attacker.example', userId: 'other-learner'
  })
  expect(raw.user.data.id).toBe('configured-learner')
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    'https://alm.example.com/primeapi/v2/user',
    expect.stringContaining('/enrollments?'),
    expect.stringContaining('/users/configured-learner/userBadges?'),
    expect.stringContaining('/users/configured-learner/userSkills?')
  ])
  for (const [url, options] of fetchImpl.mock.calls) {
    expect(url).not.toContain('other-learner')
    expect(options).toMatchObject({
      headers: {
        Authorization: 'Bearer synthetic-server-token',
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json'
      },
      redirect: 'error',
      cache: 'no-store'
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
  }
})

it('does not allow caller-selected learner IDs in helper methods', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(ok(user))
  const alm = almClient({ fetchImpl })
  await alm.getUserBadges('other-learner')
  await alm.getUserSkills('other-learner')
  await alm.getRecommendationPreferences('other-learner')
  expect(fetchImpl).toHaveBeenCalledTimes(4)
  expect(fetchImpl.mock.calls.every(([url]) => !url.includes('other-learner'))).toBe(true)
  expect(fetchImpl).toHaveBeenLastCalledWith(
    'https://alm.example.com/primeapi/v2/users/configured-learner/recommendationPreferences',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-server-token' }),
      cache: 'no-store'
    })
  )
})

it('rejects missing server configuration even when caller parameters contain a token', async () => {
  delete process.env.ALM_ACCESS_TOKEN
  global.fetch = jest.fn()
  const result = await currentLearner({ ALM_ACCESS_TOKEN: 'caller-token', userId: 'other-learner' })
  expect(result).toMatchObject({ statusCode: 503, body: { code: 'ALM_NOT_CONFIGURED' } })
  expect(result.body.error).toContain('ALM_ACCESS_TOKEN is missing')
  expect(global.fetch).not.toHaveBeenCalled()
})

it.each([
  ['http://alm.example.com/primeapi/v2'],
  ['https://user:password@alm.example.com/primeapi/v2'],
  ['https://alm.example.com/primeapi/v2?token=unsafe'],
  ['not-a-url']
])('rejects unsafe API base configuration without exposing it (%s)', async base => {
  process.env.ALM_API_BASE_URL = base
  const result = await currentLearner()
  expect(result.statusCode).toBe(503)
  expect(JSON.stringify(result)).not.toContain(base)
})

it.each([
  [401, 'ALM_TOKEN_INVALID', 'replace ALM_ACCESS_TOKEN manually'],
  [403, 'ALM_FORBIDDEN', 'insufficient permissions']
])('reports upstream %s without retries or leaking error bodies', async (status, code, message) => {
  const json = jest.fn().mockResolvedValue({ token: process.env.ALM_ACCESS_TOKEN })
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status, json })
  const result = await currentLearner()
  expect(result).toMatchObject({ statusCode: status, body: { code } })
  expect(result.body.error).toContain(message)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(json).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain(process.env.ALM_ACCESS_TOKEN)
  expect(JSON.stringify(console.error.mock.calls)).not.toContain(process.env.ALM_ACCESS_TOKEN)
})

it('stops learner operations when /user does not return a valid identity', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(ok({ data: {} }))
  await expect(fetchLearnerState({ fetchImpl })).rejects.toMatchObject({ code: 'ALM_INVALID_RESPONSE' })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('returns only the configured identity and account fields', async () => {
  global.fetch = jest.fn().mockResolvedValue(ok(user))
  const result = await currentLearner({ learnerId: 'ignored' })
  expect(result).toEqual({
    statusCode: 200,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: {
      dataScope: 'configured-alm-learner',
      learner: {
        id: 'configured-learner',
        name: 'Synthetic Learner',
        roles: ['Learner'],
        account: { id: 'account-1', name: 'Synthetic Account' }
      }
    }
  })
})

it.each([
  { ...user.data, id: '' },
  { ...user.data, relationships: {} },
  { ...user.data, attributes: { roles: 'Learner' } },
  { ...user.data, attributes: { roles: [null] } }
])('rejects incomplete or malformed learner/account/roles identity (%j)', async data => {
  global.fetch = jest.fn().mockResolvedValue(ok({ data }))
  const result = await currentLearner()
  expect(result.statusCode).toBe(502)
  expect(result.body.code).toBe('ALM_INVALID_RESPONSE')
  expect(result.body).not.toHaveProperty('learner')
})

it.each(['network', 'json', 'upstream'])('sanitizes %s failures', async failure => {
  const sensitive = new Error(`synthetic-server-token should not escape`)
  global.fetch = failure === 'network'
    ? jest.fn().mockRejectedValue(sensitive)
    : jest.fn().mockResolvedValue({
      ok: failure === 'json',
      status: failure === 'json' ? 200 : 500,
      json: async () => { throw sensitive }
    })
  const result = await currentLearner()
  expect(result.statusCode).toBe(502)
  expect(JSON.stringify(result)).not.toContain('synthetic-server-token')
  expect(JSON.stringify(console.error.mock.calls)).not.toContain('synthetic-server-token')
  expect(almErrorResponse(sensitive).body.error).not.toContain('synthetic-server-token')
})

describe('catalog reads', () => {
  const course = id => ({ id, type: 'learningObject', attributes: { loType: 'course' } })
  const stub = pages => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(ok(user))
    for (const page of pages) fetchImpl.mockResolvedValueOnce(ok(page))
    return { fetchImpl, alm: almClient({ fetchImpl }) }
  }

  it('follows next pages, retains catalog filters, merges included resources and deduplicates items', async () => {
    const included = { id: 's1', type: 'skill' }
    const { alm, fetchImpl } = stub([
      { data: [course('course:1')], included: [included], links: { next: '?page[offset]=10' } },
      { data: [course('course:1'), course('course:2')], included: [included] }
    ])
    const result = await alm.getCatalogLearningObjects({ catalogId: '123' })
    expect(result.data.map(item => item.id)).toEqual(['course:1', 'course:2'])
    expect(result.included).toEqual([included])
    expect(result.meta).toEqual({ pagesFetched: 2, complete: true })
    const next = new URL(fetchImpl.mock.calls[2][0])
    expect(next.searchParams.get('filter.catalogIds')).toBe('123')
    expect(next.searchParams.get('filter.loTypes')).toBe('course')
    expect(next.searchParams.get('page[offset]')).toBe('10')
  })

  it.each([
    'https://other.example.com/primeapi/v2/learningObjects?page=2',
    'http://alm.example.com/primeapi/v2/learningObjects?page=2',
    'https://name:password@alm.example.com/primeapi/v2/learningObjects?page=2',
    '/primeapi/v2/user',
    '?page=2#fragment',
    '?page=2&filter.catalogIds=another-catalog'
  ])('rejects unsafe pagination before forwarding credentials (%s)', async next => {
    const { alm, fetchImpl } = stub([{ data: [], links: { next } }])
    await expect(alm.getCatalogLearningObjects({ catalogId: '123' })).rejects.toMatchObject({ code: 'ALM_INVALID_RESPONSE' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('detects pagination cycles rather than reporting complete data', async () => {
    const { alm } = stub([
      { data: [], links: { next: '?page[offset]=10' } },
      { data: [], links: { next: '?page[offset]=10' } }
    ])
    await expect(alm.getCatalogLearningObjects({ maxPages: 3 })).rejects.toThrow('pagination cycle')
  })

  it('labels capped course samples incomplete and makes no extra requests', async () => {
    const { alm, fetchImpl } = stub([{ data: [course('course:1')], links: { next: '?page=2' } }])
    const result = await alm.getCatalogLearningObjects({ maxPages: 1 })
    expect(result.meta).toEqual({ pagesFetched: 1, complete: false })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('enumerates catalogs until there is no next page', async () => {
    const { alm } = stub([
      { data: [{ id: '1', type: 'catalog' }], links: { next: '?page[offset]=10' } },
      { data: [{ id: '2', type: 'catalog' }] }
    ])
    const result = await alm.getCatalogs()
    expect(result.data.map(item => item.id)).toEqual(['1', '2'])
    expect(result.meta).toEqual({ pagesFetched: 2, complete: true })
  })

  it('rejects malformed collections instead of returning empty success', async () => {
    const { alm } = stub([{ data: {} }])
    await expect(alm.getCatalogs()).rejects.toMatchObject({ code: 'ALM_INVALID_RESPONSE' })
  })

  it('reports rate limiting without retrying', async () => {
    const { alm, fetchImpl } = stub([])
    fetchImpl.mockResolvedValue({ ok: false, status: 429 })
    await expect(alm.getCatalogs()).rejects.toMatchObject({ code: 'ALM_RATE_LIMITED', statusCode: 429 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('validates detail IDs and rejects a different returned object', async () => {
    const { alm, fetchImpl } = stub([{ data: course('course:2') }])
    await expect(alm.getLearningObject('course:1')).rejects.toMatchObject({ code: 'ALM_INVALID_RESPONSE' })
    expect(fetchImpl.mock.calls[1][0]).toContain('/learningObjects/course%3A1?')
    await expect(alm.getLearningObject('https://other.example.com')).rejects.toMatchObject({ code: 'ALM_INVALID_REQUEST' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
