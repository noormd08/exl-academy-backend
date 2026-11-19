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
// live in ../shared/alm.js. This configured credential reads only its own account's data.
//
// ALM_ACCESS_TOKEN identifies one configured learner, not the browser visitor.
async function fetchLearnerState ({ fetchImpl = fetch } = {}) {
  const alm = almClient({ fetchImpl })

  // /user identifies the account owner whose data this configured token can access.
  const user = await alm.getUser()
  const [enrollments, badges, userSkills] = await Promise.all([
    alm.getEnrollments(),
    alm.getUserBadges(), // for achievements.earned
    alm.getUserSkills()  // for profile.skillLevels
  ])

  return { user, enrollments, badges, userSkills }
}

module.exports = { fetchLearnerState }
