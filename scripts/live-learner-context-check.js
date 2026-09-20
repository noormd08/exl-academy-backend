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

// Manual, local-only check: calls learner-context with a real IMS token from .env (IMS_TEST_TOKEN)
// so it hits the actual https://ims-na1.adobelogin.com/ims/profile/v1 endpoint. Not part of the
// jest suite on purpose — the golden tests mock IMS so they stay fast and offline.
//
// Usage: node scripts/live-learner-context-check.js

require('dotenv').config()
const { main } = require('../actions/learner-context')

async function run () {
  const token = process.env.IMS_TEST_TOKEN
  if (!token) {
    console.error('Set IMS_TEST_TOKEN in .env to a real learner IMS access token first.')
    process.exit(1)
  }

  const result = await main({
    LOG_LEVEL: 'debug',
    PL_API_BASE: process.env.PL_API_BASE,
    PL_API_KEY: process.env.PL_API_KEY,
    __ow_headers: { authorization: `Bearer ${token}` }
  })

  console.log(JSON.stringify(result, null, 2))
}

run()
