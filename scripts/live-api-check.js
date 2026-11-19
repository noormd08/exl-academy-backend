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

// Manual, local-only check: calls the real ALM Prime API v2 via api.js, using
// ALM_API_BASE_URL/ALM_ACCESS_TOKEN from .env. Results belong to the configured ALM token owner.
//
// Usage: npm run check:api

require('dotenv').config()
const { fetchLearnerState } = require('../actions/learner-context/api')
const { normalizeLearnerContext } = require('../actions/learner-context/normalize')

async function run () {
  const raw = await fetchLearnerState()

  console.log('=== normalized learner-context ===')
  console.log(JSON.stringify(normalizeLearnerContext(raw), null, 2))
}

run().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
