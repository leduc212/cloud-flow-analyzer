# Cloud Flow Analyzer — Project Plan

> **Speed and resource recommendations for Power Automate cloud flows, right in your browser.**
> A browser extension (Edge/Chrome) that reads your flows and their recent runs, finds slow or wasteful patterns, and tells you how to fix them.

Status: v0.1 (pane shipped; rule tuning waits on the 20+ flow capture) · Drafted 2026-09-25 · Revised 2026-09-25 after review and owner decisions (see §12) · Owner: LEMD (leduc212)

---

## 1. Goals and non-goals

### Guiding principle
**Simple but efficient.** The main feature is recognising bad patterns in a flow and recommending the better, optimised pattern. Everything else (run data, scores, environment views) exists to make those recommendations more accurate or easier to act on. When a feature doesn't serve that, leave it out.

### Goals
1. **Get flows:** list every cloud flow the signed-in user can see in an environment: *My flows*, *Shared with me*, solution flows, and, for environment admins, all flows in the environment.
2. **Analyse a flow:** parse its definition into an action tree and run a rule engine that finds anti-patterns hurting **speed**, **resource use** (Power Platform requests) and **reliability**.
3. **Use real run data where it helps:** sample recent runs to measure which actions take the time, how many loop iterations happen and how many throttled retries occur. Rank findings by measured impact.
4. **Recommend fixes:** every finding explains *why* it matters, *how* to fix it, and shows the better pattern.
5. **Stay simple and free:** runs entirely in the browser, no servers, no app registration, $0.

### Non-goals (deliberate)
- Editing or changing flows. The extension is **read-only**.
- Monitoring, alerting, scheduled scans or dashboards over time.
- Any link to dataverse-trace (separate project, no correlation).
- Desktop flows (Power Automate Desktop) and Logic Apps. Possible later.
- Government and sovereign clouds (GCC, GCC High, DoD, China). Commercial cloud only for now.

### Working preferences (carried over from the owner's other project)
- $0 to build and run. GitHub only (Pages, Actions, Releases). No Azure, no paid services, no Entra ID app registration.
- Plain, descriptive naming. Keep "Power Automate" out of the product name; use it only in taglines ("for Power Automate").
- Assistants commit and push to their working branch. The owner reviews and merges.

---

## 2. Research summary (why a browser extension)

### Where the data lives
| Data | Source | Notes |
|---|---|---|
| Solution flow definitions | Dataverse `workflow.clientdata` (JSON) | Reachable with a Dataverse session |
| Non-solution flows ("My flows") | **Not in Dataverse**, only via the Power Automate API | https://learn.microsoft.com/en-us/power-automate/manage-flows-with-code |
| Run-level history | Dataverse `flowrun` (solution flows only, 28-day default retention, not guaranteed complete) | https://learn.microsoft.com/en-us/power-automate/dataverse/cloud-flow-run-metadata |
| **Per-action timings, loop repetitions, retries** | **Power Automate API only** | `flowlog` has no cloud-flow action log type (its types are desktop flow, work queue, custom and CUA logs) |

**Conclusion:** the most valuable data (which action takes the time) needs a token for the Power Automate API. A browser extension can **reuse the token the maker portal already uses**. No app registration, no cost, and it covers every flow the user can see.

