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

const { almClient } = require('../shared/alm')

// Fetches the ALM data learner-context needs and returns it as one bundle. ALM endpoint/auth details
// live in ../shared/alm.js (golden rule #5); this only orchestrates the calls.
//
// Limitation: every per-user ALM call is scoped to whoever PL_API_KEY belongs to — a fixed key can
// only serve its own owner's data, not an arbitrary learner. `userId` (the IMS identity) is therefore
// unused today, but kept in the signature for when that's resolved. See CONTEXT.md "Blocking dependency".
async function fetchLearnerState (userId, { apiBase, apiKey, fetchImpl = fetch } = {}) {
  const alm = almClient({ apiBase, apiKey, fetchImpl })

  // /user must run first: its id (not the passed-in userId) is the ALM identity the other calls scope to.
  const user = await alm.getUser()
  const almUserId = user.data.id

  const [enrollments, badges, userSkills] = await Promise.all([
    alm.getEnrollments(),
    alm.getUserBadges(almUserId), // for achievements.earned
    alm.getUserSkills(almUserId)  // for profile.skillLevels
  ])

  return { user, enrollments, badges, userSkills }
}

module.exports = { fetchLearnerState }
