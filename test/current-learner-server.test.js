const http = require('node:http')
const { createLocalDemoServer } = require('../scripts/local-demo-server')

let server
const originalFetch = global.fetch
const originalToken = process.env.ALM_ACCESS_TOKEN
const originalBase = process.env.ALM_API_BASE_URL

function request (path = '/api/current-learner', headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, headers, method
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({
        statusCode: response.statusCode, headers: response.headers, body: JSON.parse(body)
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  process.env.ALM_ACCESS_TOKEN = 'synthetic-server-token'
  process.env.ALM_API_BASE_URL = 'https://alm.example.com/primeapi/v2'
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        id: 'token-owner',
        attributes: { roles: ['Learner'] },
        relationships: { account: { data: { id: 'account-1' } } }
      }
    })
  })
  jest.spyOn(console, 'error').mockImplementation(() => {})
  server = createLocalDemoServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
})

afterEach(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  global.fetch = originalFetch
  jest.restoreAllMocks()
  for (const [key, value] of [['ALM_ACCESS_TOKEN', originalToken], ['ALM_API_BASE_URL', originalBase]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it('serves a responsive loopback endpoint and ignores client identity and credentials', async () => {
  const result = await request('/api/current-learner?learnerId=attacker&ALM_ACCESS_TOKEN=client-token')
  expect(result.statusCode).toBe(200)
  expect(result.body.learner.id).toBe('token-owner')
  expect(result.body.learner.account.id).toBe('account-1')
  expect(result.body.learner.roles).toEqual(['Learner'])
  expect(result.headers['cache-control']).toBe('private, no-store')
  expect(global.fetch).toHaveBeenCalledWith(
    'https://alm.example.com/primeapi/v2/user',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic-server-token' }) })
  )
  expect(JSON.stringify(result)).not.toContain('synthetic-server-token')
})

it.each([
  [{ Host: 'attacker.example' }, 'GET'],
  [{ Origin: 'https://attacker.example' }, 'GET'],
  [{}, 'POST']
])('rejects disallowed hosts, origins or methods before ALM (%j %s)', async (headers, method) => {
  const result = await request('/api/current-learner', headers, method)
  expect([403, 405]).toContain(result.statusCode)
  expect(global.fetch).not.toHaveBeenCalled()
})

it('reports a missing token clearly without calling ALM', async () => {
  delete process.env.ALM_ACCESS_TOKEN
  const result = await request()
  expect(result.statusCode).toBe(503)
  expect(result.body.code).toBe('ALM_NOT_CONFIGURED')
  expect(global.fetch).not.toHaveBeenCalled()
})

it.each([
  [401, 'ALM_TOKEN_INVALID'],
  [403, 'ALM_FORBIDDEN']
])('preserves ALM %s as an explicit HTTP error', async (status, code) => {
  global.fetch.mockResolvedValue({ ok: false, status })
  const result = await request()
  expect(result.statusCode).toBe(status)
  expect(result.body.code).toBe(code)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(result.headers['cache-control']).toBe('private, no-store')
})
