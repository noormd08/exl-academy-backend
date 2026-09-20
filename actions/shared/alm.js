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
// Auth is `Authorization: oauth <token>` (PL_API_KEY), not Bearer — confirmed via ALM's Swagger docs.
// Per-user endpoints (/user, /users/{id}/...) are scoped to whoever PL_API_KEY belongs to; catalog
// endpoints (/learningObjects, /skills) are account-wide. See CONTEXT.md "Blocking dependency".
function almClient ({ apiBase, apiKey, fetchImpl = fetch } = {}) {
  if (!apiBase) {
    throw new Error('PL_API_BASE not configured (see CONTEXT.md for the confirmed ALM base URL)')
  }

  const get = async (path) => {
    const response = await fetchImpl(`${apiBase}${path}`, { headers: { Authorization: `oauth ${apiKey}` } })
    if (!response.ok) {
      throw new Error(`ALM ${path} returned ${response.status}`)
    }
    return response.json()
  }

  return {
    // --- per-user (scoped to the token owner) ---
    getUser: () => get('/user'),
    // include=loInstance -> cohort session dates inline; includeHierarchicalEnrollments=true -> sub-course
    // completion surfaces in the enrollment list (see CONTEXT.md). Reads first page only (pagination TODO).
    getEnrollments: () =>
      get('/enrollments?include=learningObject,loInstance&filter.loTypes=learningProgram,course&includeHierarchicalEnrollments=true&sort=-dateEnrolled'),
    getUserBadges: (almUserId) =>
      get(`/users/${encodeURIComponent(almUserId)}/userBadges?include=badge,model&sort=-dateAchieved`),
    // The learner's actual skills (with names + level inline via includes, and pointsEarned). This is
    // the authoritative source for skills — NOT the userBadges-derived guess, which only caught skills
    // that happened to have a badge. (userSkills rejects a sort param; normalize sorts by pointsEarned.)
    getUserSkills: (almUserId) =>
      get(`/users/${encodeURIComponent(almUserId)}/userSkills?include=skill,skillLevel`),

    // --- account-wide catalog ---
    // Not-enrolled courses that grant the given skill (retrieval "skill-next" tier).
    getLearningObjectsBySkill: (skillName) =>
      get(`/learningObjects?filter.skillName=${encodeURIComponent(skillName)}&filter.learnerState=notenrolled&filter.loTypes=course&language=en&page[limit]=10`),
    // Content-based "related to X" recommendations for a given LO (retrieval "related" tier). Used
    // instead of ALM's PRL sort=recommendation, which 400s on our accounts.
    getRelatedLOs: (loId) =>
      get(`/learningObjects/${encodeURIComponent(loId)}/relatedLOs?language=en`)
  }
}

module.exports = { almClient }
