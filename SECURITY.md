# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a
vulnerability** on this repository, rather than in a public issue.

Only the latest release is supported.

## How the extension is built to be safe

The extension handles a Power Automate access token, so it is built around a few rules.

| Area          | What the extension does                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token         | Read from the maker portal's own requests to the Power Automate and Power Platform APIs (`webRequest`, headers only, never blocking). Kept in `chrome.storage.session` (memory), never on disk, never logged, never in capture files or messages to pages. |
| Where it goes | Only to the same two API hosts, over HTTPS. The API client refuses any other host, and it can only send GET requests.                                                                                                                                      |
| Read-only     | Only GET requests. It never creates, changes or deletes flows or anything else.                                                                                                                                                                            |
| The page      | The analysis pane runs in a shadow root on the portal page. It only receives the analysis result from the worker, never the token, and writes text, never HTML.                                                                                            |
| Messages      | The worker accepts each message only from where it belongs: the pane in a maker portal tab, or the extension's own pages (`MESSAGE_SOURCES` in `src/shared/messages.ts`). Other extensions and web pages can't message it (no `externally_connectable`).   |
| Code          | No remote code, no `eval`, the default Manifest V3 content security policy, no analytics or telemetry.                                                                                                                                                     |
| Permissions   | `webRequest`, `storage`, `scripting`, and host access to the two APIs and the four maker portal hosts only. No `tabs` permission.                                                                                                                          |
| Data kept     | Dismissed findings and the daily limit (local storage), timings of runs read (IndexedDB, 30 days, clearable), Analyse all results (session). See the [privacy policy](https://leduc212.github.io/cloud-flow-analyzer/privacy.html).                        |
| Capture files | Built only when the user downloads one, anonymised by default (IDs, emails, URLs, names and literal values replaced; signed links removed).                                                                                                                |
| Supply chain  | Dependencies pinned in `pnpm-lock.yaml`, updated by Dependabot and checked in CI; CodeQL scans every push to `main`.                                                                                                                                       |
