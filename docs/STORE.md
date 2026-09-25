# Store listing (Microsoft Edge Add-ons, Chrome Web Store)

Everything the store forms ask for. The package is the `cloud-flow-analyzer-v<version>.zip`
attached to each [GitHub release](https://github.com/leduc212/cloud-flow-analyzer/releases).

## Basics

- **Name:** Cloud Flow Analyzer
- **Short description (≤ 132 characters):** Finds slow, wasteful and fragile patterns in Power
  Automate cloud flows, and shows the better pattern for each.
- **Category:** Developer tools (Edge) / Developer Tools (Chrome)
- **Language:** English
- **Website:** <https://leduc212.github.io/cloud-flow-analyzer/>
- **Support:** <https://github.com/leduc212/cloud-flow-analyzer/issues>
- **Privacy policy:** <https://leduc212.github.io/cloud-flow-analyzer/privacy.html>

## Description

Cloud Flow Analyzer reviews your Power Automate cloud flows the way an experienced maker would,
right next to the designer.

Open a flow in make.powerautomate.com, click the extension and choose Analyse this flow. A pane
shows a grade, scores for speed, resources, reliability and security, and every problem found:
loops that run one item at a time, data read once per item, triggers that fire on every change,
writes that could be batched, missing error handling, queries that silently stop at 100 or
5,000 rows, secrets visible in run history, and more (30 rules based on Microsoft's guidance).
Each finding explains why it matters, how to fix it, and shows the better pattern. Click a
finding to jump to the step in the designer.

Analyse recent runs to see where the time really goes, how many items each loop handled, which
calls were throttled, and how many requests the flow makes a day against your licence's limit.
All flows grades every flow in an environment, worst first.

Read-only and private: it uses the sign-in you already have in the portal, only reads flows and
run history from Microsoft's APIs, and sends nothing anywhere else. No account, no server, no
tracking. Open source (MIT).

Not affiliated with Microsoft.

## Single purpose

Analyse Power Automate cloud flows (definitions and run history) and recommend better patterns,
inside the Power Automate maker portal.

## Permission justifications

| Permission                                                                                    | Why                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webRequest`                                                                                  | To read the access token from the maker portal's own requests to the Power Automate and Power Platform APIs, so the extension can read flows with the user's existing sign-in. Headers only; nothing is blocked or changed. |
| `storage`                                                                                     | To keep the token in session memory, and the user's dismissed findings and daily limit.                                                                                                                                     |
| `scripting`                                                                                   | To add the analysis pane to the maker portal tab when the user asks for an analysis.                                                                                                                                        |
| Host access: `*.api.flow.microsoft.com`, `*.api.powerplatform.com`                            | The Power Automate and Power Platform APIs the extension reads flow definitions and run history from (GET only).                                                                                                            |
| Host access: `make.powerautomate.com`, `make.powerapps.com` (and their `make.preview.` hosts) | The maker portals: where the pane is shown, and whose API requests carry the sign-in token.                                                                                                                                 |

Remote code: none. Data use: no data is collected, sold or transferred.

## Notes for reviewers

The extension needs a Microsoft work or school account with Power Automate. To test:

1. Sign in to <https://make.powerautomate.com> and open any cloud flow (details page or designer).
2. Click the extension icon → **Analyse this flow**. The pane opens on the right with findings.
3. In the pane, **Analyse recent runs** reads the flow's run history (if it has runs).
4. From the extension icon, **All flows in this environment** lists and grades every flow.

Without an account, the same analysis can be tried on sample flows at
<https://leduc212.github.io/cloud-flow-analyzer/>.

## Screenshots

1280 × 800 PNGs. Take them in the real portal (the ones in `docs/images` use a test designer):
the pane with findings, the pane after Analyse recent runs, the All flows page.
