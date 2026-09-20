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
const { validateImsToken, extractBearerToken, ImsError } = require('./ims')
const { fetchLearnerState } = require('./api')
const { normalizeLearnerContext, degradedContext } = require('./normalize')

// layer 2: validate IMS, fetch + normalize learner facts. No LLM, no ranking, no `goal` (out of scope).
async function main (params) {
  const logger = Core.Logger('learner-context', { level: params.LOG_LEVEL || 'info' })
  const headers = params.__ow_headers || {}

  const token = extractBearerToken(headers)

  let userId
  try {
    const profile = await validateImsToken(token)
    userId = profile.userId
  } catch (err) {
    if (err instanceof ImsError && err.kind === 'unreachable') {
      logger.error(`IMS unreachable: ${err.message}`)
      return { statusCode: 502, body: { error: 'IMS profile service unreachable' } }
    }
    logger.info(`IMS auth rejected: ${err.message}`)
    return { statusCode: 401, body: { error: 'Missing or invalid IMS access token' } }
  }

  try {
    const raw = await fetchLearnerState(userId, {
      apiBase: params.PL_API_BASE,
      apiKey: params.PL_API_KEY
    })
    return { statusCode: 200, body: normalizeLearnerContext(raw) }
  } catch (err) {
    logger.error(`Premium Learning lookup failed, returning degraded context: ${err.message}`)
    return { statusCode: 200, body: degradedContext(userId) }
  }
}

exports.main = main