### Proven token approach
[Power Automate Tools](https://github.com/rithala/power-automate-tools) (a Manifest V3 extension) uses `chrome.webRequest.onBeforeSendHeaders` with `["requestHeaders"]` on `https://*.api.flow.microsoft.com/*` and `https://*.api.powerplatform.com/*`. It reads the `Authorization` header from the portal's own requests and keeps it per tab. It tracks both hosts: the portal is moving from `api.flow.microsoft.com` (api-version `2016-11-01`) to `api.powerplatform.com` (api-version `1`).
The two hosts use **different token audiences** (`https://service.flow.microsoft.com/` and `https://api.powerplatform.com`), so a token captured on one host can't be used on the other. Tokens are stored per host kind, together with the base URL they were captured on.
⚠ **Power Automate Tools is GPL-3.** Re-implement the approach; don't copy code (this project is MIT).

### Competitive landscape
| Tool | What it does | Gap this project fills |
|---|---|---|
| Flow Checker (built in) | Basic warnings | Shallow; no run data |
| Process insights (Microsoft, preview since 2023) | Per-action durations, common paths, bottlenecks | One flow at a time, owner only, preview; shows *where* time goes but not *what to change* |
| [FlowLens](https://github.com/Yolostream/FlowLens), [powerautomate-lint](https://github.com/verseblocks/powerautomate-lint), pp-lint | Rule checks on the definition | No run data, so findings can't be ranked by impact |
| [Flow Studio](https://awesome-copilot.github.com/skill/flowstudio-power-automate-monitoring/) | Paid online monitoring | Paid, data leaves the tenant, focused on failures |
| [Power Automate Tools](https://github.com/rithala/power-automate-tools) | JSON editor | An editor, not an analyzer |
| [Cloud Flow Viewer](https://rajeevpentyala.com/2025/10/16/new-tool-cloud-flow-viewer-for-power-automate-solutions/) | Lists flows in a solution | Inventory only |

**Positioning: findings ranked by measured impact.** Rules find the pattern; run data shows how much it costs; findings are sorted by payoff.

---

## 3. User experience

### Flow of use
**In the portal (main use, owner request 2026-09-25):**
1. The user opens a flow in make.powerautomate.com (or make.powerapps.com): its details page or the designer.
2. Clicks the extension icon. A **popup** offers: **Analyse this flow** (enabled on flow pages) and **Open capture tool** (later: the full app tab).
3. **Analyse this flow** opens an **analysis pane** on the right of the portal page: grade, category scores, estimated actions per run, and the findings, filterable by severity. Each finding expands to how to fix it, why it matters, before/after and Microsoft docs.
4. Clicking a finding's action **pans the designer to that action** and highlights it, first **expanding any collapsed scopes, loops or conditions** on its path (outermost first). It only clicks a toggle that says it is collapsed, or undoes the click if it can't tell and the click didn't help. If a parent still can't be opened (e.g. a collapsed Switch case), the pane pans to it and says so. A "Designer check" in the pane can be copied when the designer can't be found or moved.
5. When the user opens another flow, the pane offers to analyse it.

**Full app tab (v0.3):**
1. The app tab shows the environment picker (from the captured API) and the **Flows** list.
2. Picks a flow → **Flow report** (definition analysis, instant) → optional **Analyse runs** (samples the last N runs).

The extension reads the token's expiry time. Shortly before it expires (about 60–90 minutes after sign-in), it asks the user to keep a portal tab open or refresh it; new tokens are picked up automatically.

**How the pane works:** the popup asks the background worker to analyse the tab. The worker injects the pane (a content script with its UI in a shadow root), fetches the flow with the captured token, analyses it and sends only the result to the pane; the page never sees the token. The new designer is a React Flow canvas (`.react-flow__node[data-id="<action>"]`) that pans by transform, so the pane pans it the way a user does (dragging the empty canvas, then the scroll wheel), measuring after each step until the action is centred. The designer only draws nodes near the visible area (confirmed on the real designer: 8 of 100+ nodes in the DOM), so for an action that isn't drawn the pane walks the canvas: it centres on the drawn action closest in flow order (the pane gets the designer order from the analysis), looks further ahead and then sideways, opening collapsed parents as they appear, until the action is drawn; the classic designer scrolls, so `scrollIntoView` is used. Apart from opening collapsed containers on the way, it never clicks or edits anything in the designer.

### Screens
```
① Flows                        ② Flow report                          ③ Run profile
┌────────────────────────┐    ┌─────────────────────────────────┐    ┌──────────────────────────┐
│ Env: Contoso Dev   ▾   │    │ Sync Contacts to ERP     B (72) │    │ Run 08:14 · 6m 12s       │
│ 🔍 search   ⚙ filters  │    │ Speed C · Resources B · Rel. A  │    │ ▇▇▇▇▇▇▇▇▇ Apply_to_each 61%│
│ Name      Score Issues │    │ ~1,900 actions/run (est.)       │    │   Get_a_row ×1240        │
│ Sync Cont…  C    7     │    │ 🔴 SPD01 Loop runs one at a time│    │     p50 180ms · 3m 43s   │
│ Invoice a…  A    1     │    │ 🔴 SPD03 Get a row inside loop  │    │ ▇ List_rows 4%           │
│ Nightly c…  B    3     │    │ 🟠 RES02 Trigger fires on any   │    │ 429 throttled: 38 retries│
│  [Analyse all]         │    │    column change                │    │ Slowest actions ▸        │
└────────────────────────┘    │ Action tree (with timings) ▸    │    └──────────────────────────┘
                              └─────────────────────────────────┘
```

1. **Flows**
   - table: name, state, trigger type, source (mine / shared / admin), solution or not, last modified, score, issue count
   - search, filters, sorting
   - "Analyse all" runs definition-only analysis across the environment
2. **Flow report**
   - score overall and per category
   - estimated actions per run
   - findings sorted by severity × impact; each expands to why / how to fix / better pattern (before → after snippet)
   - action tree drawn like the designer (scopes, conditions, switch cases, loops), with finding badges on actions; clicking a finding highlights its action
3. **Run profile** (after "Analyse runs")
   - sample size, time range, success/failure split
   - slowest actions (median, 95th percentile, share of run time; see §7 for how shares are calculated)
   - loop iteration statistics; throttling retries (429) per action
   - 📊 findings updated with measured impact

Extras:
- Mark a finding as "accepted" (stored locally, excluded from the score).
- Copy the report as Markdown.
- Light and dark theme.

---

## 4. Rule catalogue

Each rule has: `id`, `category` (speed / resources / reliability / security / maintainability), `severity` (high / medium / low), `detect(tree, runStats?)`, `why`, `fix`, `example` (before/after), `docs` link.
📊 = the rule uses run data when available (and falls back to definition-only).
**In** = the milestone that ships the rule (definition-only version first where one exists).

**Connector matching.** Rules identify an action by connector **and** `operationId`, never `operationId` alone (`GetItem` exists in both SharePoint and Dataverse). The connector comes from `inputs.host.apiId`, or through `connectionReferences` using `host.connectionName` / `host.connection`. Query parameters also differ per connector (for example, SharePoint *Get items* has no `$select`; it limits columns with a view), so list rules use a per-connector parameter map.

### Speed
| ID | In | Detects | Recommendation |
|---|---|---|---|
| SPD01 📊 | v0.1 | Outermost `Foreach` (not inside another loop) with concurrency off (no `runtimeConfiguration.concurrency.repetitions`, or it's 1) that contains at least one connector, HTTP or child-flow action. Loops are sequential by default, and concurrency only takes effect on the outermost loop | Turn on concurrency (1–50). **Blocked by SPD02/REL01:** fix variable writes first |
| SPD02 | v0.1 | `SetVariable` / `AppendToArrayVariable` / `AppendToStringVariable` / `IncrementVariable` / `DecrementVariable` inside a sequential `Foreach` (in a concurrent loop this is REL01 instead) | Use **Select** / **Filter array** / **Compose** / `union()` / `join()`. Faster, and makes concurrency safe |
| SPD03 📊 | v0.1 | Per-item reads inside a `Foreach`: single-record reads (Dataverse *Get a row*, SharePoint *Get item*, Office 365 Users *Get user profile*…), or list queries whose parameters use the current item (N+1 queries). HTTP GET using the current item: lower confidence | Do one bulk query before the loop (`$filter`, `$expand`, FetchXML), then Filter array |
| SPD04 | v0.1 | Nested `Foreach` (inner loops always run one at a time) | Flatten with Select / `xpath()`, query the child rows with `$expand`, or move the inner loop into a child flow |
| SPD05 📊 | v0.2 (definition), v0.3 (📊) | Loop body is a single `If` on the loop item with an empty `else`. Later: run data shows most iterations take the empty branch | Move the condition into the source query `$filter`, or use Filter array before the loop |
| SPD06 | later | Independent actions chained one after another (no data dependency). Many false positives, because order often matters for side effects (create a record, then send an email). Low severity, low confidence, off by default | Run them as parallel branches |
| SPD07 📊 | v0.1 | A child flow (`Workflow` action) inside a loop | Send the whole batch to the child flow in one call |
| SPD08 | v0.1 | `Until` containing a `Wait`/Delay (polling) | Use a trigger or webhook, or a longer interval |
| SPD09 | v0.3 | The same record or endpoint read repeatedly; the same long expression repeated | Read or calculate once, then reuse via Compose |
| SPD10 | v0.1 | `Foreach` over the rows of a list query limited to one row (`$top` = 1) | Use `first()` and drop the loop |

### Resources (every action counts toward Power Platform request limits)
| ID | In | Detects | Recommendation |
|---|---|---|---|
| RES01 📊 | v0.2 ✅ | Event trigger (Dataverse or connector) with no `conditions`; the first top-level Condition only reads trigger data; in at least half of 5+ sampled succeeded runs, no connector / HTTP / child-flow call in or after it ran | Add a trigger condition. Runs that are filtered out never start |
| RES02 | v0.1 | Dataverse trigger (`SubscribeWebhookTrigger`) whose `subscriptionRequest/message` includes Update (3 = Modified, 4 = Added or Modified, 6 = Modified or Deleted, 7 = all; verify codes in S1) without `subscriptionRequest/filteringattributes` | Set "Select columns" (and "Filter rows" if only some rows matter) |
| RES03 | v0.1 | `Recurrence` trigger every second, or every 1–5 minutes | Use an event trigger or a longer interval |
| RES04 | v0.1 | List queries without a column limit (Dataverse `$select` / FetchXML, SQL and Excel `$select`), or without any of `$filter` / `$top` / FetchXML | Add select / filter / top |
| RES05 | v0.3 | `paginationPolicy.minimumItemCount` very high (over 5,000) | Lower it, or filter at the source |
| RES06 📊 | v0.2 | High estimated actions per run (Σ loop iterations × actions inside the loop) | Show the projected daily count against a **user-set** daily request limit (informational) |
| RES07 | v0.3 | Dataverse *Update a row* that sets more than 10 columns, or maps every column from the trigger body | Send only changed columns (avoids triggering other automations) |
| RES08 | v0.2 | Create / update / delete one record per loop item (Dataverse, SharePoint, SQL, Excel), grouped per loop; lower confidence when the loop is concurrent; skips one-row loops | Dataverse bulk messages (`CreateMultiple` / `UpdateMultiple`) or `$batch`, SharePoint `$batch`, SQL stored procedure, Excel Office Script; at least concurrency (Microsoft anti-pattern) |

### Reliability
| ID | In | Detects | Recommendation |
|---|---|---|---|
| REL01 | v0.1 | Loop concurrency on **and** variables written inside the loop | Race condition. Fix before speeding up |
| REL02 | v0.1 | Flow with 5 or more actions and no error handling (no action runs after Failed / TimedOut) | Try/Catch/Finally scope pattern |
| REL03 📊 | v0.2 | Retry policy `none` (definition). Later: default or aggressive retry policy on slow/flaky actions; many 429s | Default or exponential retry; tune `retryPolicy`; reduce the number of calls |
| REL04 | v0.1 | `Until` with no limits or with the default ones (count 60, timeout PT1H) | Set explicit limits and check the exit condition after the loop |
| REL05 | v0.1 | Close to platform limits: 400+ actions (limit 500) or nesting depth 7+ (limit 8) | Split into child flows |
| REL06 📊 | v0.3 | Trigger concurrency limited to 1, and run data shows runs waiting for each other | Review whether serial runs are really needed |
| REL07 | v0.2 | Dataverse update of the triggering table (logical name matched to the entity set name), or SharePoint *Update item* on the triggering list, when the trigger has no trigger condition and its filtering columns include a column the update sets | Trigger condition, or filtering columns the update doesn't change (Microsoft anti-pattern: infinite loop) |
| REL08 | v0.2 | Error path (runs after Failed / TimedOut, not after Succeeded) where nothing in it or after it is a Terminate *Failed* / *Cancelled* or a Response. Skips per-item handlers inside loops and request-triggered flows that answer with a Response. One finding per flow | End the Catch with Terminate (Failed) |
| REL09 | v0.2 | `body('X')…[0]` / `outputs('X')…?[0]` on a list result (list query, Filter array, Select, `…['value']`) with no `empty()` / `length()` in the same expression and no enclosing Condition on X. Grouped per source list | `first()` with an empty check, or a `length()` Condition |
| REL10 | v0.2 | SharePoint *Get items* (100) or Excel *List rows* (256) with no Top Count and no pagination; Dataverse *List rows* (5,000) with neither, when a loop goes through it | Top Count, or pagination with a threshold |

### Security
| ID | In | Detects | Recommendation |
|---|---|---|---|
| SEC01 | v0.2 | Key Vault *Get secret* without Secure outputs; steps that reference it without Secure inputs | Turn on Secure inputs / outputs |
| SEC02 | v0.2 | HTTP action with a literal (non-expression) password / secret in its authentication, a credential header (`Authorization`, `x-api-key`, `api-key`, `Ocp-Apim-Subscription-Key`, `x-functions-key`…), or a key in the URI (`code=`, `sig=`, `api_key=`) | Key Vault or an environment variable of type Secret, Secure inputs, rotate the secret |
| SEC03 | v0.2 | *When an HTTP request is received* with "Who can trigger the flow" set to Anyone (`triggerAuthenticationType` `All`), or missing (legacy flows) | Any user / specific users in my tenant |

### Maintainability (off by default)
| ID | In | Detects |
|---|---|---|
| MNT01 | later | Hard-coded GUIDs, URLs, emails → use environment variables |
| MNT02 | v0.3 | Default action names (`Compose_3`, `Condition_2`) |
| MNT03 | later | Scopes and actions with no descriptive name or note |

### Proposed rules (research 2026-09-25)
Sources: Microsoft's cloud flow coding guidelines (all 27 pages), limits page, SharePoint "Get items" guidance, Dataverse list-rows docs, the FlowLens and powerautomate-lint rule sets, and community standards (Matthew Devaney, Tom Riha). Each candidate was run against the 28-flow capture; "Capture" shows how many real flows it would flag.

| ID | Category | Detects | Recommendation | Capture | Priority |
|---|---|---|---|---|---|
| SEC01 | Security | Azure Key Vault *Get secret* (or any action returning credentials) without **Secure outputs** | Turn on Secure inputs/outputs so secrets don't appear in run history | 1 flow, 4 actions | **High, v0.2** |
| SEC02 | Security | HTTP action with a literal password, API key or `Authorization` header | Key Vault or environment variable (secret type), secure inputs | 1 flow | **High, v0.2** |
| SEC03 | Security | *When an HTTP request is received* that anyone with the URL can call, or without secure inputs | "Any user in my tenant" / specific users (Entra ID), secure inputs | 0 | Medium, v0.2 |
| RES08 | Resources | Create / update / delete one record per loop item (Dataverse rows, SharePoint items) | Bulk: `CreateMultiple` / `UpdateMultiple`, `$batch`, or at least concurrency (Microsoft anti-pattern) | 6 flows, 23 actions | **High, v0.2** |
| SPD05 | Speed | Loop whose only step is a Condition (filtering inside the loop). Definition-only version of the 📊 rule | Filter at the source (`$filter`) or Filter array before the loop | 2 flows | **High, v0.2** |
| REL07 | Reliability | Flow updates the row/item that triggers it, with no guard (trigger condition, or filtering columns that exclude the updated columns) | Trigger condition or filtering columns (Microsoft anti-pattern: infinite loop) | 0 (2 flows correctly guarded) | High, v0.2 |
| REL09 | Reliability | `[0]` on a query result without an emptiness check (`?` doesn't protect against an empty array; to confirm) | `if(empty(…), …, first(…))`, or check `length()` first | 8 flows, 64 places | Medium, v0.2 |
| REL10 | Reliability | SharePoint *Get items* with no Top Count and no pagination (silently stops at 100 items; with a filter on lists over 5,000 items it can return nothing); Dataverse *List rows* looped over without pagination (stops at 5,000) | Set Top Count or turn on pagination with a threshold | 0 | Medium, v0.2 |
| REL08 | Reliability | Error path (runs after Failed) that never ends in Terminate *Failed* (or a Response for child flows), so failed runs show as Succeeded | End the Catch scope with Terminate (Failed) | 16 flows (needs refining: child flows reporting via Response are fine) | Medium, v0.2 |
| REL11 | Reliability | Reference to an action or variable that doesn't exist (evaluates to null silently), or that only matches with different letter case | Fix the name | 2 flows (case-only) | Medium, v0.2 |
| REL03 | Reliability | (definition part) Retry policy *None* on connector/HTTP calls | Default or exponential retry | 1 flow | Low, v0.2 |
| REL05 | Reliability | (extend) Switch with 20+ cases (limit 25), 200+ variables (limit 250), expressions over 6,000 characters (limit 8,192) | Split, simplify | – | Low |
| RES09 | Resources | ETL-sized processing: loops over paginated queries of thousands of rows with writes | Dataflows (Microsoft anti-pattern) | – | Low |
| MNT01 | Maintainability | Hard-coded URLs, emails, GUIDs (FlowLens FL001–003) | Environment variables | 1 flow | Off by default |
| MNT02 | Maintainability | Default action names (`Compose_3`) | Descriptive names | 22 flows, 111 actions | Off by default |
| MNT04 | Maintainability | Deprecated actions/connectors (legacy Common Data Service connector, `SendEmail` V1, `UserProfile` V1…) | Current versions | – | v0.3 |

**Built (v0.2, 2026-09-25):** SEC01–SEC03, RES08, SPD05 (definition), REL03 (definition), REL07–REL10, with tests; the "Security" category and the C cap are in the score, the pane and the report. Results on the 28-flow capture after building:
- SEC01: 2 flows (4 *Get secret* without Secure outputs; 4 steps using a secret without Secure inputs). SEC02: 1 flow (subscription key header). SEC03: 0 (no HTTP triggers).
- RES08: 6 flows, 10 loops. SPD05: 2 flows. REL03: 1 flow, 2 actions. REL10: 4 Dataverse queries looped over (low confidence). REL07: 0 (both self-updating flows are guarded by trigger conditions).
- REL08: 6 flows (down from 16 once per-item handlers and child flows answering with a Response were skipped).
- REL09: 0. Almost every `[0]` in the capture sits under a Condition on `length()` of the same list, or next to `empty()` in the expression; the research count didn't look for guards.
- The "after" fixture now writes with one `UpdateMultiple` request and pages its query, so it still scores 100.

**Dropped: REL11.** The designer refuses to save a reference to a missing action, and the capture shows the runtime matching names without regard to case (a Condition referencing `…_for_domain` for an action named `…_for_Domain` succeeded in run history). Neither case produces a silent null. Not built: the REL05 extension, RES09, MNT01, MNT02, MNT04 (unchanged priorities).

Not detectable from a definition (run data or tenant settings instead): child flows over 120 seconds (needs the async 202 pattern; v0.2 run data), throttling that turns a flow off after 14 days (run data), flow ownership by a service principal, solution-aware ALM, monitoring and alerting.

**Scoring impact:** security findings need their own category. Proposal: speed 35%, resources 25%, reliability 25%, security 15%, with any high security finding capping the grade at C.

> Before building each rule, check the facts against Microsoft docs (limits, defaults, operation IDs) and record the source in the rule's `docs` field. Confirmed so far: Apply to each runs sequentially by default; concurrency is 1–50 and only applies to the outermost loop; Until defaults are count 60 and PT1H; 500 actions per flow; nesting depth 8.

---

## 5. Scoring
- Each category (speed, resources, reliability, security) starts at **100**. Each finding subtracts **high 25 / medium 10 / low 3**, multiplied by its confidence (0–1). The score can't go below 0.
- 📊 findings scale by measured impact: the deduction is multiplied by `0.5 + timeShare` (capped at 1.5), so a loop taking 80% of the run weighs more than one taking 5%.
- Grades: **A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50, F below 50.**
- Overall = weighted average: speed 35%, resources 25%, reliability 25%, security 15% (was 40 / 35 / 25 before the security category, 2026-09-25). While a high-severity security finding is open (not dismissed), the overall score is capped at 79 (grade C). Maintainability is excluded by default.
- **Estimated actions per run:** walk the definition; `If` and `Switch` count their largest branch; loops multiply their inner count by the median iteration count measured from runs, or by a default (Foreach 50, Until 10) marked as assumed.
- Findings marked "accepted" (stored locally by flow ID + rule ID + action path) don't count toward the score.

---

## 6. Architecture

```
 make.powerautomate.com tab                 Extension
┌────────────────────────┐   requests   ┌───────────────────────────────┐
│ portal calls           │ ───────────▶ │ background service worker     │
│ api.flow / powerplatform│  (headers)  │  • captures Authorization and │
└────────────────────────┘              │    base URL from portal       │
                                        │    requests only (initiator)  │
                                        │  • writes to storage.session  │
                                        └──────────────┬────────────────┘
                                                       │ chrome.storage.session
                                        ┌──────────────▼────────────────┐
                                        │ app tab (React + Fluent UI 9) │
                                        │  api/  → Power Automate API    │
                                        │  store → IndexedDB cache       │
                                        │  uses @cfa/core                │
                                        └──────────────┬────────────────┘
                                                       │
                                        ┌──────────────▼────────────────┐
                                        │ @cfa/core (no browser deps)   │
                                        │  parser → ActionTree           │
                                        │  rules → Finding[]             │
                                        │  runs → ActionRunStats         │
                                        │  scoring                       │
                                        └───────────────────────────────┘
```

### Token handling
- The browser stops an idle MV3 service worker after about 30 seconds, and its memory is lost. So the worker writes each captured token to **`chrome.storage.session`**: memory-only, never written to disk, cleared when the browser closes, and readable only by the extension's own pages. The app tab reads it from there and listens for changes.
- Only requests whose `initiator` is a maker portal (`make.powerautomate.com`, `make.powerapps.com`, and their `make.preview.` variants) are captured. The app tab's own API calls hit the same hosts and are ignored.
- Each token is stored with its host kind (`flow` or `powerplatform`), the base URLs it was used on, and the claims the UI needs (`exp`, `tid`, account name). The JWT is decoded, not validated; it's never sent to a host of the other kind.

### Repo layout (pnpm workspaces)
```
packages/core/        # parser, rules, run stats, scoring, anonymiser, types (pure TS, Vitest)
packages/ui/          # shared React components (Flow list, report, tree, run profile)
apps/extension/       # MV3 manifest, background worker, app tab, capture tool (diagnostics)
apps/demo/            # GitHub Pages demo: sample flows + "paste definition JSON" mode
fixtures/flows/       # anonymised flow definitions + run payloads (one or more per rule)
scripts/              # dev scripts (analyse a flow or capture file from the command line)
docs/                 # plan, rule docs (one page per rule), ADRs
```

### Key types (sketch)
```ts
type ActionNode = {
  name: string; type: string;                       // Foreach, If, Scope, Switch, Until, OpenApiConnection, Http, Workflow, SetVariable…
  kind: ActionKind;                                 // normalised: loop, until, condition, switch, scope, connector, http, child-flow, variable-write…
  path: string[];                                   // e.g. ["Try", "Apply_to_each", "Get_a_row"]
  runAfter: Record<string, string[]>;
  connector?: string; operationId?: string; parameters?: Record<string, unknown>;
  settings: { concurrency?: number; retryPolicy?: unknown; paginationMinItems?: number; limit?: { count?: number; timeout?: string } };
  children: ActionNode[];                           // flattened from actions / else.actions / cases.*.actions / default.actions
  depth: number;                                    // 1 = top level
  references: string[];                             // action names used in this action's inputs
};
type Finding = {
  ruleId: string; category: 'speed'|'resources'|'reliability'|'maintainability';
  severity: 'high'|'medium'|'low'; confidence: number;   // 0..1
  target: { kind: 'flow'|'trigger'|'action'; name?: string; path: string[] };
  message: string; fix?: string;                    // fix overrides the rule's default text when more specific
  blockedBy?: string[];                             // e.g. SPD01 blocked by SPD02
  evidence?: { timeSharePct?: number; iterationsP50?: number; retries429?: number; requestsPerDay?: number };
};
type ActionRunStats = { path: string[]; samples: number; p50Ms: number; p95Ms: number; timeSharePct?: number; busyMs: number; iterationsP50?: number; retries429: number; failures: number };
```

### Parser notes (workflow definition schema)
- Accepted input: a flow resource from the API (`properties.definition`), Dataverse `clientdata` (JSON string or object), or a bare definition (`{ triggers, actions }`).
- Triggers: `definition.triggers`. Trigger conditions are in `conditions[]`, trigger concurrency in `runtimeConfiguration.concurrency.runs`, schedule in `recurrence`.
- Nested actions: `actions` (Scope / Foreach / Until / If-true), `else.actions` (If), `cases.<name>.actions` and `default.actions` (Switch).
- Loop concurrency: `runtimeConfiguration.concurrency.repetitions`; `operationOptions: "Sequential"` also means one at a time. Pagination: `runtimeConfiguration.paginationPolicy.minimumItemCount`.
- Connector actions: `type: OpenApiConnection` (older flows: `ApiConnection`, which has a `path` and `method` instead of an `operationId`), `inputs.host.operationId` (e.g. `ListRecords`, `GetItem`, `UpdateRecord`), `inputs.parameters` (`$select`, `$filter`, `$top`…).
- Dataverse trigger: `operationId: SubscribeWebhookTrigger` with `subscriptionRequest/message`, `subscriptionRequest/entityname`, `subscriptionRequest/filteringattributes`, `subscriptionRequest/filterexpression`.
- Child flow: `type: Workflow`. Variables: `InitializeVariable`, `SetVariable`, `AppendToArrayVariable`, `IncrementVariable`…
- Handle expressions (`@{…}`, `@body('X')`) as strings. A simple reference extractor finds `body('…')`, `outputs('…')`, `actions('…')`, `items('…')`, `item()` and `variables('…')`.

### Power Automate API (S1/S2 findings, capture of 2026-09-25)
Confirmed against a real tenant (commercial cloud, 6 environments, 61 flows):
- **Two APIs, both work.** The portal now does almost everything through the Power Platform API (`https://{env}.environment.api.powerplatform.com/powerautomate/…?api-version=1`, token audience `https://api.powerplatform.com/`); it only calls `api.flow.microsoft.com` (api-version `2020-06-01`) for environment permissions. The older API (`api.flow.microsoft.com/providers/Microsoft.ProcessSimple/…`, api-version `2016-11-01`) still answered every call we made. v0.1 keeps the older API (known shapes, one host) and adds the Power Platform API as the fallback; both live in `api/`.
- Environments: `…/providers/Microsoft.ProcessSimple/environments` ✅
- Flows: `…/environments/{env}/flows` (default list: 49 flows) ✅ and `…/scopes/admin/environments/{env}/v2/flows` (admin: 58 flows) ✅. Together they gave 61 distinct flows, so the app merges both. `search('personal')` / `search('team')` not yet tested.
- The flow list already contains `properties.definitionSummary`: every action's `type`, `swaggerOperationId` and connector (`api.name`). Good enough to pre-screen flows for "Analyse all" without fetching each definition.
- Get flow: `…/flows/{flowId}` returns `properties.definition` and `connectionReferences` with no `$expand` ✅. Also has `workflowEntityId`, `isManaged`, `creator`.
- Runs: `…/flows/{flowId}/runs?$top=N` ✅. Each run has `startTime`, `endTime`, `status`, `code` (e.g. `Terminated`), and trigger timings.
- Run actions: `…/runs/{runId}/actions` ✅, **paged at 100** (`nextLink`). Each action has only `startTime`, `endTime`, `status`, `code`, `error`, `correlation`: **no iteration count and no `retryHistory`** in the list.
- Loop repetitions: `…/runs/{runId}/actions/{actionName}/repetitions` ✅, one entry per iteration with `repetitionIndexes` (`scopeName`, `itemIndex`) and start/end times. This is the only source of loop iteration counts and per-iteration timings.
- The portal's own run history uses `…/powerautomate/flows/{id}/runs` and `…/triggers/{name}/histories` on the Power Platform API.

---

## 7. Run analysis design
**Built (v0.2, 2026-09-25).** What the capture showed, and how the build follows it:
- A loop's own entry in the run's action list has its real start and end (its wall-clock time). An action *inside* a loop has one entry with misleading times (start of the last iteration, end near the loop's end), so inner actions are measured only from their repetitions.
- Repetitions carry `repetitionIndexes` (outermost loop first), so one inner action's repetitions give the item count of every loop around it. Nested items are counted per outer item.
- Neither list has retry history, and the capture has no 429s. Throttling is counted from `code` `429` / `TooManyRequests` when it appears; REL03 📊 waits for real data.
- What is fetched per run: its action list (paged at 100), then repetitions for the first action of each loop (item counts) and for connector / HTTP / child-flow calls inside loops (time), at most 15 actions × 3 pages, and only for loops that ran in that run. Defaults: the last 20 runs; unfinished runs are skipped.
- Numbers are medians over runs (nearest rank). Time share = the action's (or its outermost loop's) time ÷ the run's duration.
- Findings of 📊 rules (SPD01, SPD03, SPD07, RES08, RES01) get the measured time share and item count in their message and evidence, so the score weighs them by measured impact. If the loop never had more than one item, a per-item finding drops to low severity.
- Finished runs are cached in IndexedDB (key: environment/flow/run, plus the list of loop actions read, so a changed flow reads its runs again), dropped after 30 days; the pane has **Clear cached runs**.
- Not built yet: a "slowest runs" mode, a cancel button, RES06, REL03 📊.

Original design:
- **Sampling:** default the last 20 runs (configurable 5–100), plus a "slowest runs" mode (the runs list has start and end times, so the slowest can be picked without extra calls).
- **Per run:** fetch actions; fetch repetitions for each action inside a loop, capped at **500 repetitions per inner action per run**. Request budget per run ≈ 1 + Σ(inner actions × pages).
- **Rate limiting:** a queue with at most 4 requests at once, backing off on 429 (respect `Retry-After`); progress bar and cancel button.
- **Caching:** runs never change once finished, so cache them permanently in IndexedDB (keyed by run ID). Definitions are keyed by flow ID + `lastModifiedTime`.
- **Statistics:** per-action median/95th percentile, iteration counts, throttled retries, failures. Handle missing or skipped actions.
- **Time share:** actions overlap in parallel branches and concurrent loops, so durations can't simply be summed.
  - Top-level actions and loops: wall-clock time (end − start) as a share of run duration.
  - Actions inside a loop: total busy time (sum over iterations) plus per-iteration p50/p95, with no share of run.

---

## 8. Security and privacy
- **Read-only:** only GET requests to the Power Automate API. Never create, update or delete flows. The API module refuses other methods and any host outside the two API host patterns.
- **Token:** kept in `chrome.storage.session` only (memory, never on disk, not IndexedDB, not `chrome.storage.local`). Never logged, never included in a capture file, never sent to a host of the other kind.
- **No outside calls:** no analytics, telemetry or remote code. The default MV3 Content Security Policy blocks remote scripts.
- **Minimal permissions:** `webRequest` (read headers only, no blocking), `storage`, and `scripting` (to add the analysis pane to a portal tab when the user asks; no warning). Host permissions: `*.api.flow.microsoft.com`, `*.api.powerplatform.com`, and the maker portals (MV3 needs host access to a request's initiator as well as its URL). No `tabs` permission, which would add a "Read your browsing history" warning.
- **Cache data:** flow definitions can contain sensitive values, so offer a "Clear cache" button and state in the README what's stored locally. Built: definitions aren't cached. The run cache (IndexedDB) keeps only run and action names, statuses, error codes and times, never inputs or outputs; **Clear cached runs** in the pane empties it, and entries expire after 30 days.
- **Fixtures and capture files:** the capture tool anonymises by default: IDs, emails, URLs, names and literal input values are replaced; `inputsLink`/`outputsLink` (signed URLs) are removed; expressions are kept. Files must be reviewed before they're committed.

---

## 9. Stack
| Area | Choice | Why |
|---|---|---|
| Language | TypeScript 6.0 (strict, erasable syntax only) | Shared types between core and UI. Move to TypeScript 7 once typescript-eslint supports it |
| Runtime / packages | Node 22, pnpm 10 workspaces | Current LTS; fast installs |
| Extension | Manifest V3, plain Vite multi-entry build (no CRXJS) | Only a worker and pages, no content scripts, so no plugin needed |
| UI | React 19 + **Fluent UI React v9** | Looks like Power Platform |
| Charts | Small custom SVG (bars, action tree) | No heavy charting library needed |
| Storage | IndexedDB via `idb` | Caches runs and definitions; stores accepted findings |
| Tests | Vitest (core + UI components), Playwright (demo site e2e; extension e2e via a persistent Chromium context against a **mocked API** serving fixtures, since CI can't sign in) | Rules must be test-driven |
| CI | GitHub Actions: lint, typecheck, test, build; the built extension is uploaded as a workflow artifact | Free |
| Quality | ESLint + Prettier, Dependabot; CodeQL once the repo is public | Free on GitHub (CodeQL and Pages need a public repo on a free account) |
| Licence | MIT (don't copy GPL code from Power Automate Tools) | Portfolio-friendly |

**Distribution:**
- GitHub Releases zip (free; load unpacked)
- **Edge Add-ons** (free)
- Chrome Web Store: decide at v1.0 ($5 one-time developer fee)

---

## 10. Milestones

### M0: Spikes (de-risk first)
A **capture tool** page ships inside the extension for the spikes. It shows the captured tokens, lists environments and flows (mine, shared, admin), fetches definitions, runs, run actions and loop repetitions, runs the v0.1 rules on each definition, records every portal endpoint seen, and downloads everything as one anonymised JSON file. The owner runs it against their tenant and commits the reviewed file under `fixtures/captures/`.
- **S1 Token and API:** capture the token from the current portal (both hosts); list environments and flows; fetch one definition. *Done when a JSON definition of a non-solution flow and of a solution flow are both captured.*
- **S2 Run payloads:** fetch runs, actions and loop repetitions for a looping flow; confirm the timing fields and retry info; measure request counts and throttling.
- **S3 Parser coverage:** parse 20+ real (anonymised) definitions covering Scope, If, Switch, Foreach, Until, Workflow and HTTP without errors.

### v0.1: Definition analysis in the portal (the pane is the product)
- ✅ Popup (Analyse this flow / Open capture tool) and the in-page analysis pane: grade, scores, estimate, findings with severity filters, how to fix / why / before-after / docs.
- ✅ Click an action to jump to it in the designer: pans the canvas, finds actions the designer hasn't drawn yet, opens collapsed scopes, loops, Condition branches and Switch cases on the way.
- ✅ Rules that work from the definition: SPD01, SPD02, SPD03, SPD04, SPD07, SPD08, SPD10, RES02, RES03, RES04, REL01, REL02, REL04, REL05, each with fixtures and tests.
- ✅ Dismiss findings (remembered per flow in the browser, left out of the score), copy the report as Markdown, actionable error messages.
- ✅ Browser tests in CI (extension in Chromium against a test designer); release workflow publishing a zip for each `v*` tag.
- ⏳ Tune the rules against 20+ captured real flows (S3), see [the capture guide](CAPTURE.md).
- *Done when:* analysing real flows shows correct findings, pinned to the right actions, with few false alarms.

### v0.2: Run analysis in the pane
- ✅ "Analyse recent runs" in the pane: last 20 runs, rate-limited queue, IndexedDB cache, progress; where the time goes, loop sizes, failures and throttling per action; findings and score use the measured numbers (see §7).
- ✅ Definition rules from the 2026-09-25 research: SEC01–SEC03, RES08, SPD05, REL03 (retry none), REL07–REL10, and the Security score category (see §4, §5).
- ✅ 📊 versions of SPD01, SPD03, SPD07, RES08 (measured time share and items); new rule RES01; actions per run from measured loop sizes.
- ⏳ RES06 (actions per day against a user-set limit), REL03 📊 (needs retry data), "slowest runs" mode, cancel button.
- ⏳ Check against the portal: open a flow's run history and compare the slowest action and loop item counts with the pane.
- *Done when:* the slowest action and loop iteration numbers match what the portal's run history shows.

### v0.3: Environment and remaining rules
- "Analyse all": an extension page listing every flow in an environment with its grade and top findings (pre-screened from each flow's `definitionSummary`), linking to the flow so the pane can take over. This replaces the separate full-page Flows app of the first plan.
- Remaining rules (SPD05 📊, SPD09, RES05, RES07, REL06, MNT02).
- Demo site on GitHub Pages: sample flows plus a "paste a flow definition JSON" mode. Make the repo public at this point.

### v1.0: Polish and publish
- Docs page per rule, README GIF, accessibility check, security review, privacy policy, Edge Add-ons listing (+ Chrome Web Store if decided).

---

## 11. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Portal API or hosts change (undocumented) | Extension breaks | All calls in one `api/` module; support both hosts; capture tool records the portal's endpoints; clear error messages |
| Token expires (60–90 min) | Requests fail | Read `exp` and warn early; detect 401 → banner; pick up new tokens automatically |
| Service worker stopped while idle | Token lost | Token lives in `chrome.storage.session`, not worker memory |
| Admin-listed flows can't be read with user endpoints | Missing definitions or runs | Fall back to `scopes/admin` endpoints; mark the flow "not accessible" rather than failing |
| Throttling while sampling runs | Slow or failed analysis | Concurrency cap, backoff, cache, sample limits |
| Wrong recommendations (e.g. concurrency with shared state) | User breaks a flow | Guard rules (SPD02/REL01 block SPD01); a confidence value on each finding; "why" text; fixtures for edge cases |
| Store review over reading auth headers | Listing rejected | Precedent (Power Automate Tools); minimal permissions (no `tabs`); clear privacy policy; read-only |
| Sensitive data in fixtures or cache | Privacy leak | Anonymise by default; review before committing; clear-cache button; token never stored on disk |

---

## 12. Decisions (2026-09-25)
1. Name: **Cloud Flow Analyzer**.
2. Run sampling: 20 runs by default (5–100); at most 500 repetitions per inner loop action per run.
3. Maintainability: off during v0.x; MNT02 arrives in v0.3.
4. Distribution: Edge Add-ons + GitHub Releases; Chrome Web Store decided at v1.0.
5. Licence limits: the user sets their daily request limit (with presets); no built-in numbers.
6. Flows listed: My flows, Shared with me, solution flows, and all flows in the environment for admins.
7. Clouds and portals: commercial cloud only; make.powerautomate.com and make.powerapps.com.
8. Git: assistants commit and push to their working branch; the owner merges.
9. Repo goes public at v0.3 (needed for free Pages and CodeQL).
10. Scoring formula as in §5.
11. Stack: React 19, TypeScript 6.0, plain Vite multi-entry build.
12. **The in-page pane is the product** (2026-09-25): analysis happens on the flow's own page, next to the designer. The full-page Flows app is dropped; the environment view becomes "Analyse all" in v0.3. The pane is plain TypeScript (no React needed so far).

---

## 13. Name check (2026-09-25)
| Name | npm | GitHub (exact / similar) | Notes |
|---|---|---|---|
| **cloud-flow-analyzer** ✅ chosen | free | 0 / 1 (unrelated) | Accurate for a read-only tool |
| cloud-flow-optimizer | free | 0 / 1 (unrelated) | Catchier, but suggests it changes flows |
| cloud-flow-inspector | free | 0 / 0 | Alternative |
| flow-optimizer / flow-analyzer / flow-doctor | free | 3–9 exact matches | Too generic, crowded |
| flow-inspector | **taken** on npm | 6 exact | Avoid |
| Cloud Flow Viewer | — | — | Name of an existing tool; avoid "viewer" |

Tagline: *"Cloud Flow Analyzer: speed and resource recommendations for Power Automate cloud flows."* Package scope: `@cfa/core`.

---

## 14. Sources
- Microsoft cloud flow coding guidelines (source): https://github.com/MicrosoftDocs/power-automate-docs/tree/main/articles/guidance/coding-guidelines · [secure data in cloud flows](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/use-secure-inputs-outputs-triggers) · [keep configuration generic](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/keep-flow-configuration-generic) · [asynchronous responses](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/asychronous-flow-pattern)
- SharePoint Get items / Get files in-depth: https://learn.microsoft.com/en-us/sharepoint/dev/business-apps/power-automate/guidance/working-with-get-items-and-get-files
- Dataverse bulk operations: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bulk-operations
- powerautomate-lint rules (PAL101–107): https://github.com/verseblocks/powerautomate-lint · FlowLens rules (FL001–004): https://github.com/Yolostream/FlowLens
- Matthew Devaney coding standards (error handling, performance): https://www.matthewdevaney.com/power-automate-coding-standards-for-cloud-flows/
- Cloud flow run history in Dataverse: https://learn.microsoft.com/en-us/power-automate/dataverse/cloud-flow-run-metadata
- Flow Log (flowlog) table: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/flowlog
- Work with cloud flows using code: https://learn.microsoft.com/en-us/power-automate/manage-flows-with-code
- Process insights for cloud flows (preview): https://learn.microsoft.com/en-us/power-automate/process-mining-cloud-flow-process-insights
- Troubleshoot slow-running flows: https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/flow-run-issues/troubleshoot-slow-running-flows
- Limits and configuration: https://learn.microsoft.com/en-us/power-automate/limits-and-config
- Coding guidelines: [parallel execution and concurrency](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/implement-parallel-execution) · [avoid anti-patterns](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/avoid-anti-patterns) · [optimise triggers](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/optimize-power-automate-triggers) · [work with relevant data](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/work-with-relevant-data) · [data operations](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/use-data-operations) · [error handling](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/error-handling) · [understand limits](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/understand-limits) · [reusable code (child flows)](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/create-reusable-code)
- Dataverse trigger (select columns, filter rows): https://learn.microsoft.com/en-us/power-automate/dataverse/create-update-delete-trigger
- Dataverse list rows: https://learn.microsoft.com/en-us/power-automate/dataverse/list-rows
- Power Automate performance standards (Matthew Devaney): https://www.matthewdevaney.com/power-automate-coding-standards-for-cloud-flows/power-automate-standards-performance-optimization/
- Power Automate Tools (token approach, GPL-3): https://github.com/rithala/power-automate-tools
- FlowLens: https://github.com/Yolostream/FlowLens · powerautomate-lint: https://github.com/verseblocks/powerautomate-lint
- Flow Studio monitoring: https://awesome-copilot.github.com/skill/flowstudio-power-automate-monitoring/
- Cloud Flow Viewer: https://rajeevpentyala.com/2025/10/16/new-tool-cloud-flow-viewer-for-power-automate-solutions/
