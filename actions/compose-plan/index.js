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
const { validateImsToken, extractBearerToken, ImsError } = require('../learner-context/ims')
const { fetchLearnerState } = require('../learner-context/api')
const { normalizeLearnerContext } = require('../learner-context/normalize')
const { main: retrievalAction } = require('../retrieval')
const { resolveLayout } = require('./resolve-layout')

// The ONLY public endpoint the EDS block calls. Validates the IMS token, chains
// learner-context -> retrieval -> resolveLayout, and returns { meta, layout } as JSON — DECISIONS
// ONLY (mode, ordering, reasons); the frontend blocks fetch their own content from ALM. Never returns
// HTML. If anything past auth fails, it returns 200 with a safe default so the page always renders.
// No LLM here (aiUsed is always false in this step).

// Returned whenever the pipeline fails — a minimal, always-valid layout (todays-plan shown, rest hidden).
const SAFE_DEFAULT = {
  meta: { mode: 'learn', aiUsed: false },
  layout: {
    blocks: [
      { id: 'pl-todays-plan', show: true, order: 1, emphasis: true },
      { id: 'pl-cohort-readiness', show: false, order: 0, emphasis: false },
      { id: 'pl-my-priorities', show: false, order: 0, emphasis: false },
      { id: 'pl-recommended', show: false, order: 0, emphasis: false }
    ]
  }
}

function corsHeaders (params) {
  return {
    'Access-Control-Allow-Origin': params.CORS_ORIGIN || '*', // lock to the EDS origins via CORS_ORIGIN
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Content-Type': 'application/json'
  }
}

async function main (params) {
  const logger = Core.Logger('compose-plan', { level: params.LOG_LEVEL || 'info' })
  const headers = corsHeaders(params)

  // CORS preflight.
  if ((params.__ow_method || '').toLowerCase() === 'options') {
    return { statusCode: 204, headers }
  }

  // Auth: validate the IMS token exactly as learner-context does (401 missing/invalid, 502 unreachable).
  let userId
  try {
    const profile = await validateImsToken(extractBearerToken(params.__ow_headers || {}))
    userId = profile.userId
  } catch (err) {
    if (err instanceof ImsError && err.kind === 'unreachable') {
      logger.error(`IMS unreachable: ${err.message}`)
      return { statusCode: 502, headers, body: { error: 'IMS profile service unreachable' } }
    }
    logger.info(`IMS auth rejected: ${err.message}`)
    return { statusCode: 401, headers, body: { error: 'Missing or invalid IMS access token' } }
  }

  // Data pipeline: any failure here degrades to the safe default (page always renders).
  try {
    const raw = await fetchLearnerState(userId, { apiBase: params.PL_API_BASE, apiKey: params.PL_API_KEY })
    const context = normalizeLearnerContext(raw)

    const retrievalResult = await retrievalAction({
      ...context,
      LOG_LEVEL: params.LOG_LEVEL,
      PL_API_BASE: params.PL_API_BASE,
      PL_API_KEY: params.PL_API_KEY
    })
    const retrieval = retrievalResult.body

    return { statusCode: 200, headers, body: resolveLayout(context, retrieval) }
  } catch (err) {
    logger.error(`compose-plan pipeline failed, returning safe default: ${err.message}`)
    return { statusCode: 200, headers, body: SAFE_DEFAULT }
  }
}

exports.main = main
