# Cloud Flow Analyzer

Speed and resource recommendations for Power Automate cloud flows, right in your browser.

A read-only Edge/Chrome extension that reads your flows, finds slow or wasteful patterns, and
recommends the better, optimised pattern. No servers, no app registration, nothing leaves your
browser.

**Status:** M0 (spikes). The rule engine and a capture tool are ready; the full app comes in v0.1.
See the [project plan](docs/PLAN.md).

## What's here

| Path                 | What it is                                                                       |
| -------------------- | -------------------------------------------------------------------------------- |
| `packages/core`      | Flow parser, rules, scoring and anonymiser (pure TypeScript, no browser code)    |
| `apps/extension`     | Manifest V3 extension: popup, in-page analysis pane, token capture, capture tool |
| `fixtures/flows`     | Sample flows used by the tests (a "before" and "after" flow, a solution flow)    |
| `scripts/analyse.ts` | Analyse a flow file or a capture file from the command line                      |
| `docs/PLAN.md`       | Goals, rule catalogue, architecture, milestones                                  |

## Rules

| ID    | Category    | Finds                                                                        |
| ----- | ----------- | ---------------------------------------------------------------------------- |
| SPD01 | Speed       | 📊 Apply to each running one item at a time around connector calls           |
| SPD02 | Speed       | Variables written inside a loop (use Select / Filter array)                  |
| SPD03 | Speed       | 📊 Records read one at a time inside a loop (N+1 queries)                    |
| SPD04 | Speed       | Loop inside a loop                                                           |
| SPD05 | Speed       | Loop that only filters items with a Condition (filter before the loop)       |
| SPD07 | Speed       | 📊 Child flow called inside a loop                                           |
| SPD08 | Speed       | Polling with Do until and Delay                                              |
| SPD10 | Speed       | Loop over a query that returns one row                                       |
| RES01 | Resources   | 📊 Most runs stop at a first Condition a trigger condition could do instead  |
| RES02 | Resources   | Dataverse trigger without "Select columns"                                   |
| RES03 | Resources   | Recurrence every few minutes or seconds                                      |
| RES04 | Resources   | List query without column list, filter or row limit                          |
| RES08 | Resources   | 📊 One create / update / delete per loop item (use bulk or batch requests)   |
| REL01 | Reliability | Parallel loop writing variables (race condition)                             |
| REL02 | Reliability | No error handling (Try / Catch)                                              |
| REL03 | Reliability | Retry policy set to None                                                     |
| REL04 | Reliability | Do until with default limits                                                 |
| REL05 | Reliability | Close to the 500-action or 8-level nesting limits                            |
| REL07 | Reliability | Flow updates the table or list that triggers it (infinite loop)              |
| REL08 | Reliability | Error path that never ends the run as Failed (failures show as Succeeded)    |
| REL09 | Reliability | First item of a query read with `[0]` without checking the list is not empty |
| REL10 | Reliability | List query that silently stops at its default page (100 / 256 / 5,000 rows)  |
| SEC01 | Security    | Key Vault secret shown in run history (Secure inputs / outputs off)          |
| SEC02 | Security    | Password, API key or signature typed into an HTTP action                     |
| SEC03 | Security    | HTTP trigger that anyone with the URL can call                               |

📊 = uses measured numbers when you analyse recent runs (see step 7 below).

Each finding explains why it matters, how to fix it, and shows the better pattern.

**Grade.** Each category starts at 100 and loses points per finding (high 25, medium 10, low 3,
times the rule's confidence). The overall score weighs speed 35%, resources 25%, reliability 25%
and security 15%; A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50. While a high-severity security finding is
open, the grade can't be better than C.

## Using it

1. Load the extension (see step 1 and 2 below).
2. Open a flow in [make.powerautomate.com](https://make.powerautomate.com): its details page or
   the designer.
3. Click the extension icon, then **Analyse this flow**. A pane opens on the right with the
   grade and the findings.
4. Click an action name in a finding (⌖) to jump to it in the designer, even when it's far
   down the flow. Collapsed scopes, loops, Condition branches and Switch cases on the way are
   opened for you (only ones that are collapsed; nothing else in the designer is touched).
5. **Dismiss** findings you've decided to keep (remembered per flow in your browser and left out
   of the score), and **⧉ Copy report** to paste the findings as Markdown into a ticket or chat.
6. **How to fix** under each finding explains the better pattern, with a before/after and a link
   to the Microsoft docs.
7. **Analyse recent runs** reads the flow's last 20 finished runs: how long they took, where the
   time goes, how many items each loop handled, and which actions failed. Findings marked 📊 in
   the rules table then use the measured numbers (a loop taking 80% of the run weighs more than
   one taking 2%). Only timings, statuses and error codes are read, never the data inside the
   runs. They are kept in your browser so the same run isn't read twice (**Clear cached runs**
   removes them).

If clicking an action doesn't move the designer, open **Designer check** at the bottom of the
pane, copy it and send it to us.

## Capture tool (spikes S1–S3)

Step-by-step guide for capturing 20+ real flows: [docs/CAPTURE.md](docs/CAPTURE.md).

The capture tool collects real API responses from your tenant so the analyzer can be built and
checked against real flows. It only reads.

1. **Get the extension**, either:
   - from GitHub: open the latest **CI** run for this branch → **Artifacts** →
     `cloud-flow-analyzer-extension`, and unzip it; or
   - build it: `pnpm install && pnpm build`, then use `apps/extension/dist`.
2. **Load it:** open `edge://extensions` (or `chrome://extensions`), turn on **Developer mode**,
   click **Load unpacked** and pick the unzipped folder.
3. **Sign in:** open [make.powerautomate.com](https://make.powerautomate.com), pick an environment,
   and open a few flows and their run history. This lets the extension pick up the portal's
   token and see which API endpoints the portal uses.
4. **Open the capture tool:** click the extension's toolbar icon.
5. **Capture:** Load environments → pick one → Load flows (tick **Admin** if you're an
   environment admin) → select 20 or more flows. Include loops, conditions, switches, Do until,
   child flows, HTTP actions, and both solution and non-solution flows. Then **Capture selected
   flows** (5 runs per flow is enough).
6. **Check the findings** on the page and note anything that looks wrong.
7. **Download** the capture (anonymised by default). Open the file and check that nothing
   sensitive is left, then save it as `fixtures/captures/<yyyy-mm-dd>.json` and push it to the
   working branch. Raw (not anonymised) files end in `.raw.json` and are ignored by git.

### What the extension stores

- The portal's access token, only in `chrome.storage.session`: in memory, never on disk, cleared
  when the browser closes, and readable only by the extension itself. It's never logged and
  never written to a capture file.
- A list of API endpoints the portal called (IDs and names replaced), also in session storage.
- Captured responses stay in the capture page's memory until you download or clear them.

Permissions: `webRequest` (to read the portal's request headers; it never blocks or changes
requests), `storage`, `scripting` (to add the analysis pane to the portal page when you ask), and access to the Power Automate API hosts and the maker portals.

## Development

Needs Node 22 and pnpm 10.

```sh
pnpm install
pnpm check            # lint, format check, typecheck, tests, build
pnpm test             # unit tests
pnpm build && pnpm test:e2e   # browser tests: the built extension in Chromium
pnpm --filter @cfa/extension dev    # rebuild the extension on change
pnpm analyse fixtures/flows/sync-contacts-bad.json   # analyse a flow or capture file
```

## Licence

[MIT](LICENSE)
