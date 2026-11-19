# CLAUDE.md — `audience-of-one` backend

Working guide for anyone (human or agent) building in this repo. Read this before editing.
Also valid as `AGENTS.md`. Source of truth for architecture is the lead's *POC Technical Getting
Started* guide; if this file and that guide ever disagree, the guide wins — update this file to match.

---

## What this repo is

The **Audience of ONE** backend: an **Adobe App Builder / Adobe I/O Runtime** project with a
loopback-only Node prototype that reads learning context using a manually supplied server-side
ALM access token. It computes deterministic layout decisions and returns JSON, not HTML.

- **Frontend:** Edge Delivery Services (separate repo). Renders. Not here.
- **Authoring:** Universal Editor. Owns block structure. Not here.
- **This repo:** decide only. **Never returns HTML.**

---

## Golden rules (apply to every change)

1. **Return JSON, never HTML.** Universal Editor owns visual structure; this service returns data.
2. **Never break the page.** Return structured errors for configuration, authorization and upstream
   failures. Optional data may degrade only with an observable warning; do not disguise failed
   credential checks as successful empty data. My Hub stays usable independently of these calls.
3. **Keep the ALM token server-side.** Read `ALM_ACCESS_TOKEN` only from the backend environment,
   never action/browser parameters. Treat data as belonging to the configured token owner, not the
   visitor. The current-learner endpoint is loopback-only; public data access remains disabled.
4. **Secrets stay server-side.** `.env` locally, workspace secure config on stage/prod. Never in the
   repo, responses, or logs.
5. **Isolate the real APIs.** All knowledge of an upstream API lives in one adapter function. If its
   shape changes, exactly one file changes.
6. **Rules before AI; AI is optional and flagged.** Deterministic logic and the `fallbackPlan` must
   produce a usable result with the LLM switched off. AI never touches eligibility or (later) layout.
7. **Keep actions single-purpose.** Each action does its one job; don't collapse layers together.

---

## Architecture — current implementation

`learner-context` uses the manually configured ALM access token through `actions/shared/alm.js` and is
`web: 'no'`. `retrieval` ranks normalized context. The current public `compose-plan` action is
deliberately **closed**: it returns 503 without calling ALM until an approved endpoint
access-control mechanism is configured. CORS is not authentication. The frontend no longer loads
demo fixtures, sends an ALM token, or calls the backend while the endpoint is closed.

### Action responsibilities (including proposed layers)

| Action | Job | Must not |
|---|---|---|
| `learner-context` | fetch configured token-owner ALM state; return normalized context | expose data through the public endpoint; call LLM; rank; include a goal |
| `behavior-profile` | aggregate raw events → `{ interests, segment }`; return `null` if none | read raw events downstream; block if absent |
| `retrieval` | produce ranked catalog candidates from context + profile | call LLM; reason about a plan |
| `orchestrate` | build `{ plan, explanation }` via LLM; validate; fallback; decide `achievements.next` (role + interests + recommendations) | trust raw model output; skip JSON validation |
| `policy-guard` | drop steps the learner isn't eligible for; run last | let AI override policy |

---

## Current scope / status

- **Actual implementation:** `learner-context`, `retrieval`, and public `compose-plan` are built.
  `compose-plan` is currently unavailable (503) because Runtime is configured without endpoint
  authentication and the browser has no safe access method. It does not call ALM or return
  learner data. The EDS project keeps four personalized blocks hidden.
  `orchestrate`, `policy-guard`, measurement, and behavioral capture are not implemented. Earlier
  sequence and orchestration examples are proposals, not the current contract.
