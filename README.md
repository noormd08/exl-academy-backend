# premiumLearning

Welcome to my Adobe I/O Application!

## Audience of ONE POC status

The ALM integration uses a manually supplied server-environment `ALM_ACCESS_TOKEN` with
`Authorization: Bearer <token>`. It identifies the learner returned by ALM `/user`, not the
EDS visitor. Everyone using the prototype acts as that one configured learner. This is
not multi-user authentication. No IMS login, OAuth redirect/exchange, or automatic refresh
is implemented. See [Manual-token ALM setup](#manual-token-alm-setup).

The current public `compose-plan` endpoint is intentionally **unavailable (503)**. The
Runtime manifest does not provide a safe browser-usable access-control mechanism,
and the frontend must not contain a shared secret. CORS is origin policy, not authentication.
The handler does not call ALM, even if an ALM token is configured. It returns an uncached
error only. The frontend no longer reads demo fixtures; its personalized blocks stay hidden
until an approved access-control approach is selected and implemented.

The current frontend expects `{ meta, layout }`, but its plan and content helpers remain
closed. The loopback demo can compose `{ meta, layout, blocksData }` for the four blocks;
this is not wired into the frontend or approved as the public content contract. Do not
expose ALM data publicly until access control and that contract are approved.
No LLM, behavior profile, or policy guard is implemented.

The separate local-only synthetic For You demo described below does use an LLM and
preset behavior. It does not change the closed public action or call ALM.

## Local synthetic For You demo

The demo has three fictional personas and fictional courses. It sends their interests,
preset activity, progress and the entered query to Gemini; it uses no ALM data or RAG.
Do not enter sensitive information into its query. It does not authenticate users and
must not be exposed publicly. It is not a fallback for ALM errors.

Add these values to the existing ignored backend `.env` file:

```dotenv
GEMINI_API_KEY=<your-google-ai-studio-api-key>
GEMINI_MODEL=gemini-3.5-flash-lite
```

```sh
npm run start:mock-for-you
```

The server binds to `127.0.0.1:9081`, independently of the ALM server, and needs no ALM
token. Restart it after changing the environment. The frontend demo uses port 9081;
the optional `MOCK_FOR_YOU_PORT` server setting requires a matching frontend change.
See the frontend README for the opt-in page URL. Gemini errors are reported explicitly;
the service never silently returns mock recommendations when generation fails.

`POST /api/mock-for-you` accepts `{ "personaId": "new-learner", "query": "" }` and
returns one JSON array: ordered `{ type: "section", index, html }` events, followed
by `{ type: "suggestions", items }`, a `{ type: "debug", timings, pipeline }`
summary, and `{ type: "done", title, usedCourses }`. This is not a streamed response.
The backend fills server-controlled HTML templates with escaped section and course data.
The frontend validates and decorates the populated markup. Suggestions are included in the
response but not shown in the UI.
Debug timing covers generation and response construction; it does not contain prompts,
API keys or learner data. The debug retrieval label refers to the mock catalog, not RAG.

Run synthetic offline validation without credentials:

```sh
npm test -- --runInBand
npm run lint
```

Unit tests cover the closed public endpoint, current-learner HTTP route, environment-only
ALM client, synthetic normalization/pagination, layout, course ordering, cohort readiness
and safe failures. They do not verify deployed Runtime configuration or call live ALM.
The configured Runtime is Node 22; offline tests run locally on Node 20.

- `CORS_ORIGIN` must be one exact approved frontend origin; missing/wildcard values grant
  no browser access. Even correct CORS does not authenticate callers.
- Enrollment pagination follows same-endpoint links, merges included resources, and rejects
  cycles or failed pages instead of silently returning partial context.
- Partial in-progress courses rank by highest completion first. Past sessions and completed
  cohorts cannot trigger preparation mode. No "imminent" cutoff has been agreed.
- Goal change remains out of scope without an approved goal source/contract.
- Do not deploy or enable the public endpoint until a browser-safe access-control method has
  been approved and configured.

## Setup

### Manual-token ALM setup

Use Node.js 20 or newer. From this backend directory, create a local `.env` file with
placeholder values replaced locally only:

```dotenv
ALM_API_BASE_URL=https://learningmanager.adobe.com/primeapi/v2
ALM_ACCESS_TOKEN=<manually-supplied-alm-access-token>
PL_LOCAL_PORT=9080
```

`.env*` files are excluded by `.gitignore`. Do not put this token in frontend configuration,
browser storage, request parameters, source code, screenshots, logs or shell commands.
The old `PL_API_KEY` / `PL_API_BASE` action parameters are no longer supported.

```sh
npm run start:alm
```

The backend binds only to `127.0.0.1`; there is no public-host option.

```sh
curl --fail-with-body http://127.0.0.1:9080/api/current-learner
```

Every current-learner request validates the token using `GET /user` with
`Accept: application/vnd.api+json` and `Content-Type: application/vnd.api+json`.
The response contains only the returned learner ID/name/roles, account ID/name, and
`dataScope: "configured-alm-learner"`. Learner ID, account ID and a valid roles array are
required; incomplete identity responses fail explicitly. Optional names are `null` when
ALM does not supply them.
Frontend-supplied learner IDs and tokens are ignored. Subsequent helper operations use the
token-associated identity; badges/skills never accept a caller-selected learner ID.
Responses use `Cache-Control: private, no-store`.

The shared helper also exposes read-only `getRecommendationPreferences()`, scoped to the
learner returned by `/user`: `GET /users/{U}/recommendationPreferences`. Its
`data.attributes.products` and `data.attributes.roles` describe product/role preferences
usable as interest signals. Recommendation roles are not the permission roles from
`/user`. This does not depend on the original EXL profile API and does not change the
existing learner-context or My Hub contracts. An empty enrollment/skill response means
no learning history was returned, not that progress or cohort readiness can be inferred.

### Read-only catalog verification

```sh
npm run check:catalog
```

This command uses only the configured token, never original EXL authentication or origins.
It enumerates `/catalogs` through same-endpoint `links.next` (bounded to 100 pages), then
samples `/learningObjects` with `filter.loTypes=course`, two pages of ten items each.
It checks up to ten returned catalog IDs, or only `ALM_PUBLIC_CATALOG_ID` when configured,
using `filter.catalogIds`, and verifies selected `/learningObjects/{fullLoId}` details.
No RAG index, enrollment or other mutation is created.

The report includes fetched counts, title/description availability, locale, duration,
tags, product metadata and included skill/instance resource types. Description text,
resource/download URLs, tokens and raw upstream errors are not logged or saved.
`meta.complete: false` explicitly means the course result is a bounded sample, not the
entire catalog. A failed page throws instead of becoming an empty successful result.
Pagination rejects cycles, foreign hosts/protocols, credentials, fragments, endpoint
changes and catalog/filter changes; cursor-only links retain the original filters.
HTTP 429 stops requests without automatic retries.

Catalog visibility reflects this token's permissions, including any administrator roles;
it does not establish general learner enrollment eligibility or approval to send catalog
text to an external model. Before RAG ingestion, choose the approved catalog IDs explicitly,
review description coverage/quality and define how missing descriptions are handled.
The verification command does not select or persist a production/public catalog for you.

| Failure | Result |
|---|---|
| Missing token or invalid base URL | HTTP 503 with a clear configuration error; no ALM request |
| ALM HTTP 401 | HTTP 401: token invalid/expired; replace the secret manually and restart |
| ALM HTTP 403 | HTTP 403: insufficient permissions |
| ALM HTTP 429 | HTTP 429: rate limited; stop and try again later without automatic retries |
| Network timeout, malformed JSON or other upstream failure | HTTP 502 with a sanitized error |

Requests have a bounded timeout, do not follow redirects, and are not automatically retried.
No mock learner is substituted. Bearer authentication is intentional for this integration;
there is no automatic switch to the former `oauth` header. Live acceptance of the manually
provided token must be verified in your ALM account.

**Token replacement:** edit the backend-only `.env` file, stop this Node process and run
`npm run start:alm` again. The file is loaded at process startup, so a restart is required;
no local redeployment is needed. There is no refresh endpoint or refresh timer.

**Hosting boundary:** this setup is local-only, as agreed. Do not tunnel it, reverse-proxy it
publicly, or expose it on a shared network without the hosting platform's authentication
and authorization in front of every learner-data route. Loopback is not isolation from other
users/processes on the same machine; use a trusted development host. Origin/Host checks
mitigate browser misuse, but CORS is not authentication.

**Adobe I/O Runtime:** the public `compose-plan` action remains closed and this endpoint is
not added as a public Runtime action. Manifest `inputs` are not Node environment variables;
`aio app deploy` does not install this manually supplied secret into `process.env`.
ALM credentials were removed from action inputs. Internal ALM actions now fail explicitly
if the server environment is unconfigured. A future hosted deployment requires approved
environment/secret-store injection plus platform-native caller authorization; secret rotation
must follow that platform's restart/redeployment rules. Do not deploy the local `.env` file
or reintroduce client-overridable credential parameters.

The existing local compose route remains available for backend development and uses this
same environment-only helper. The frontend and original application's auth endpoint/origin
are not required by `/api/current-learner`; `curl` works without an Origin header.

## Local Dev

- `aio app run` to start your local Dev server
- App will run on `localhost:9080` by default

By default the UI will be served locally but actions will be deployed and served from Adobe I/O Runtime. To run your actions locally use the `aio app dev` option.

For more information on the difference between `aio app run` and `aio app dev`, see [here](https://developer.adobe.com/app-builder/docs/guides/development/#aio-app-dev-vs-aio-app-run)

## Test & Coverage

- Run `aio app test` to run unit tests for ui and actions
- Run `aio app test --e2e` to run e2e tests

## Deploy & Cleanup

- `aio app deploy` to build and deploy all actions on Runtime and static files to CDN
- `aio app undeploy` to undeploy the app

## Config

### `.env`

You can generate this file using the command `aio app use`. 

```bash
# This file must **not** be committed to source control

## please provide your Adobe I/O Runtime credentials
# AIO_RUNTIME_AUTH=
# AIO_RUNTIME_NAMESPACE=
```

### `app.config.yaml`

- Main configuration file that defines an application's implementation. 
- More information on this file, application configuration, and extension configuration 
  can be found [here](https://developer.adobe.com/app-builder/docs/guides/configuration/#appconfigyaml)

#### Action Dependencies

- You have two options to resolve your actions' dependencies:

  1. **Packaged action file**: Add your action's dependencies to the root
   `package.json` and install them using `npm install`. Then set the `function`
   field in `app.config.yaml` to point to the **entry file** of your action
   folder. We will use `webpack` to package your code and dependencies into a
   single minified js file. The action will then be deployed as a single file.
   Use this method if you want to reduce the size of your actions.

  2. **Zipped action folder**: In the folder containing the action code add a
     `package.json` with the action's dependencies. Then set the `function`
     field in `app.config.yaml` to point to the **folder** of that action. We will
     install the required dependencies within that directory and zip the folder
     before deploying it as a zipped action. Use this method if you want to keep
     your action's dependencies separated.

## Debugging in VS Code

While running your local server (`aio app dev`), both UI and actions can be debugged. To do so follow the instructions [here](https://developer.adobe.com/app-builder/docs/guides/development/#debugging)

## Typescript support for UI

To use typescript use `.tsx` extension for react components and add a `tsconfig.json` 
and make sure you have the below config added
```
 {
  "compilerOptions": {
      "jsx": "react"
    }
  } 
```
