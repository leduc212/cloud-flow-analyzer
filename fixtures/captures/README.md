# Captures

Anonymised capture files from the extension's capture tool (spikes S1–S3), named
`<yyyy-mm-dd>.json`. Review each file before committing it: the anonymiser is best-effort.

Raw captures (`*.raw.json`, or anything under `raw/`) are ignored by git and must never be
committed.

Analyse a capture from the command line:

```sh
pnpm analyse fixtures/captures/<file>.json
```