- **ALM adapter is shared.** All ALM endpoint/auth knowledge lives in `actions/shared/alm.js`
  (`almClient`), imported by both `learner-context` and `retrieval` (golden rule #5).
- **Goal is OUT of `learner-context` for now.** Do not read/store/return a goal there. Context is
  learning *facts* only: profile, progress, cohorts, enrollments, achievements. The frontend contract
  for returning block content from the backend has not been agreed or implemented.
- The internal learner-context action calls ALM with server-environment `ALM_ACCESS_TOKEN`; the frontend does not
  load fixtures or call the public action while it is closed.
- The independent `GET /api/current-learner` endpoint runs on the loopback Node backend via
  `npm run start:alm`. It validates `GET /user`, returns minimal learner/account identity and roles,
  and uses `Authorization: Bearer <token>` with JSON:API headers. There is no IMS login,
  automatic refresh or multi-user login. ALM configuration and upstream errors are explicit.
- The retained loopback compose demo returns `{ meta, layout, blocksData }`; the frontend does not
  consume this local contract. Public Runtime compose-plan remains closed.
- The shared helper provides token-scoped recommendation preferences and bounded catalog reads.
  `npm run check:catalog` is an explicit read-only live check, not an index builder.
- **`achievements.next` is decided by `orchestrate`, not `learner-context`.** `learner-context` only
  reports `earned` (from ALM `userBadges`); it always returns `next: null`. Picking which achievement
  to surface next is a recommendation, not a fact — `orchestrate` decides it using the learner's role,
  `behavior-profile` interests, and `retrieval` recommendations. This will need a new adapter call to
  ALM's account-wide `GET /badges` catalog (confirmed to exist; not yet wired) so `orchestrate` knows
  what's earnable in the first place.

---

## Key data shapes

### `learner-context` output (no `goal`)

```jsonc
{
  "profile":  { "userId": "…", "roles": ["Learner", "Author"], "skillLevels": [ { "skillId": "602476", "skillName": "…", "level": "1", "levelName": "Level 1", "pointsEarned": 300 } ] },
  "progress": {
    "active": 3,
    "completedIds": ["course:111", "learningProgram:444"],
    "byCourse": [ { "loId": "course:222", "title": "…", "progressPercent": 80, "state": "STARTED", "lastAccessDate": "…", "dueDate": null } ],
    "byLearningProgram": [ { "loId": "learningProgram:444", "title": "…", "progressPercent": 100, "state": "COMPLETED", "lastAccessDate": "…", "dueDate": null } ]
  },
  "cohorts": [ { "id": "learningProgram:164727", "name": "…", "sessionDate": "…", "startsInDays": 1, "requiredAssets": ["lo-web-sdk-fundamentals"] } ],
  "enrollments": [ { "loId": "course:222", "title": "…", "type": "course", "progressPercent": 80, "state": "STARTED", "completionDeadline": null } ],
  "achievements": { "earned": ["eds-fundamentals"], "next": null }
}
```
**`loType` is the split**: every `course`-typed enrollment stays in `progress`/`enrollments`; every
`learningProgram`-typed enrollment is also a cohort. A learner can be enrolled in more than one
learningProgram at once — confirmed live (one real account had four) — so `cohorts` is an array, not
a single nullable `cohort`. (Earlier versions of this doc treated only `"cohort"`-tagged
learningPrograms as cohorts and used a singular `cohort` field; that's been replaced by this simpler
type-based rule.)

`progress` itself spans **both** courses and learningPrograms — `active`/`completedIds` count
everything enrolled, split out into `byCourse` (courses only) and `byLearningProgram` (learningPrograms
only) for the per-item detail. `enrollments` (the flat array) stays course-only; a learningProgram's
detail lives in `cohorts` instead, which carries fields (`sessionDate`, `requiredAssets`) courses
don't have.

**Enrollments query (`api.js`) uses two flags that matter downstream:**
- `include=loInstance` → each cohort's `sessionDate`/`startsInDays` come from the enrolled instance's
  `startDate`, inline in the enrollments response (no separate `/learningObjects` call). Populated for
  scheduled/Virtual-Classroom cohorts; `null` for self-paced ones (correct, not a gap).
- `includeHierarchicalEnrollments=true` → sub-courses nested inside a program surface as their own
  enrollments, so `completedIds` reflects **real sub-course completion** — this is what lets retrieval
  compute an accurate "X of Y prep items done" per cohort. (Verified live: a sub-course completion
  appeared in `completedIds` only with this flag on.)
- **Enrollment pagination:** follows `links.next` across the same ALM origin and enrollment endpoint,
  merging included resources before normalization. Cycles, off-endpoint links, and failed pages
  reject the fetch so the action uses its explicit degraded/safe response rather than partial context.

`achievements.next` is always `null` out of `learner-context` — `orchestrate` decides it (see Current
scope / status). Downstream depends on exact names `progress.completedIds` and `cohorts[].id` — do not rename.
Legacy degraded output for non-ALM internal failures:
`{ profile:{userId:null,roles:[],skillLevels:[]}, progress:null, cohorts:[], enrollments:[], achievements:null, contextDegraded:true }`.
ALM helper errors return explicit non-success responses instead.

`profile.skillLevels` comes from `GET /users/{id}/userSkills?include=skill,skillLevel` — the
**authoritative** per-skill source (name, level, levelName, and `pointsEarned` all inline, one call).
It is per-skill (an array), sorted by `pointsEarned` desc (strongest first). If a learner holds more
than one level for the same skill, only the **highest** survives — one entry per skill. Represents
"what the learner is best in". (Earlier versions derived this from `userBadges` skillLevel-type
badges, which only caught skills that happened to have a badge — live testing showed it missed 6 of a
learner's 7 real skills; `userSkills` fixes that. `userBadges` is now used only for `achievements.earned`.)

### `retrieval` output

```jsonc
{
  "candidates": [
    // ranked shortlist; tiers in priority order: continue -> cohort-prep -> skill-next -> related
    { "loId": "course:222", "title": "…", "type": "course", "tier": "continue", "reason": "40% complete", "score": 60 },
    { "loId": "learningProgram:164727", "title": "…", "type": "learningProgram", "tier": "cohort-prep",
      "sessionDate": "…", "startsInDays": 5,
      "prep": { "total": 2, "completed": 1, "items": [ { "loId": "course:333", "completed": true }, … ] },
      "reason": "cohort — 1 of 2 prep items done", "score": 5 }
    // … skill-next (catalog by the learner's skills) / related (relatedLOs of recent courses) …
  ],
  "cohorts": [ /* ALL cohorts (open + completed), each enriched with status + the same prep rollup */ ]
}
```
Deterministic, **no LLM** (rules-before-AI). `continue` + `cohort-prep` come purely from
`learner-context` (no network); `skill-next` queries the catalog by the learner's `skillLevels`, and
`related` fetches `relatedLOs` of the learner's recent courses (content-based; replaced ALM's PRL
`sort=recommendation`, which 400s on our accounts). Discovery tiers **degrade to empty** if their
calls have optional discovery failures and never re-surface completed or already-enrolled loIds.
Configuration, identity, authorization and other fatal ALM failures return explicit errors.
`retrieval` ranks **relevance only** — eligibility is still `policy-guard`'s call later.

Ranking policy (`rank.js`): tiers in the order above; within a tier, lower `score` ranks higher. Each
tier is capped (`perTier`, default 5) so a skill with dozens of catalog matches can't crowd out other
tiers, with an overall `limit` (default 20). **cohort-prep session ordering: upcoming sessions
(soonest `startsInDays` first) → self-paced (no session) → past sessions last** — a session that
already happened is stale as "prep" and must never outrank an upcoming one.

### Proposed `orchestrate` output (before policy-guard; not implemented)

```jsonc
{ "plan": { "steps": [ /* … */ ], "why": "…" }, "explanation": "…" }
```
If the model output isn't valid or `steps` isn't an array → return `fallbackPlan(catalogMatches)`
(today's catalog view), never an error.

---

---

## Config & environment

`app.config.yaml` defines the actions. No ALM credentials are accepted through action inputs.
The local Node backend reads `ALM_ACCESS_TOKEN` from its server environment. Runtime manifest
inputs do not populate `process.env`; internal actions stay unconfigured unless approved server
environment/secret-store integration is supplied. The public compose-plan action receives no
ALM credentials and returns 503 until endpoint access control is approved and configured.
Set `CORS_ORIGIN` to one exact approved frontend origin; only matching request origins receive CORS
access; CORS is not access control. Missing/wildcard configuration grants no browser access. All
`compose-plan` responses set `Cache-Control: private, no-store` and vary by Origin.

`.env` (local only, never committed):
```
ALM_API_BASE_URL=https://learningmanager.adobe.com/primeapi/v2
ALM_ACCESS_TOKEN=<manually-supplied-alm-access-token>
PL_LOCAL_PORT=9080
```

---

## Local dev loop

```bash
npm run start:alm       # loopback-only manual-token backend
# EDS site in another terminal:
aem up --no-open --no-stop-other --html-folder drafts --html-mount /
```
Do not open or deploy the public compose-plan endpoint until an approved browser-compatible access
control is selected. Do not copy the ALM token into frontend configuration or browser storage.
For the manual-token integration, use `npm run start:alm`, then request
`http://127.0.0.1:9080/api/current-learner`. Restart the Node process after editing `.env`;
no local redeployment is required. Do not expose this local server publicly. A future public
host must inject secrets securely and enforce its own platform authentication/authorization.

---

## Blocking dependency: endpoint access control

The current App Builder manifest has `require-adobe-auth: false` for `compose-plan`, and the frontend
has no browser-safe credential/session integration. A shared key in JavaScript, query string,
or browser storage is not acceptable; CORS is not authentication. Therefore the public action returns
503 without fetching or returning ALM data. Before it can serve the frontend, select and configure a
browser-compatible access-control approach (for example, an authenticated same-origin application gateway or a
short-lived server-issued session). The chosen approach must be usable by this EDS frontend without
embedding a shared secret.

The internal ALM adapter remains available for explicitly authorized local backend checks. Its
configured `ALM_ACCESS_TOKEN` is scoped to a single ALM learner, so any future frontend display must
be labeled as that account's data, not the browser visitor's data. Do not run live checks without
explicit approval and a secure `.env` configuration.

---

## Testing

- The frontend does not load demo fixtures because the public backend endpoint is intentionally
  unavailable. Backend unit tests use synthetic ALM-shaped objects and stubbed fetch.
- `test/learner-context.test.js` covers:
  - `normalizeLearnerContext`'s pure transform logic, against small literal ALM-shaped objects
    (synthetic, for exercising the parsing logic only — not personas, not real captures).
  - `main()`'s explicit configuration errors and degraded-context path for non-ALM failures.
  - The internal action's normalization and degraded response, tested with injected synthetic data.
- `test/compose-plan.test.js` verifies public compose-plan stays closed (503), makes no upstream
  requests and returns uncached responses.
- `test/alm.test.js` covers credential isolation, JSON:API headers, identity/account/roles,
  preferences, course metadata reads, safe bounded catalog pagination and explicit upstream errors.
- `test/current-learner-server.test.js` covers the loopback current-learner HTTP route.
- The prepare/continue/recover/achievement/learn scenario coverage the original personas were meant to
  give is still a gap — nothing here exercises an overdue/"recover"-style state, for example. If that
  matters, it'd need either more literal-fixture cases or real accounts in different states.
- Manual live checks can read the configured ALM account. Do not run them unless explicitly approved.

---

## Do NOT

- Return HTML, or move rendering/layout decisions into this service.
- Expose ALM account data through the public action before endpoint access control is approved.
- Call the LLM anywhere except `orchestrate`.
- Let `policy-guard` be bypassed or let AI override eligibility.
- Read raw behavioral events outside `behavior-profile`.
- Hardcode secrets or endpoint URLs.
- Add a `goal` to `learner-context` while it's out of scope.

---

## Glossary

- **Sequence** — Proposed Runtime chain of actions; not currently implemented.
- **compose-plan** — disabled public Runtime endpoint; the EDS frontend does not call it.
- **PL API / ALM** — Premium Learning / Adobe Learning Manager learner-state API.
- **Degraded context** — minimal valid output when PL is unreachable, so the sequence still runs.
- **fallbackPlan** — deterministic catalog view returned when the LLM output is unusable.
