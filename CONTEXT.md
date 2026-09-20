# CLAUDE.md — `audience-of-one` backend

Working guide for anyone (human or agent) building in this repo. Read this before editing.
Also valid as `AGENTS.md`. Source of truth for architecture is the lead's *POC Technical Getting
Started* guide; if this file and that guide ever disagree, the guide wins — update this file to match.

---

## What this repo is

The **Audience of ONE** backend: an **Adobe App Builder / Adobe I/O Runtime** service that takes one
logged-in learner, gathers their learning context from Premium Learning (Adobe Learning Manager),
decides the most useful next learning action, and returns it as **JSON** for the EDS frontend to render.

- **Frontend:** Edge Delivery Services (separate repo). Renders. Not here.
- **Authoring:** Universal Editor. Owns block structure. Not here.
- **This repo:** decide only. **Never returns HTML.**

---

## Golden rules (apply to every change)

1. **Return JSON, never HTML.** Universal Editor owns visual structure; this service returns data.
2. **Never break the page.** On any failure, return a valid, minimal response so My Hub stays usable.
   No unhandled 500s reaching the browser. Actions degrade; the sequence keeps running.
3. **Validate the IMS token server-side. Never trust a `learnerId` from a query param.** Use the
   `userId` that IMS returns.
4. **Secrets stay server-side.** `.env` locally, workspace secure config on stage/prod. Never in the
   repo, responses, or logs.
5. **Isolate the real APIs.** All knowledge of an upstream API lives in one adapter function. If its
   shape changes, exactly one file changes.
6. **Rules before AI; AI is optional and flagged.** Deterministic logic and the `fallbackPlan` must
   produce a usable result with the LLM switched off. AI never touches eligibility or (later) layout.
7. **Keep actions single-purpose.** Each action does its one job; don't collapse layers together.

---

## Architecture — the Runtime sequence

Five internal actions chained as one sequence, exposed through a single public entry point. Each
action's output merges into the next automatically.

```
compose-plan            (public, web:yes)  ← the ONLY endpoint the EDS block calls
  └─ learner-context    (layer 2)  validate IMS, fetch + normalize learner facts
     └─ behavior-profile(layer 2)  aggregate raw signals → interest weights (may return null)
        └─ retrieval     (layer 3)  rank catalog candidates (no LLM here)
           └─ orchestrate(layer 4+5) LLM builds the plan; validate JSON; fallbackPlan on failure
              └─ policy-guard(layer 6) enforce enrollment/eligibility LAST, before response
```

Every action except `compose-plan` is `web: 'no'`. `orchestrate` gets a longer timeout (30s).

### Per-action responsibility

| Action | Job | Must not |
|---|---|---|
| `learner-context` | IMS-validate; fetch learner state; return normalized context | call LLM; rank; include a goal (current scope); decide `achievements.next` |
| `behavior-profile` | aggregate raw events → `{ interests, segment }`; return `null` if none | read raw events downstream; block if absent |
| `retrieval` | produce ranked catalog candidates from context + profile | call LLM; reason about a plan |
| `orchestrate` | build `{ plan, explanation }` via LLM; validate; fallback; decide `achievements.next` (role + interests + recommendations) | trust raw model output; skip JSON validation |
| `policy-guard` | drop steps the learner isn't eligible for; run last | let AI override policy |

---

## Current scope / status

- **Build order / status:** `learner-context` ✅ and `retrieval` ✅ are built. Still to do: EDS block +
  a public `compose-plan` entry point, `orchestrate`, `policy-guard`, Universal Editor fragment, then
  measurement. Behavior capture (`behavior-profile`) is optional and last.
