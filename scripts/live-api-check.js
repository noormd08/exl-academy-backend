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

// Manual, local-only check: calls the real ALM Prime API v2 directly via api.js, using
// PL_API_BASE/PL_API_KEY from .env. Bypasses IMS entirely — GET /user is scoped to whoever
// PL_API_KEY belongs to, so the userId argument here is unused for real calls (see api.js).
//
// Usage: npm run check:api

require('dotenv').config()
const { fetchLearnerState } = require('../actions/learner-context/api')
const { normalizeLearnerContext } = require('../actions/learner-context/normalize')

async function run () {
  if (!process.env.PL_API_BASE || !process.env.PL_API_KEY) {
    console.error('Set PL_API_BASE and PL_API_KEY in .env first.')
    process.exit(1)
  }

  const raw = await fetchLearnerState('unused-ims-id', {
    apiBase: process.env.PL_API_BASE,
    apiKey: process.env.PL_API_KEY
  })

  console.log('=== normalized learner-context ===')
  console.log(JSON.stringify(normalizeLearnerContext(raw), null, 2))
}

run().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
