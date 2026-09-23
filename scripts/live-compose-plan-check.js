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

// Manual, local-only check of the full decision chain: learner-context -> retrieval -> resolveLayout,
// using the ALM token (PL_API_KEY) from .env. Bypasses IMS on purpose — IMS only identifies the
// learner, it isn't needed to exercise the data/layout logic (compose-plan's IMS gate is covered by
// the unit/HTTP tests). Whatever account PL_API_KEY belongs to is the learner shown here.
//
// Usage: npm run check:compose-plan

require('dotenv').config()
const { fetchLearnerState } = require('../actions/learner-context/api')
const { normalizeLearnerContext } = require('../actions/learner-context/normalize')
const { main: retrievalAction } = require('../actions/retrieval')
const { resolveLayout } = require('../actions/compose-plan/resolve-layout')

async function run () {
  if (!process.env.PL_API_BASE || !process.env.PL_API_KEY) {
    console.error('Set PL_API_BASE and PL_API_KEY in .env first.')
    process.exit(1)
  }

  const alm = { apiBase: process.env.PL_API_BASE, apiKey: process.env.PL_API_KEY }

  const context = normalizeLearnerContext(await fetchLearnerState('bypass-ims', alm))
  const retrieval = (await retrievalAction({ ...context, LOG_LEVEL: 'error', ...renameCreds(alm) })).body
  const plan = resolveLayout(context, retrieval)

  console.log('=== compose-plan output (meta + layout + blocksData) ===')
  console.log(JSON.stringify(plan, null, 2))
}

// retrieval reads PL creds from params under the PL_API_* names.
function renameCreds ({ apiBase, apiKey }) {
  return { PL_API_BASE: apiBase, PL_API_KEY: apiKey }
}

run().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