- **ALM adapter is shared.** All ALM endpoint/auth knowledge lives in `actions/shared/alm.js`
  (`almClient`), imported by both `learner-context` and `retrieval` (golden rule #5).
- **Goal is OUT of `learner-context` for now.** Do not read/store/return a goal there. Context is
  learning *facts* only: profile, progress, cohorts, enrollments, achievements.
- **Update: no more mock mode.** `USE_MOCK`/fixture-replay was removed — `learner-context` always
  calls the real ALM API now (`api.js` has no mock branch, `app.config.yaml`/`.env` have no
  `USE_MOCK`). The learner-state API is confirmed (see Blocking dependency); testing is done with
  small literal ALM-shaped objects in `test/learner-context.test.js` (pure-function unit tests) plus a
  routed-fetch end-to-end test, not real captures or fixture files.
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
    "byCourse": [ { "loId": "course:222", "title": "…", "progressPercent": 80, "state": "STARTED", "lastAccessDate": "…" } ],
    "byLearningProgram": [ { "loId": "learningProgram:444", "title": "…", "progressPercent": 100, "state": "COMPLETED", "lastAccessDate": "…" } ]
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
- **Open TODO — pagination:** the enrollments call reads only the first page (ALM default ~10). With
  hierarchical sub-courses now included, accounts with many enrollments will overflow one page and
  silently drop items from `completedIds`/`cohorts`. Following `links.next` is not yet wired.

`achievements.next` is always `null` out of `learner-context` — `orchestrate` decides it (see Current
scope / status). Downstream depends on exact names `progress.completedIds` and `cohorts[].id` — do not rename.
Degraded output (PL failed): `{ profile:{userId,roles:[],skillLevels:[]}, progress:null, cohorts:[], enrollments:[], achievements:null, contextDegraded:true }`.

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
calls fail (the action never throws) and never re-surface completed or already-enrolled loIds.
`retrieval` ranks **relevance only** — eligibility is still `policy-guard`'s call later.

Ranking policy (`rank.js`): tiers in the order above; within a tier, lower `score` ranks higher. Each
tier is capped (`perTier`, default 5) so a skill with dozens of catalog matches can't crowd out other
tiers, with an overall `limit` (default 20). **cohort-prep session ordering: upcoming sessions
(soonest `startsInDays` first) → self-paced (no session) → past sessions last** — a session that
already happened is stale as "prep" and must never outrank an upcoming one.

### `orchestrate` output (final, before policy-guard)

```jsonc
{ "plan": { "steps": [ /* … */ ], "why": "…" }, "explanation": "…" }
```
If the model output isn't valid or `steps` isn't an array → return `fallbackPlan(catalogMatches)`
(today's catalog view), never an error.

---

## Auth flow (IMS)

EDS page is static and carries no session, so:
1. The EDS block reads the learner's IMS access token client-side and sends it as `Authorization: Bearer <token>`.
2. `learner-context` extracts it from `params.__ow_headers.authorization`.
3. It validates against `https://ims-na1.adobelogin.com/ims/profile/v1` and uses the returned `userId`.
4. Missing token → 401; invalid → 401; IMS unreachable → 502.

---

## Config & environment

`app.config.yaml` defines the actions and the `compose-plan` sequence; internal actions are `web:'no'`.
Enable CORS on `compose-plan` for the EDS preview/stage/prod origins or the browser blocks the block's fetch.

`.env` (local only, never committed):
```
PL_API_BASE=https://learningmanager.adobe.com/primeapi/v2
PL_API_KEY=         # ALM oauth token; workspace secret on stage/prod. See Blocking dependency —
                     # currently scoped to one account, not per-learner.
LLM_API_KEY=        # workspace secret; orchestrate only
AI_ENABLED=false    # rules/fallback path is the default until proven
```

---

## Local dev loop

```bash
aio app run --local     # actions run on your machine, no deploy
# EDS site in another terminal:  aem up
aio app deploy          # deploy to the stage workspace when ready
```
Point the EDS block's endpoint at `http://localhost:9080/...` while iterating; switch to the deployed
stage URL before pushing. Keep endpoint URLs in a config sheet, not hardcoded.

---

## Blocking dependency (confirm before wiring live)

**Update:** the learner-state API is now confirmed — it's Adobe Learning Manager (ALM) Prime API v2
(`https://learningmanager.adobe.com/primeapi/v2`, `Authorization: oauth <token>`). `learner-context`
has been built and verified live against it (see `actions/learner-context/api.js`).

**New blocker found while verifying live, replacing the old one:** every ALM call is scoped to
whoever the `PL_API_KEY` oauth token belongs to — `GET /users/{id}/userBadges` returns 400 ("User
mismatch") for any id other than the token owner's own ALM id. **A single fixed `PL_API_KEY` cannot
serve different learners** browsing the EDS page; it only ever returns its own owner's data. Before
wiring this into `compose-plan`, need one of:
- an ALM admin-scoped credential able to query arbitrary user ids, or
- a per-learner token exchange (IMS token → ALM-scoped token) at request time.

**Update — the sibling EDS frontend repo (`premium/scripts/utils/`) already solves the second option.**
Confirmed there:
- ALM has **no separate dev/QA tenant** — `almApiBaseUrl` is the same
  `https://learningmanager.adobe.com/primeapi/v2` across all four of its environments
  (development/qa/staging/production). Environment separation there is by `almClientId`/`almAccount`
  per env, not by hostname. So seeing "prod" data from `PL_API_BASE` is expected, not a bug — there's
  nowhere else to point it.
- It does a **real per-user IMS → ALM token exchange at runtime**, via ALM's OAuth authorize endpoint
  (`almAuthEndpoint: https://learningmanager.adobe.com/oauth/o/authorize`, see `auth-utils.js`), then
  uses that learner-scoped ALM token for their ALM calls — this is exactly the missing piece for our
  multi-learner scoping problem.

**Verified live: per-learner ALM tokens do scope correctly.** Pulled the `alm_access_token` /
`alm_user_id` cookie pair from a real logged-in session on `experienceleague-dev.adobe.com` and used
the token as `PL_API_KEY` — ALM returned `userId: 30851407` with the exact same `roles` as the
captured fixtures, i.e. a *different* token correctly returned a *different, correctly-scoped* user's
data. This confirms the token-exchange approach works in principle. Still open: whether ALM's OAuth
authorize endpoint (`almAuthEndpoint`) supports a server-to-server exchange (no browser redirect) —
the sibling repo's flow runs client-side, and a browser cookie isn't a mechanism `learner-context` (a
Runtime action, no browser) can reuse in production; it only proved the *concept*, not a server-side
path to it. That flow still needs investigating before relying on it here.

Also still open: does App Builder's egress IP range need allow-listing (`aio runtime ip-list get`);
who owns rate limits/quota for this credential. **Update: mock mode was removed** —
`learner-context` now always calls the real ALM API with whatever single `PL_API_KEY` is configured,
so until the scoping question above is resolved, it only ever returns that one credential's own data
for every learner.

---

## Testing

- **No mock mode, no fixture files, no personas.** Both the fabricated personas (Priya/Sam/Alex/Mia/
  Dev in `mocks/`) and the later real-captured ALM samples (`test/*.json`) were removed.
  `learner-context` always calls the real ALM API — there is nothing to test against personas or
  captures anymore.
- `test/learner-context.test.js` (11 tests) covers:
  - `normalizeLearnerContext`'s pure transform logic, against small literal ALM-shaped objects
    (synthetic, for exercising the parsing logic only — not personas, not real captures).
  - `main()`'s auth paths (401 missing/invalid token, 502 IMS unreachable) via a mocked `fetch`.
  - `main()`'s degraded-context path when `PL_API_BASE` is unset.
  - One end-to-end success test that routes a mocked `fetch` by URL substring across the real call
    sequence (IMS profile → ALM `/user` → `/enrollments` → `/userBadges` → `/skills`), asserting the
    full normalized shape.
- The prepare/continue/recover/achievement/learn scenario coverage the original personas were meant to
  give is still a gap — nothing here exercises an overdue/"recover"-style state, for example. If that
  matters, it'd need either more literal-fixture cases or real accounts in different states.
- Manual live checks (hit the real ALM API, no fixtures involved): `npm run check:api` (ALM
  only, bypasses IMS) and `npm run check:learner-context` (full `main()`, needs a real
  `IMS_TEST_TOKEN`).

---

## Do NOT

- Return HTML, or move rendering/layout decisions into this service.
- Trust a client-supplied learner id.
- Call the LLM anywhere except `orchestrate`.
- Let `policy-guard` be bypassed or let AI override eligibility.
- Read raw behavioral events outside `behavior-profile`.
- Hardcode secrets or endpoint URLs.
- Add a `goal` to `learner-context` while it's out of scope.

---

## Glossary

- **Sequence** — Runtime chain of actions; each output merges into the next.
- **compose-plan** — the single public endpoint the EDS block calls.
- **IMS** — Adobe Identity Management; source of the validated `userId`.
- **PL API / ALM** — Premium Learning / Adobe Learning Manager learner-state API (unconfirmed).
- **Degraded context** — minimal valid output when PL is unreachable, so the sequence still runs.
- **fallbackPlan** — deterministic catalog view returned when the LLM output is unusable.
