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

// Manual, local-only check of the real chain: fetch + normalize learner-context from live ALM, then
// run retrieval over it (which makes its own live catalog calls). Bypasses IMS. Usage: npm run check:retrieval

require('dotenv').config()
const { fetchLearnerState } = require('../actions/learner-context/api')
const { normalizeLearnerContext } = require('../actions/learner-context/normalize')
const { main } = require('../actions/retrieval')

async function run () {
  if (!process.env.PL_API_BASE || !process.env.PL_API_KEY) {
    console.error('Set PL_API_BASE and PL_API_KEY in .env first.')
    process.exit(1)
  }

  const raw = await fetchLearnerState('unused-ims-id', {
    apiBase: process.env.PL_API_BASE,
    apiKey: process.env.PL_API_KEY
  })
  const ctx = normalizeLearnerContext(raw)

  const result = await main({
    ...ctx,
    LOG_LEVEL: 'error',
    PL_API_BASE: process.env.PL_API_BASE,
    PL_API_KEY: process.env.PL_API_KEY
  })

  console.log('=== retrieval output ===')
  console.log(JSON.stringify(result.body, null, 2))
}

run().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
