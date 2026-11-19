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

// THE single place that knows how to talk to Adobe Learning Manager (ALM) Prime API v2 — auth,
// error handling, and every endpoint URL (golden rule #5). Both `learner-context` and `retrieval`
// build their calls from this client. If ALM's shape or auth changes, this is the only file to touch.
//
class AlmError extends Error {
  constructor (code, message, statusCode = 502) {
    super(message)
    this.name = 'AlmError'
    this.code = code
    this.statusCode = statusCode
  }
}

function almErrorResponse (error) {
  const known = error instanceof AlmError
  return {
    statusCode: known ? error.statusCode : 502,
    body: {
      code: known ? error.code : 'ALM_UNAVAILABLE',
      error: known ? error.message : 'ALM request failed; no learner data was returned'
    }
  }
}

async function fetchEnrollmentPages (apiBase, get) {
  const base = new URL(`${apiBase.replace(/\/$/, '')}/`)
  let path = '/enrollments?include=learningObject,loInstance&filter.loTypes=learningProgram,course&includeHierarchicalEnrollments=true&sort=-dateEnrolled'
  const visited = new Set()
  const data = []
  const included = new Map()
  while (path) {
    const url = new URL(`${apiBase.replace(/\/$/, '')}${path}`)
    if (visited.has(url.href)) throw new Error('ALM enrollments pagination cycle')
    visited.add(url.href)
    const page = await get(path)
    if (!Array.isArray(page.data)) throw new Error('ALM enrollments response missing data array')
    data.push(...page.data)
    for (const item of page.included || []) included.set(`${item.type}:${item.id}`, item)
    if (!page.links?.next) break
    const next = new URL(page.links.next, url)
    if (next.origin !== base.origin || next.pathname !== `${base.pathname}enrollments` ||
        next.username || next.password || next.hash) {
      throw new Error('ALM enrollments pagination URL is not allowed')
    }
    path = `${next.pathname.slice(base.pathname.length - 1)}${next.search}`
  }
  return { data, included: [...included.values()] }
}

