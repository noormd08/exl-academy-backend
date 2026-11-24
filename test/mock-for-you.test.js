const { createServer, generatePage } = require('../scripts/mock-for-you')
const http = require('node:http')
const { Readable } = require('node:stream')

const response = (page) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(page) }] } }] })
})

const page = {
  title: 'For you',
  introduction: 'Explore your interests.',
  sections: [{ heading: 'Continue learning', description: 'Pick up where you left off.', courseIds: ['aem-components'] }],
  suggestions: [{ label: 'Explore AEM', query: 'What can I learn about AEM?' }]
}

test('sends synthetic context to Gemini and returns catalog-backed courses', async () => {
  const fetch = jest.fn(async () => response(page))
  const result = await generatePage('experienced', 'Explore AEM', { apiKey: 'test-key', fetch })
  expect(result.sections[0].courses[0]).toMatchObject({ id: 'aem-components', progressPercent: 40 })
  const [url, options] = fetch.mock.calls[0]
  expect(url).toContain('/models/gemini-3.5-flash-lite:generateContent')
  expect(options.headers['x-goog-api-key']).toBe('test-key')
  const prompt = JSON.parse(options.body)
  const context = JSON.parse(prompt.contents[0].parts[0].text)
  expect(context.query).toBe('Explore AEM')
  expect(context.courses.map(course => course.id)).not.toContain('aem-basics')
})

test.each([
  ['unknown', ['invented-course']],
  ['completed', ['aem-basics']],
  ['duplicate', ['aem-components', 'aem-components']]
])('rejects %s course selections', async (_label, courseIds) => {
  const fetch = async () => response({ ...page, sections: [{ ...page.sections[0], courseIds }] })
  await expect(generatePage('experienced', '', { apiKey: 'test-key', fetch })).rejects.toThrow('invalid or duplicate course')
})

test('rejects malformed follow-up suggestions', async () => {
  const fetch = async () => response({ ...page, suggestions: [{ label: 'Explore' }] })
  await expect(generatePage('experienced', '', { apiKey: 'key', fetch })).rejects.toThrow('invalid suggestions')
})

test('configuration and provider errors are explicit, without a fallback', async () => {
  const fetch = jest.fn()
  await expect(generatePage('new-learner', '', { apiKey: '', fetch })).rejects.toThrow('GEMINI_API_KEY')
  expect(fetch).not.toHaveBeenCalled()
  await expect(generatePage('new-learner', '', { apiKey: 'key', fetch: async () => ({ ok: false, status: 429 }) })).rejects.toThrow('rate limit')
  await expect(generatePage('bad-persona', '', { apiKey: 'key', fetch })).rejects.toThrow('valid demo persona')
})

test.each([
  [400, 'API_KEY_INVALID', /rejected the API key/],
  [403, 'SERVICE_DISABLED', /not enabled/],
  [403, 'API_KEY_SERVICE_BLOCKED', /key restrictions/],
  [404, '', /model not found/],
  [400, '', /HTTP 400/]
])('reports safe Gemini error details for HTTP %i', async (status, reason, expected) => {
  const fetch = async () => ({
    ok: false,
    status,
    json: async () => ({ error: { message: 'private upstream detail', details: [{ reason }] } })
  })
  await expect(generatePage('new-learner', '', { apiKey: 'key', fetch })).rejects.toThrow(expected)
})

test('HTTP handler exposes mock personas and rejects untrusted origins', async () => {
  let handler
  const create = jest.spyOn(http, 'createServer').mockImplementation(fn => { handler = fn; return {} })
  try {
    createServer({
      generate: async () => ({
        title: '<script>Demo</script>',
        introduction: 'Demo',
        sections: [{
          heading: 'Explore',
          description: '<img src=x onerror=alert(1)>',
          courses: [{ id: 'aem-basics', title: 'AEM', description: 'Learn', topic: 'AEM', level: 'beginner', progressPercent: null }]
        }],
        suggestions: [{ type: 'explore', label: 'More', query: 'More AEM' }]
      })
    })
    const request = async (method, origin, body = '') => {
      const req = Readable.from(body ? [body] : [])
      Object.assign(req, { method, url: '/api/mock-for-you', headers: { host: 'localhost:9081', origin } })
      const res = {
        writeHead: jest.fn(function (status, headers) { this.status = status; this.headers = headers }),
        end: jest.fn(function (data) { this.body = data })
      }
      await handler(req, res)
      return res
    }
    const list = await request('GET')
    expect(JSON.parse(list.body).personas).toHaveLength(3)
    const denied = await request('GET', 'https://example.com')
    expect(denied.status).toBe(403)
    const result = await request('POST', 'http://localhost:3000', JSON.stringify({ personaId: 'new-learner', query: '' }))
    expect(result.status).toBe(200)
    const events = JSON.parse(result.body)
    expect(events.map(event => event.type)).toEqual(['section', 'section', 'suggestions', 'debug', 'done'])
    expect(events[0]).toMatchObject({
      index: 0,
      html: expect.stringContaining('&lt;script&gt;Demo&lt;/script&gt;')
    })
    expect(events[0].html).not.toContain('<script>')
    expect(events[1].html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(events[1].html).not.toContain('<img')
    expect(events[1].html).toContain('<h4>AEM</h4>')
    expect(events[1]).not.toHaveProperty('data')
    expect(events[2].items[0]).toMatchObject({ type: 'explore', label: 'More', query: 'More AEM' })
    expect(events[3].timings).toEqual({ generation: expect.any(Number), total: expect.any(Number) })
    expect(events[4].usedCourses).toEqual(['aem-basics'])
  } finally {
    create.mockRestore()
  }
})
