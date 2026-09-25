# Changelog

## 1.0.0 (2026-09-25)

First public release.

**In the maker portal (the pane)**

- **Analyse this flow** from the extension button: grade, scores for speed, resources,
  reliability and security, and findings next to the designer, each with why it matters, how to
  fix it, a before/after, the rule's page and Microsoft docs.
- Click a finding's step to jump to it in the designer, opening collapsed scopes, loops,
  Condition branches and Switch cases on the way.
- **Analyse recent runs** (or the slowest of the last 100): where the time goes, loop sizes,
  failures, retries and throttling, requests per run and per day against the daily limit you
  pick. Findings and the grade then use the measured numbers. Stop keeps what was read; finished
  runs are cached (timings only, 30 days, clearable).
- Dismiss findings (remembered per flow, left out of the grade) and copy the report as Markdown.

**All flows**

- Every flow in an environment with its grade and top findings, worst first; filters, search,
  Markdown summary, and Open to jump to a flow with its pane.

**Rules (30)**

- Speed: SPD01–05, SPD07–10. Resources: RES01–04, RES06–08. Reliability: REL01–10.
  Security: SEC01–03. Maintainability: MNT02 (not in the grade).
- See <https://leduc212.github.io/cloud-flow-analyzer/rules.html>.

**Also**

- Project site with a paste-a-flow demo, rule docs and the privacy policy.
- Read-only, no server, token kept in memory only; messages to the worker checked by sender;
  CodeQL and accessibility (axe, WCAG 2.1 AA) checks in CI.
