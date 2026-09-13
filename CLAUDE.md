# MagLens

Answers one question from live data: **which magazine should I buy this month?**,
scoped to what is actually on sale in India. Static, no build step, no
dependencies, no backend: `index.html` + `styles.css` + `app.js` served from the
repository root. `app.js` is a single ~6k-line file — that is deliberate, not
technical debt to "fix".

## Working agreements

- **One `APP_VERSION` bump per request.** One request = one bump, one commit, one
  push. Never bump incrementally mid-task. The value is rendered in the header
  badge, so it is how Nitin tells whether a deploy has landed.
- **Finish the job.** A request is not done when the code works — it is done when
  `spec.md` has the new section, `README.md` matches the behaviour, the version
  is bumped, and the work is committed **and pushed**. Do not stop at "here are
  the changes" and wait to be asked.
- **Answer concisely.** Short, direct replies. Detailed prose belongs in code
  comments, commit messages and `spec.md`, not in chat.
- **Commits carry the `Co-Authored-By: Claude Opus 5` trailer** in this repo.
  (CineLens forbids it — the two repos differ, check before assuming.)
- **Write files with LF endings.** The repo stores LF and `core.autocrlf=true`.
  Python's text mode rewrites the whole file to CRLF on Windows and turns a
  600-line diff into a 12,000-line one. Use node for scripted edits, or
  normalise afterwards and confirm with `git diff --stat`.

## Release checks

```sh
node --check app.js
git diff --check
git diff --stat      # confirm the diff is the size the change actually is
```

## Testing

**Nitin does the browser testing.** Claude reads the real code path, runs the
checks above, and verifies at logic/UI level when warranted. No assertion suite
is kept in the repository, and none is to be created — `spec.md` §3 records that
decision. Throwaway harnesses go in the session scratchpad and are deleted.

Two harness shapes have earned their keep and are worth rebuilding when needed:

- **Logic harness** — slice the pure-logic region of `app.js` (constants through
  ranking, stopping before the first view function), `eval` it with a stub
  `document`, and drive `rankAll` / `buildTaste` / `pickComparison` against a
  synthetic corpus. This is how the v3 ranking defects were measured rather than
  argued about. **Vary the fixture's scalars** — a corpus where every title sits
  at 0.5 visualness makes every candidate score 100% fit and hides the bug.
- **jsdom smoke test** — real `index.html`, real `app.js`, strip the boot call,
  render all five views and dispatch real clicks. jsdom 22; the current major
  fails to `require` under Node 20.

## Invariants worth knowing before editing

- **Filters are hard constraints and the learner may never write to them.**
  Language, price, format, audience and `hideExplicit` are the user's alone.
  Nothing the taste model believes can override one.
- **The ranker must never learn from its own output.** `view` is weight 0,
  `historyContext` reads previous months only, and the progression centroid is
  snapshotted *before* each event is applied. Every one of those was a bug once.
- **The model is rebuilt from the event log, never updated in place.** That is
  what makes deleting an event or clearing a vote exact rather than approximate.
- **`novelty` and `exploration` are cold-start terms** and must stay scaled by
  maturity. Both reward unfamiliarity, which a good match lacks by definition —
  at full weight they out-voted preference fit entirely (§4.3).
- **Pairwise learning records only the difference between two records.**
  Anything the pair shares must cancel; that is the whole mechanism, and it is
  what stops near-universal facets accumulating spurious evidence.
- **Source-specific extraction lives only inside `CONNECTORS`.** Nothing outside
  that section may know what a Magzter page looks like.
- **Never write a connector against markup you have not actually read.**
  Readwhere was once added on the assumption it sent CORS headers; it returned
  nothing in the browser while a Node harness reported success. If the page
  cannot be fetched, say so and leave it — see the `DIRECT_OK` comment and §4.8.
- **An unreadable price is flagged, never filtered out.** Dropping it would
  silently hide every print title whose publisher omits a number.

## Documentation

`spec.md` is the behavioural record, organised by version and appended to —
newer sections supersede older ones; mark stale passages as superseded rather
than rewriting history. Add a numbered section for substantive changes, at the
**end** of the file. `README.md` is the outward description and must be updated
when behaviour it describes changes.

## AI hand-off

When one AI takes over from another, the incoming AI must **read the previous
AI's chat history first** — not `CLAUDE.md` or `spec.md`. Claude Code sessions
live at `~/.claude/projects/<project-slug>/<session-id>.jsonl`; take the most
recently modified. The last few exchanges say what was being worked on and what
remains, which the static docs cannot.
