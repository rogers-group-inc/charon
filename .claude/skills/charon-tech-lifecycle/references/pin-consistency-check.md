# check:versions — what it asserts and how to fix a failure

`scripts/check-versions.mjs`, run by `npm run check:versions`, the pre-commit hook (when a
pin-bearing file is staged) and `.github/workflows/check-docs.yml`.

| Check | Fails / warns when | Fix |
|---|---|---|
| site found | fail: a listed site no longer matches its regex | the file moved or its form changed — update `FAMILIES` and version-pin-inventory.md together |
| pins agree | fail: two pin sites of one family disagree | finish the bump in the missed site(s) |
| floors agree | fail: two floor sites disagree | move the floors together |
| floor ≤ pin | fail: a floor exceeds the pin | the bump moved the floor first — move the pin too, or revert the floor |
| dataset parses + sourced | fail: bad JSON, or a technology without `source` / `sourceCheckedOn` | fix the dataset (eol-dataset.md) |
| dataset fresh | warn: `reviewedAt` older than 120 days | run the refresh procedure |
| pinned track supported | warn: the pinned track's `eol` has passed, or the pin has no track | plan the upgrade (upgrade-playbooks.md); add the track |

Whole-line comments (`#`, `//`) are blanked before matching pin and floor sites, so a commented
example never reads as a pin. Prose sites match the raw text.

`--json` prints `{ ok, results, failures, warnings }` for scripting.
