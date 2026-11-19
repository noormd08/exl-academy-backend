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

const http = require('node:http')
const { composePlan } = require('../actions/compose-plan/compose')
const { main: currentLearner } = require('../actions/current-learner')
const { almClient, almErrorResponse } = require('../actions/shared/alm')

const HOST = '127.0.0.1'
const ROUTE = '/api/v1/web/premium-learning/compose-plan'
const LEARNER_ROUTE = '/api/current-learner'
const ALLOWED_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000'])

function createLocalDemoServer ({ compose = composePlan } = {}) {
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin
    const headers = {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      Vary: 'Origin'
    }

    // CORS does not stop DNS rebinding: only literal loopback Host values are accepted.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host || '')) {
      response.writeHead(403, headers)
      response.end(JSON.stringify({ error: 'Only localhost requests are allowed' }))
      return
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      response.writeHead(403, headers)
      response.end(JSON.stringify({ error: 'Origin is not allowed for the local demo' }))
      return
    }
    if (origin) headers['Access-Control-Allow-Origin'] = origin

    let pathname
    try {
      pathname = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`).pathname
    } catch {
      response.writeHead(400, headers)
      response.end(JSON.stringify({ error: 'Invalid request path' }))
      return
    }

    if (request.method === 'OPTIONS' && [ROUTE, LEARNER_ROUTE].includes(pathname)) {
      headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
      response.writeHead(204, headers)
      response.end()
      return
    }
    if (request.method === 'GET' && pathname === '/health') {
      response.writeHead(200, headers)
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (![ROUTE, LEARNER_ROUTE].includes(pathname)) {
      response.writeHead(404, headers)
      response.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, headers)
      response.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    if (pathname === LEARNER_ROUTE) {
      const result = await currentLearner()
      response.writeHead(result.statusCode, { ...headers, ...result.headers })
      response.end(JSON.stringify(result.body))
      return
    }

    try {
      const plan = await compose()
      response.writeHead(200, headers)
      response.end(JSON.stringify(plan))
    } catch (error) {
      const result = almErrorResponse(error)
      console.error(`[local-demo] ${result.body.code}`)
      response.writeHead(result.statusCode, headers)
      response.end(JSON.stringify(result.body))
    }
  })
}

function startLocalDemoServer () {
  try {
    almClient()
  } catch (error) {
    console.error(almErrorResponse(error).body.error)
    process.exitCode = 1
    return
  }

  const configuredPort = Number(process.env.PL_LOCAL_PORT || 9080)
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    console.error('PL_LOCAL_PORT must be a valid TCP port')
    process.exitCode = 1
    return
  }

  const server = createLocalDemoServer()
  server.on('error', () => {
    console.error('[local-demo] Could not start the localhost-only server')
    process.exitCode = 1
  })
  server.listen(configuredPort, HOST, () => {
    console.log(`Local-only Premium Learning API listening on http://${HOST}:${configuredPort}`)
  })
  return server
}

if (require.main === module) startLocalDemoServer()

module.exports = { createLocalDemoServer, startLocalDemoServer }
