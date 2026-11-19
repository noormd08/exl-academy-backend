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

const { Core } = require('@adobe/aio-sdk')

const ACCESS_CONTROL_UNAVAILABLE = {
  error: 'Endpoint unavailable until an approved access-control mechanism is configured'
}

function corsHeaders (params) {
  const origin = (params.__ow_headers || {}).origin
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'private, no-store',
    Vary: 'Origin',
    'Content-Type': 'application/json'
  }
  if (origin && params.CORS_ORIGIN === origin && origin !== '*' && origin !== 'null') {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

async function main (params) {
  const logger = Core.Logger('compose-plan', { level: params.LOG_LEVEL || 'info' })
  const headers = corsHeaders(params)

  if ((params.__ow_method || '').toLowerCase() === 'options') {
    return { statusCode: 204, headers }
  }

  if ((params.__ow_method || 'GET').toLowerCase() !== 'get') {
    return { statusCode: 405, headers, body: { error: 'Method not allowed' } }
  }

  logger.warn('Public compose-plan endpoint is disabled pending approved access control')
  return { statusCode: 503, headers, body: ACCESS_CONTROL_UNAVAILABLE }
}

exports.main = main
