# Capturing real flows (spike S3)

The rules are only as good as the flows they're tested on. A capture of 20–30 real flows lets us
fix false alarms and missed patterns. It takes about 15 minutes.

## 1. Before you start

- Use the latest build of the extension (from the latest CI run or release), loaded in Edge or
  Chrome.
- Open [make.powerautomate.com](https://make.powerautomate.com), sign in, and open any flow in the
  designer once. The extension picks up your sign-in from the portal's own requests.

## 2. Open the capture tool

Click the extension icon → **Open capture tool**.

In **1. Connection**, both lines should show ✓. Leave **API host** on
`https://api.flow.microsoft.com`. If a line shows "not captured yet", refresh the portal tab.

## 3. Pick the environment and load flows

1. **Load environments**, then pick the environment with the most real flows.
2. Tick **Default list** and **Admin: all flows in the environment** (Admin only works if you're an
   environment admin; that's fine either way). Click **Load flows**.

## 4. Choose 20–30 flows

Tick flows that together cover as many of these as you can:

- [ ] Apply to each: some with concurrency on, some off, some nested (a loop inside a loop)
- [ ] Do until loops (especially ones with a Delay inside)
- [ ] Conditions and Switch cases
- [ ] Scopes (for example Try / Catch)
- [ ] Run a Child Flow
- [ ] Dataverse: triggers ("When a row is added, modified or deleted") and List rows / Get a row
- [ ] SharePoint (Get items / Get item) and Excel
- [ ] HTTP actions
- [ ] Scheduled flows (Recurrence trigger)
- [ ] Big flows (100+ actions) and small ones
- [ ] Solution flows and non-solution flows
- [ ] **A few flows you consider well built.** These catch false alarms. Note their names.

Stopped or old flows are fine too.

## 5. Capture

- **Runs per flow: 3** and **Repetition pages per loop action: 1** keep the file small enough
  for GitHub.
- Click **Capture selected flows** and wait (a few minutes for 25 flows). "Throttled (429)" in
  the summary is normal; the tool waits and retries.

## 6. Check the findings

Open **4. Findings** and write down anything that looks wrong or missing, as
`flow name — rule ID — what's wrong`. For example:
`Sync contacts — SPD03 — this Get a row is outside the loop, shouldn't be flagged`.

## 7. Download and review

1. Keep **Anonymise** ticked and click **Download capture**.
2. Open the file in VS Code and search (Ctrl+F) for anything that must not be shared:
   your company or customer names, people's names, email domains (`@`), `sharepoint.com`,
   `dynamics.com`, and literal values you recognise. Action and column names are kept on purpose
   (the rules need them); literal values, IDs, emails and URLs are replaced.
3. If you find something sensitive, don't commit the file. Tell us what it was so the anonymiser
   can be fixed, then capture again.
4. If the file is over 50 MB, capture fewer flows or runs per file (GitHub rejects files over
   100 MB).

## 8. Commit it

If the branch history was rewritten (for example to remove a leaked value), first bring your
clone up to date **without merging**:

```sh
git fetch origin
git switch claude/practical-archimedes-h8qw09
git reset --hard origin/claude/practical-archimedes-h8qw09
```

Then add the capture and remove the old one (its filters were damaged by an earlier anonymiser):

```sh
git rm fixtures/captures/cfa-capture-202609250431.anonymised.json
copy <download folder>\cfa-capture-<…>.anonymised.json fixtures\captures\2026-09-26.json
git add fixtures/captures/2026-09-26.json
git commit -m "add: capture of 25 flows"
git push
```

Finally, send your notes from step 6.
