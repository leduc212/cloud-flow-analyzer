# Cloud Flow Analyzer — Project Plan

> **Speed and resource recommendations for Power Automate cloud flows, right in your browser.**
> A browser extension (Edge/Chrome) that reads your flows and their recent runs, finds slow or wasteful patterns, and tells you how to fix them.

Status: planning · Drafted 2026-09-25 · Owner: LEMD (leduc212)

---

## 1. Goals and non-goals

### Goals
1. **Get flows:** list every cloud flow the signed-in user can see in an environment. That includes flows outside solutions.
2. **Analyse a flow:** parse its definition into an action tree and run a rule engine that finds anti-patterns hurting **speed**, **resource use** (Power Platform requests) and **reliability**.
3. **Use real run data where it helps:** sample recent runs to measure which actions take the time, how many loop iterations happen and how many throttled retries occur. Rank findings by measured impact.
4. **Recommend fixes:** every finding explains *why* it matters, *how* to fix it, and shows the better pattern.
5. **Stay simple and free:** runs entirely in the browser, no servers, no app registration, $0.

### Non-goals (deliberate)
- Editing or changing flows. The extension is **read-only**.
- Monitoring, alerting, scheduled scans or dashboards over time.
- Any link to dataverse-trace (separate project, no correlation).
- Desktop flows (Power Automate Desktop) and Logic Apps. Possible later.

### Working preferences (carried over from the owner's other project)
- $0 to build and run. GitHub only (Pages, Actions, Releases). No Azure, no paid services, no Entra ID app registration.
- Plain, descriptive naming. Keep "Power Automate" out of the product name; use it only in taglines ("for Power Automate").
- The owner makes all git commits. Assistants shouldn't commit or push unless asked.

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
⚠ **Power Automate Tools is GPL-3.** Re-implement the approach; don't copy code if this project is MIT.

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
1. The user opens make.powerautomate.com and signs in as usual.
2. Clicks the extension icon. A full-page extension tab opens (the "app tab").
3. The app tab shows the environment picker (from the captured API) and the **Flows** list.
4. Picks a flow → **Flow report** (definition analysis, instant) → optional **Analyse runs** (samples the last N runs).
5. If the token expires (about 1 hour): a banner asks the user to refresh or keep using the portal tab.

### Screens
```
① Flows                        ② Flow report                          ③ Run profile
┌────────────────────────┐    ┌─────────────────────────────────┐    ┌──────────────────────────┐
│ Env: Contoso Dev   ▾   │    │ Sync Contacts to ERP     B (72) │    │ Run 08:14 · 6m 12s       │
│ 🔍 search   ⚙ filters  │    │ Speed C · Resources B · Rel. A  │    │ ▇▇▇▇▇▇▇▇▇ Apply_to_each 61%│
│ Name      Score Issues │    │ ~1,900 actions/run (est.)       │    │   ▇▇ Get_a_row ×1240 22% │
│ Sync Cont…  C    7     │    │ 🔴 SPD01 Loop runs one at a time│    │ ▇ List_rows 4%           │
│ Invoice a…  A    1     │    │ 🔴 SPD03 Get a row inside loop  │    │ 429 throttled: 38 retries│
│ Nightly c…  B    3     │    │ 🟠 RES02 Trigger fires on any   │    │ Slowest actions ▸        │
│  [Analyse all]         │    │    column change                │    └──────────────────────────┘
└────────────────────────┘    │ Action tree (with timings) ▸    │
                              └─────────────────────────────────┘
```

1. **Flows**
   - table: name, state, trigger type, solution/non-solution, last modified, score, issue count
   - search, filters, sorting
   - "Analyse all" runs definition-only analysis across the environment
2. **Flow report**
   - score overall and per category
   - estimated actions per run
   - findings sorted by severity × impact; each expands to why / how to fix / better pattern (before → after snippet)
   - action tree drawn like the designer (scopes, conditions, switch cases, loops), with finding badges on actions; clicking a finding highlights its action
3. **Run profile** (after "Analyse runs")
   - sample size, time range, success/failure split
   - slowest actions (median, 95th percentile, share of run time)
   - loop iteration statistics; throttling retries (429) per action
   - 📊 findings updated with measured impact

