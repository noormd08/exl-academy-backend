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

const IMS_PROFILE_URL = 'https://ims-na1.adobelogin.com/ims/profile/v1'

class ImsError extends Error {
  constructor (message, kind) {
    super(message)
    this.name = 'ImsError'
    this.kind = kind // 'missing' | 'invalid' | 'unreachable'
  }
}

function extractBearerToken (headers = {}) {
  const authHeader = headers.authorization || headers.Authorization
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return null
  }
  return authHeader.slice(authHeader.indexOf(' ') + 1).trim()
}

// Isolates the one real call to IMS. If IMS ever changes shape, this is the only place that changes.
async function validateImsToken (token, fetchImpl = fetch) {
  if (!token) {
    throw new ImsError('Missing IMS access token', 'missing')
  }

  let response
  try {
    response = await fetchImpl(IMS_PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}` }
    })
  } catch (err) {
    throw new ImsError(`IMS profile endpoint unreachable: ${err.message}`, 'unreachable')
  }

  if (response.status === 401 || response.status === 403) {
    throw new ImsError('IMS token invalid or expired', 'invalid')
  }
  if (!response.ok) {
    throw new ImsError(`IMS profile endpoint returned ${response.status}`, 'unreachable')
  }

  const profile = await response.json()
  if (!profile || !profile.userId) {
    throw new ImsError('IMS profile response missing userId', 'invalid')
  }

  return { userId: profile.userId }
}

module.exports = { validateImsToken, extractBearerToken, ImsError }
