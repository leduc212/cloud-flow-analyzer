# Cloud Flow Analyzer

Speed and resource recommendations for Power Automate cloud flows, right in your browser.

A read-only Edge/Chrome extension that reads your flows, finds slow or wasteful patterns, and
recommends the better, optimised pattern. No servers, no app registration, nothing leaves your
browser.

**Status:** M0 (spikes). The rule engine and a capture tool are ready; the full app comes in v0.1.
See the [project plan](docs/PLAN.md).

## What's here

| Path                 | What it is                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| `packages/core`      | Flow parser, rules, scoring and anonymiser (pure TypeScript, no browser code) |
| `apps/extension`     | Manifest V3 extension: token capture and the capture tool page                |
| `fixtures/flows`     | Sample flows used by the tests (a "before" and "after" flow, a solution flow) |
| `scripts/analyse.ts` | Analyse a flow file or a capture file from the command line                   |
| `docs/PLAN.md`       | Goals, rule catalogue, architecture, milestones                               |

## Rules in v0.1

| ID    | Category    | Finds                                                           |
| ----- | ----------- | --------------------------------------------------------------- |
| SPD01 | Speed       | Apply to each running one item at a time around connector calls |
| SPD02 | Speed       | Variables written inside a loop (use Select / Filter array)     |
| SPD03 | Speed       | Records read one at a time inside a loop (N+1 queries)          |
| SPD04 | Speed       | Loop inside a loop                                              |
| SPD07 | Speed       | Child flow called inside a loop                                 |
| SPD08 | Speed       | Polling with Do until and Delay                                 |
| SPD10 | Speed       | Loop over a query that returns one row                          |
| RES02 | Resources   | Dataverse trigger without "Select columns"                      |
| RES03 | Resources   | Recurrence every few minutes or seconds                         |
| RES04 | Resources   | List query without column list, filter or row limit             |
| REL01 | Reliability | Parallel loop writing variables (race condition)                |
| REL02 | Reliability | No error handling (Try / Catch)                                 |
| REL04 | Reliability | Do until with default limits                                    |
| REL05 | Reliability | Close to the 500-action or 8-level nesting limits               |

Each finding explains why it matters, how to fix it, and shows the better pattern.

## Capture tool (spikes S1–S3)

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
requests), `storage`, and access to the Power Automate API hosts and the maker portals.

## Development

Needs Node 22 and pnpm 10.

```sh
pnpm install
pnpm check            # lint, format check, typecheck, tests, build
pnpm test             # tests only
pnpm --filter @cfa/extension dev    # rebuild the extension on change
pnpm analyse fixtures/flows/sync-contacts-bad.json   # analyse a flow or capture file
```

## Licence

[MIT](LICENSE)