Extras:
- Mark a finding as "accepted" (stored locally, excluded from the score).
- Copy the report as Markdown.
- Light and dark theme.

---

## 4. Rule catalogue

Each rule has: `id`, `category` (speed / resources / reliability / maintainability), `severity` (high / medium / low), `detect(tree, runStats?)`, `why`, `fix`, `example` (before/after), `docs` link.
📊 = the rule uses run data when available (and falls back to definition-only).

### Speed
| ID | Detects | Recommendation |
|---|---|---|
| SPD01 📊 | `Foreach` with concurrency off (no `runtimeConfiguration.concurrency.repetitions`, or it's 1) | Turn on concurrency (1–50; 20 is the default when on). **Blocked by REL01/SPD02** |
| SPD02 | `SetVariable` / `AppendToArrayVariable` / `AppendToStringVariable` / `IncrementVariable` inside a loop | Use **Select** / **Filter array** / **Compose** / `union()` / `join()`. Faster, and makes concurrency safe |
| SPD03 📊 | Single-record reads inside a loop (Dataverse `GetItem`, SharePoint Get item, HTTP GET…) | Do one bulk query (`$filter`, `$expand`, FetchXML), then Filter array |
| SPD04 | Nested `Foreach` | Flatten with Select / `xpath()` or restructure |
| SPD05 | A `Foreach` whose first action is an `If` that skips most items | Move the condition into the source query `$filter` |
| SPD06 | Independent actions chained one after another (no data dependency) | Run them as parallel branches |
| SPD07 📊 | A child flow (`Workflow` action) inside a loop | Send the whole batch to the child flow in one call |
| SPD08 | `Until` containing a `Wait`/Delay (polling) | Use a trigger or webhook, or a longer interval |
| SPD09 | The same record or endpoint read repeatedly; the same long expression repeated | Read or calculate once, then reuse via Compose |
| SPD10 | `Foreach` over the output of a single-record action (the designer wraps it automatically) | Use `first()` or reference the record directly |

### Resources (every action counts toward Power Platform request limits)
| ID | Detects | Recommendation |
|---|---|---|
| RES01 📊 | Trigger has no `conditions` and many runs end without doing real work | Add a trigger condition. Runs that are filtered out don't count |
| RES02 | Dataverse trigger (`SubscribeWebhookTrigger`) on Update / Create-or-Update without `subscriptionRequest/filteringattributes` | Set "Select columns" |
| RES03 | `Recurrence` every 1–5 minutes (or seconds) | Use an event trigger or a longer interval |
| RES04 | List rows / Get items without `$select`, or without `$filter` / `$top` | Add select / filter / top |
| RES05 | `paginationPolicy.minimumItemCount` very high | Lower it, or filter at the source |
| RES06 📊 | High estimated actions per run (Σ loop iterations × actions inside the loop) | Show the projected daily count against the owner's licence limits (informational) |
| RES07 | Update a row sending many columns, or using the trigger body as-is | Send only changed columns (avoids triggering other automations) |

### Reliability
| ID | Detects | Recommendation |
|---|---|---|
| REL01 | Loop concurrency on **and** variables written inside the loop | Race condition. Fix before speeding up |
| REL02 | No error handling (no Scope with a catch branch using `runAfter` Failed/TimedOut) | Try/Catch/Finally scope pattern |
| REL03 📊 | Default or aggressive retry policy on slow/flaky actions; many 429s | Tune `retryPolicy`; reduce the number of calls |
| REL04 | `Until` relying on default limits (count 60, timeout PT1H) | Set explicit limits and handle the timeout |
| REL05 | Close to platform limits (500 actions per flow, nesting depth 8) | Split into child flows |
| REL06 | Trigger concurrency limited to 1 on a busy trigger (runs queue up) | Review whether serial runs are really needed |

### Maintainability (optional, off by default)
| ID | Detects |
|---|---|
| MNT01 | Hard-coded GUIDs, URLs, emails → use environment variables |
| MNT02 | Default action names (`Compose_3`, `Condition_2`) |
| MNT03 | Scopes and actions with no descriptive name or note |

> Before building each rule, check the facts against Microsoft docs (limits, defaults, operation IDs) and record the source in the rule's `docs` field.

---

## 5. Scoring
- Each finding has a weight from its severity × confidence. 📊 findings use measured impact (time share, requests per day).
- Category score 0–100 → letter grade A–F. Overall = weighted average (speed 40%, resources 35%, reliability 25%; maintainability excluded by default).
- **Estimated actions per run:** walk the definition; loops multiply their inner count by the median iteration count measured from runs, or by a configurable default (e.g. 50) with the default flagged.
- Findings marked "accepted" (stored locally by flow ID + rule ID + action path) don't count toward the score.

---

## 6. Architecture

```
 make.powerautomate.com tab                 Extension
┌────────────────────────┐   requests   ┌───────────────────────────────┐
│ portal calls           │ ───────────▶ │ background service worker     │
│ api.flow / powerplatform│  (headers)  │  • captures Authorization and │
└────────────────────────┘              │    base URL per portal tab    │
                                        │  • keeps token in memory only │
                                        └──────────────┬────────────────┘
                                                       │ runtime messages
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

### Repo layout (pnpm workspaces)
```
packages/core/        # parser, rules, run stats, scoring, types (pure TS, Vitest)
packages/ui/          # shared React components (Flow list, report, tree, run profile)
apps/extension/       # MV3 manifest, background worker, app tab entry
apps/demo/            # GitHub Pages demo: sample flows + "paste definition JSON" mode
fixtures/flows/       # anonymised flow definitions + run payloads (one or more per rule)
docs/                 # plan, rule docs (one page per rule), ADRs
```

### Key types (sketch)
```ts
type ActionNode = {
  id: string; name: string; type: string;          // Foreach, If, Scope, Switch, Until, OpenApiConnection, Http, Workflow, SetVariable…
  path: string[];                                   // e.g. ["Try", "Apply_to_each", "Get_a_row"]
  runAfter: Record<string, string[]>;
  inputs?: unknown; operationId?: string; connector?: string;
  settings: { concurrency?: number; retryPolicy?: unknown; pagination?: number; limit?: { count?: number; timeout?: string } };
  children: ActionNode[];                           // flattened from actions / else.actions / cases.*.actions / default.actions
  depth: number;
};
type Finding = {
  ruleId: string; category: 'speed'|'resources'|'reliability'|'maintainability';
  severity: 'high'|'medium'|'low'; actionPath: string[];
  message: string; evidence?: { timeSharePct?: number; iterationsP50?: number; retries429?: number; requestsPerDay?: number };
  fix: string; docs: string; confidence: number;    // 0..1
};
type ActionRunStats = { path: string[]; samples: number; p50Ms: number; p95Ms: number; timeSharePct: number; iterationsP50?: number; retries429: number; failures: number };
```

### Parser notes (workflow definition schema)
- Triggers: `definition.triggers`. Trigger conditions are in `conditions[]`, trigger concurrency in `runtimeConfiguration.concurrency.runs`.
- Nested actions: `actions` (Scope / Foreach / Until / If-true), `else.actions` (If), `cases.<name>.actions` and `default.actions` (Switch).
- Loop concurrency: `runtimeConfiguration.concurrency.repetitions`. Pagination: `runtimeConfiguration.paginationPolicy.minimumItemCount`.
- Connector actions: `type: OpenApiConnection`, `inputs.host.operationId` (e.g. `ListRecords`, `GetItem`, `UpdateRecord`), `inputs.parameters` (`$select`, `$filter`, `$top`…).
- Dataverse trigger: `operationId: SubscribeWebhookTrigger` with `subscriptionRequest/message`, `subscriptionRequest/entityname`, `subscriptionRequest/filteringattributes`, `subscriptionRequest/filterexpression`.
- Child flow: `type: Workflow`. Variables: `InitializeVariable`, `SetVariable`, `AppendToArrayVariable`, `IncrementVariable`…
- Handle expressions (`@{…}`, `@body('X')`) as strings. SPD06/SPD09 need a simple dependency extractor (the `body('…')`, `outputs('…')`, `items('…')` references).

### Power Automate API (confirm in spike S1)
Based on the Logic Apps-style API the portal uses; exact paths and api-versions must be checked against the live portal:
- List environments / flows: `…/providers/Microsoft.ProcessSimple/environments/{env}/flows`
- Get flow with definition: `…/flows/{flowId}` (check whether an `$expand` is needed for the definition)
- Runs: `…/flows/{flowId}/runs?$top=N`
- Run actions: `…/flows/{flowId}/runs/{runId}/actions`
- Loop repetitions: `…/runs/{runId}/actions/{actionName}/repetitions`
- Retry info: action results may include `retryHistory`

---

## 7. Run analysis design
- **Sampling:** default the last 20 runs (configurable 5–100), plus a "slowest runs" mode.
- **Per run:** fetch actions; fetch repetitions only for loops, capped per loop to avoid huge traffic.
- **Rate limiting:** a queue with at most 4 requests at once, backing off on 429 (respect `Retry-After`); progress bar and cancel button.
- **Caching:** runs never change once finished, so cache them permanently in IndexedDB (keyed by run ID). Definitions are keyed by flow ID + `lastModifiedTime`.
- **Statistics:** per-action median/95th percentile, time share of the run, iteration counts, throttled retries, failures. Handle missing or skipped actions.

---

## 8. Security and privacy
- **Read-only:** only GET requests to the Power Automate API. Never create, update or delete flows.
- **Token:** kept only in the service worker's memory, sent to the app tab via runtime messages, **never written to disk** (not IndexedDB, not `chrome.storage`). Never logged.
- **No outside calls:** no analytics, telemetry or remote code. Content Security Policy blocks remote scripts.
- **Minimal permissions:** `webRequest` (read headers only, no blocking), `tabs`, `storage`; host permissions for `*.api.flow.microsoft.com`, `*.api.powerplatform.com`, `make.powerautomate.com`.
- **Cache data:** flow definitions can contain sensitive values, so offer a "Clear cache" button and state in the README what's stored locally.
- **Fixtures:** must be anonymised before they go in the public repo.

---

## 9. Stack
| Area | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Shared types between core and UI |
| Extension | Manifest V3, Vite (a CRXJS-style plugin or a plain multi-entry build) | Current standard; fast builds |
| UI | React 18/19 + **Fluent UI React v9** | Looks like Power Platform |
| Charts | Small custom SVG (bars, action tree) | No heavy charting library needed |
| Storage | IndexedDB via `idb` | Caches runs and definitions; stores accepted findings |
| Tests | Vitest (core + UI components), Playwright (demo site e2e; extension e2e via a persistent Chromium context) | Rules must be test-driven |
| CI | GitHub Actions: lint, typecheck, test, build the extension zip, deploy the demo to Pages | Free |
| Quality | ESLint + Prettier, Dependabot, CodeQL | Free on GitHub |
| Licence | MIT (don't copy GPL code from Power Automate Tools) | Portfolio-friendly |

**Distribution:**
- GitHub Releases zip (free; load unpacked)
- **Edge Add-ons** (free)
- Chrome Web Store (optional, $5 one-time developer fee)

---

## 10. Milestones

### M0: Spikes (de-risk first)
- **S1 Token and API:** capture the token from the current portal (both hosts); list environments and flows; fetch one definition. *Done when a JSON definition of a non-solution flow and of a solution flow are both logged.*
- **S2 Run payloads:** fetch runs, actions and loop repetitions for a looping flow; confirm the timing fields and retry info; measure request counts and throttling.
- **S3 Parser coverage:** parse 20+ real (anonymised) definitions covering Scope, If, Switch, Foreach, Until, Workflow and HTTP without errors.

### v0.1: Definition analysis
- Extension shell, token capture, environment picker, Flows list.
- Parser → ActionTree; Flow report with the action tree.
- Rules that need no run data: SPD02, SPD04, SPD10, RES02, RES03, RES04, REL01, REL04, each with fixtures and tests.
- *Done when:* analysing a real flow shows correct findings pinned to the right actions.

### v0.2: Run analysis
- Sampling, rate-limited queue, IndexedDB cache, Run profile page.
- 📊 rules: SPD01, SPD03, SPD07, RES01, RES06, REL03; estimated vs. measured actions per run.
- *Done when:* the slowest action and loop iteration numbers match what the portal's run history shows.

### v0.3: Environment and scoring
- "Analyse all" (definition-only) with scores in the Flows list; filters.
- Accepted findings; remaining rules (SPD05/06/08/09, RES05/07, REL02/05/06).
- Demo site on GitHub Pages: sample flows plus a "paste a flow definition JSON" mode.

### v1.0: Polish and publish
- Export the report (Markdown/HTML), docs page per rule, README GIF, accessibility check, Edge Add-ons listing (+ optional Chrome Web Store).

---

## 11. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Portal API or hosts change (undocumented) | Extension breaks | All calls in one `api/` module; support both hosts; spike S1; clear error messages |
| Token expires (~1 h) | Requests fail | Detect 401 → banner "refresh the portal tab"; pick up new tokens automatically |
| Throttling while sampling runs | Slow or failed analysis | Concurrency cap, backoff, cache, sample limits |
| Wrong recommendations (e.g. concurrency with shared state) | User breaks a flow | Guard rules (REL01 blocks SPD01); a confidence value on each finding; "why" text; fixtures for edge cases |
| Store review over reading auth headers | Listing rejected | Precedent (Power Automate Tools); minimal permissions; clear privacy policy; read-only |
| Sensitive data in fixtures or cache | Privacy leak | Anonymise fixtures; clear-cache button; token never stored |

---

## 12. Open questions
1. Final name: **Cloud Flow Analyzer** (recommended) vs. Cloud Flow Optimizer. See section 13.
2. Default run sample size and the per-loop repetition cap.
3. Include the Maintainability category in v0.x, or leave it for later?
4. Publish to the Chrome Web Store ($5) or only Edge Add-ons + GitHub Releases?
5. Should licence limits (requests per day per licence) be shown? They vary by licence and change over time, so a user-set limit may be safer than built-in numbers.

---

## 13. Name check (2026-09-25)
| Name | npm | GitHub (exact / similar) | Notes |
|---|---|---|---|
| **cloud-flow-analyzer** ✅ recommended | free | 0 / 1 (unrelated) | Accurate for a read-only tool |
| cloud-flow-optimizer | free | 0 / 1 (unrelated) | Catchier, but suggests it changes flows |
| cloud-flow-inspector | free | 0 / 0 | Alternative |
| flow-optimizer / flow-analyzer / flow-doctor | free | 3–9 exact matches | Too generic, crowded |
| flow-inspector | **taken** on npm | 6 exact | Avoid |
| Cloud Flow Viewer | — | — | Name of an existing tool; avoid "viewer" |

Suggested tagline: *"Cloud Flow Analyzer: speed and resource recommendations for Power Automate cloud flows."* Package scope idea: `@cfa/core`.

---

## 14. Sources
- Cloud flow run history in Dataverse: https://learn.microsoft.com/en-us/power-automate/dataverse/cloud-flow-run-metadata
- Flow Log (flowlog) table: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/flowlog
- Work with cloud flows using code: https://learn.microsoft.com/en-us/power-automate/manage-flows-with-code
- Process insights for cloud flows (preview): https://learn.microsoft.com/en-us/power-automate/process-mining-cloud-flow-process-insights
- Troubleshoot slow-running flows: https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/flow-run-issues/troubleshoot-slow-running-flows
- Limits and configuration: https://learn.microsoft.com/en-us/power-automate/limits-and-config
- Power Automate performance standards (Matthew Devaney): https://www.matthewdevaney.com/power-automate-coding-standards-for-cloud-flows/power-automate-standards-performance-optimization/
- Power Automate Tools (token approach, GPL-3): https://github.com/rithala/power-automate-tools
- FlowLens: https://github.com/Yolostream/FlowLens · powerautomate-lint: https://github.com/verseblocks/powerautomate-lint
- Flow Studio monitoring: https://awesome-copilot.github.com/skill/flowstudio-power-automate-monitoring/
- Cloud Flow Viewer: https://rajeevpentyala.com/2025/10/16/new-tool-cloud-flow-viewer-for-power-automate-solutions/