function almClient ({ fetchImpl = fetch } = {}) {
  const accessToken = process.env.ALM_ACCESS_TOKEN?.trim()
  if (!accessToken) {
    throw new AlmError('ALM_NOT_CONFIGURED', 'ALM_ACCESS_TOKEN is missing; configure it in the server environment', 503)
  }
  if (/\s/.test(accessToken)) {
    throw new AlmError('ALM_NOT_CONFIGURED', 'ALM_ACCESS_TOKEN must be a single access token without whitespace', 503)
  }
  let base
  try {
    base = new URL(process.env.ALM_API_BASE_URL || 'https://learningmanager.adobe.com/primeapi/v2')
  } catch {
    throw new AlmError('ALM_NOT_CONFIGURED', 'ALM_API_BASE_URL must be an absolute HTTPS API URL', 503)
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new AlmError('ALM_NOT_CONFIGURED', 'ALM_API_BASE_URL must be an absolute HTTPS API URL without credentials, query or fragment', 503)
  }
  const baseUrl = base.href.replace(/\/$/, '')

  const request = async (path) => {
    let response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json'
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000)
      })
    } catch {
      throw new AlmError('ALM_UNAVAILABLE', 'ALM could not be reached or the request timed out')
    }
    if (response.status === 401) {
      throw new AlmError('ALM_TOKEN_INVALID', 'ALM access token is invalid or expired; replace ALM_ACCESS_TOKEN manually and restart the backend', 401)
    }
    if (response.status === 403) {
      throw new AlmError('ALM_FORBIDDEN', 'ALM access token has insufficient permissions', 403)
    }
    if (response.status === 429) {
      throw new AlmError('ALM_RATE_LIMITED', 'ALM rate limit reached; stop this check and try again later', 429)
    }
    if (!response.ok) {
      throw new AlmError('ALM_UPSTREAM_ERROR', 'ALM returned an unsuccessful response; no upstream error body is exposed')
    }
    try {
      return await response.json()
    } catch {
      throw new AlmError('ALM_INVALID_RESPONSE', 'ALM returned an invalid JSON response')
    }
  }

  let userPromise
  const getUser = () => {
    if (!userPromise) {
      userPromise = request('/user').then(user => {
        const learnerId = user?.data?.id
        const accountId = user?.data?.relationships?.account?.data?.id
        const roles = user?.data?.attributes?.roles
        if (typeof learnerId !== 'string' || !learnerId.trim() ||
            typeof accountId !== 'string' || !accountId.trim() ||
            !Array.isArray(roles) || roles.some(role => typeof role !== 'string' || !role.trim())) {
          throw new AlmError('ALM_INVALID_RESPONSE', 'ALM /user must return a learner ID, account ID and roles array')
        }
        return user
      })
    }
    return userPromise
  }
  const get = async (path) => {
    await getUser()
    return request(path)
  }

  const readCollection = async (path, maxPages, allowPartial = false) => {
    const first = new URL(`${baseUrl}${path}`)
    let url = first
    const visited = new Set()
    const data = new Map()
    const included = new Map()
    let pagesFetched = 0
    while (url) {
      url.searchParams.sort()
      if (visited.has(url.href)) {
        throw new AlmError('ALM_INVALID_RESPONSE', 'ALM collection pagination cycle')
      }
      visited.add(url.href)
      const page = await get(`${url.pathname.slice(base.pathname.replace(/\/$/, '').length)}${url.search}`)
      pagesFetched++
      if (!Array.isArray(page?.data) || (page.included !== undefined && !Array.isArray(page.included)) ||
          [...page.data, ...(page.included || [])].some(item =>
            !item || typeof item.id !== 'string' || typeof item.type !== 'string')) {
        throw new AlmError('ALM_INVALID_RESPONSE', 'ALM collection must contain JSON:API resource arrays')
      }
      for (const item of page.data) data.set(`${item.type}:${item.id}`, item)
      for (const item of page.included || []) included.set(`${item.type}:${item.id}`, item)
      let next = null
      if (page.links?.next) {
        try {
          if (typeof page.links.next !== 'string') throw new Error('Invalid link')
          next = new URL(page.links.next, url)
        } catch {
          throw new AlmError('ALM_INVALID_RESPONSE', 'ALM collection pagination link is invalid')
        }
        if (next.origin !== first.origin || next.pathname !== first.pathname ||
            next.username || next.password || next.hash) {
          throw new AlmError('ALM_INVALID_RESPONSE', 'ALM collection pagination URL is not allowed')
        }
        // A cursor-only next link must not drop or change the original catalog scope.
        for (const [key, value] of first.searchParams) {
          if (key.startsWith('page[')) continue
          const nextValues = next.searchParams.getAll(key)
          if (nextValues.length && (nextValues.length !== 1 || nextValues[0] !== value)) {
            throw new AlmError('ALM_INVALID_RESPONSE', 'ALM collection pagination changed the requested scope')
          }
          next.searchParams.set(key, value)
        }
      }
      if (next && pagesFetched >= maxPages) {
        if (!allowPartial) throw new AlmError('ALM_PAGINATION_LIMIT', 'ALM collection exceeded the bounded page limit')
        return { data: [...data.values()], included: [...included.values()], meta: { pagesFetched, complete: false } }
      }
      url = next
    }
    return { data: [...data.values()], included: [...included.values()], meta: { pagesFetched, complete: true } }
  }

  return {
    // --- per-user (scoped to the token owner) ---
    getUser,
    // include=loInstance -> cohort session dates inline; includeHierarchicalEnrollments=true -> sub-course
    // completion surfaces in the enrollment list (see CONTEXT.md). Follow same-endpoint pagination.
    getEnrollments: () => fetchEnrollmentPages(baseUrl, get),
    getUserBadges: async () => {
      const user = await getUser()
      return get(`/users/${encodeURIComponent(user.data.id)}/userBadges?include=badge,model&sort=-dateAchieved`)
    },
    // The learner's actual skills (with names + level inline via includes, and pointsEarned). This is
    // the authoritative source for skills — NOT the userBadges-derived guess, which only caught skills
    // that happened to have a badge. (userSkills rejects a sort param; normalize sorts by pointsEarned.)
    getUserSkills: async () => {
      const user = await getUser()
      return get(`/users/${encodeURIComponent(user.data.id)}/userSkills?include=skill,skillLevel`)
    },
    getRecommendationPreferences: async () => {
      const user = await getUser()
      return get(`/users/${encodeURIComponent(user.data.id)}/recommendationPreferences`)
    },
    // Preserve the ALM recommendations endpoint used by the original frontend block.
    getRecommendations: () => get('/recommendations'),

    // --- account-wide catalog ---
    getCatalogs: () => readCollection('/catalogs?page[limit]=10&sort=dateCreated', 100),
    getCatalogLearningObjects: ({ catalogId, maxPages = 2 } = {}) => {
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
          (catalogId !== undefined && (typeof catalogId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(catalogId)))) {
        throw new AlmError('ALM_INVALID_REQUEST', 'Provide a valid catalog ID and maxPages between 1 and 100', 400)
      }
      const query = new URLSearchParams({
        include: 'instances,enrollment.loResourceGrades,skills.skillLevel.skill',
        'page[limit]': '10',
        'filter.loTypes': 'course',
        sort: 'name',
        language: 'en',
        'enforcedFields[learningObject]': 'products',
        'filter.ignoreEnhancedLP': 'false'
      })
      if (catalogId !== undefined) query.set('filter.catalogIds', catalogId)
      return readCollection(`/learningObjects?${query}`, maxPages, true)
    },
    getLearningObject: async (loId) => {
      if (typeof loId !== 'string' || !/^(course|learningProgram):[A-Za-z0-9_-]+$/.test(loId)) {
        throw new AlmError('ALM_INVALID_REQUEST', 'Provide a full course:<id> or learningProgram:<id> identifier', 400)
      }
      const response = await get(`/learningObjects/${encodeURIComponent(loId)}?include=instances,skills.skillLevel.skill`)
      if (response?.data?.id !== loId || response.data.type !== 'learningObject' ||
          !response.data.attributes || typeof response.data.attributes !== 'object') {
        throw new AlmError('ALM_INVALID_RESPONSE', 'ALM learning-object response does not match the requested object')
      }
      return response
    },
    // Not-enrolled courses that grant the given skill (retrieval "skill-next" tier).
    getLearningObjectsBySkill: (skillName) =>
      get(`/learningObjects?filter.skillName=${encodeURIComponent(skillName)}&filter.learnerState=notenrolled&filter.loTypes=course&language=en&page[limit]=10`),
    // Content-based "related to X" recommendations for a given LO (retrieval "related" tier). Used
    // instead of ALM's PRL sort=recommendation, which 400s on our accounts.
    getRelatedLOs: (loId) =>
      get(`/learningObjects/${encodeURIComponent(loId)}/relatedLOs?language=en`)
  }
}

module.exports = { almClient, fetchEnrollmentPages, AlmError, almErrorResponse }
