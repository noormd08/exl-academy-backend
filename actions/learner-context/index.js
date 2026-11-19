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
const { fetchLearnerState } = require('./api')
const { normalizeLearnerContext, degradedContext } = require('./normalize')
const { AlmError, almErrorResponse } = require('../shared/alm')

// Internal-only action: use the manually configured ALM token owner's identity.
async function main (params, loadLearnerState = fetchLearnerState) {
  const logger = Core.Logger('learner-context', { level: params.LOG_LEVEL || 'info' })
  try {
    const raw = await loadLearnerState()
    return { statusCode: 200, body: normalizeLearnerContext(raw) }
  } catch (err) {
    if (err instanceof AlmError) {
      logger.error(err.code)
      return almErrorResponse(err)
    }
    logger.error('ALM lookup failed, returning degraded context')
    return { statusCode: 200, body: degradedContext() }
  }
}

exports.main = main
