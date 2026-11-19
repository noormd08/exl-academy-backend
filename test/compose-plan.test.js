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

describe('compose-plan endpoint', () => {
  beforeEach(() => jest.restoreAllMocks())

  it('keeps the public endpoint unavailable and never fetches account data', async () => {
    global.fetch = jest.fn()

    const result = await main({
      __ow_method: 'GET',
      PL_API_BASE: 'https://alm.example.com'
    })

    expect(result.statusCode).toBe(503)
    expect(result.body).toEqual({
      error: 'Endpoint unavailable until an approved access-control mechanism is configured'
    })
    expect(result.headers['Cache-Control']).toBe('private, no-store')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('CORS preflight returns 204 with CORS headers', async () => {
    const result = await main({
      __ow_method: 'OPTIONS',
      __ow_headers: { origin: 'https://hub.example.com' },
      CORS_ORIGIN: 'https://hub.example.com'
    })
    expect(result.statusCode).toBe(204)
    expect(result.headers['Access-Control-Allow-Origin']).toBe('https://hub.example.com')
    expect(result.headers['Cache-Control']).toBe('private, no-store')
    expect(result.headers.Vary).toBe('Origin')
  })

  it('does not make the endpoint available based on caller-supplied authorization', async () => {
    global.fetch = jest.fn()
    const result = await main({
      __ow_method: 'GET',
      __ow_headers: { authorization: 'untrusted-caller-credential' },
      PL_API_BASE: 'https://alm.example.com'
    })
    expect(result.statusCode).toBe(503)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it.each([undefined, '*', 'https://other.example.com'])('does not allow an unconfigured origin (%s)', async (configured) => {
    const result = await main({
      __ow_method: 'OPTIONS',
      __ow_headers: { origin: 'https://hub.example.com' },
      CORS_ORIGIN: configured
    })
    expect(result.headers).not.toHaveProperty('Access-Control-Allow-Origin')
  })

  it('returns no data for unsupported methods', async () => {
    const result = await main({ __ow_method: 'POST' })
    expect(result.statusCode).toBe(405)
    expect(result.body).toEqual({ error: 'Method not allowed' })
  })
})
