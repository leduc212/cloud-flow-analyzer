# Changelog

## 1.1.0 (2026-10-06)

- **Runs page**: all of a flow's runs on one page (from the pane's **All runs ↗**, the extension
  button or the All flows page). Read the last 24 hours, 7 or 28 days of runs, then filter by
  duration (at least / at most), status and start time. A duration chart shows how runs spread
  out; click a bar to show the runs at least that long, or pick **Slowest 5%** or **2× the median
  or more**. Each run links to the portal and shows how it compares with the median. **Analyse
  matching runs** shows where the time goes in the slowest of them; export as CSV or Markdown.
- **This run**: on a run's page, the pane shows the run that started it (a parent flow's run and
  the Run a Child Flow step that called it, or the run it was resubmitted from) and the child flow
  runs it started, with status, duration and a link to each. Runs are matched by the tracking ID
  runs in a chain share, and by time; only run lists are read, never inputs or outputs.

## 1.0.2 (2026-09-28)

- Collapsed Condition branches now open on the way to an action. The designer's branch card is
  itself the toggle; the chevron inside it is a disabled icon, which is what was being clicked.
  Toggles are also pressed the way a mouse does (down, up, then click), then with Enter.
- When a toggle still won't open, the designer check lists what was tried and how the card is
  built, to help find out why.

## 1.0.1 (2026-09-28)

- Jumping to an action now walks the flow's structure: it finds actions deep inside nested
  Conditions, Scopes and loops, in either branch and far down the canvas, instead of panning
  around and giving up. If a branch or step won't open when clicked, it stops there and
  highlights it.
- The release notes say which zip to download (the extension, not "Source code").

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
