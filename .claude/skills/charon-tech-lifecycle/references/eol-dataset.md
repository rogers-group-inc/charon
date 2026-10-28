# The EOL dataset

## Where it lives, and why there

`scripts/data/platformEol.json` — beside the checker that reads it. Charon has no in-app EOL
surface, so the dataset is a build-time input only: `check:versions` warns when a pinned track is
past its `eol`. Nothing fetches it at runtime.

## Schema

```
{
  schemaVersion: 1,
  reviewedAt: "YYYY-MM-DD",          // check:versions warns past 120 days
  sourceNotes: string,
  technologies: [{
    id, label,                         // id matches a family's eolId in check-versions.mjs
    charonMinimum, charonTarget,       // project decisions, not refresh data
    source,                            // the URL actually read
    sourceCheckedOn: "YYYY-MM-DD",
    confidence: "vendor" | "aggregator",
    notes,
    tracks: [{ track, released?, lts?, maintenanceStarts?, eol: "YYYY-MM-DD" | null, supported? }]
  }]
}
```

## Authoritative page per family

| Family | Where the truth is |
|---|---|
| Node.js | `nodejs/Release` `schedule.json` |
| PostgreSQL | postgresql.org → Support → Versioning policy |
| OpenSSL | openssl-library.org → Policies → Release strategy |

## How to verify a date

1. Open the family's vendor page and read the row for the track. Do not infer a date from a blog
   post or a release announcement.
2. Record the URL you actually read in `source` and today's date in `sourceCheckedOn`. If you only
   got it from an aggregator, say so with `confidence: "aggregator"`.
3. When a vendor states a rule instead of a date ("five years after release"), compute the date
   and put the rule in `notes` so the next refresh can check the arithmetic.
4. If a track has no announced EOL, use `eol: null`. Never invent a plausible date — a wrong date
   either cries wolf or hides a real end-of-life. Both are worse than an honest "unknown".

## The refresh procedure

Quarterly, plus on any version bump, plus before any named release.

1. Start a worktree and write `WORKLOCK` (the standard session workflow).
2. For each technology, re-read its `source`. Only `eol`, `maintenanceStarts`, new tracks and
   `sourceCheckedOn` change without a deliberate decision.
3. Add newly released tracks. Remove nothing: a long-dead track is still the right answer for a
   host running it.
4. Bump the top-level `reviewedAt`.
5. A **new** technology needs three things: the dataset entry, a family in
   version-pin-inventory.md, and a family in `scripts/check-versions.mjs`.
6. Run `npm run check:versions`.
7. Review the diff **per file** before committing — CRLF flips land silently.
8. Commit on its own: `chore(lifecycle): refresh EOL dataset (checked YYYY-MM-DD)`.

## Human review

The refresh commit is never merged unreviewed. These dates drive production change windows.
Claude drafts the dates and the playbooks; a human confirms them and decides the upgrade schedule.
