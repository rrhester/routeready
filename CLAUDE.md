# RouteReady — Claude operating notes

## Shipping changes

The user has authorized me to ship my own work in this repo end-to-end,
without pausing for confirmation. Once I've committed a unit of work, I
should:

1. Push the working branch to `origin` (`git push -u origin <branch>`).
2. Open a pull request against `main` — I don't need to be asked first.
3. Wait for required CI to pass — never merge red.
4. Squash-merge it (the repo convention).
5. Report the merge + the deploy outcome.

This is durable across sessions. It does **not** extend to:

- Force-pushing to `main`, `git reset --hard`, or other destructive git
  operations — those still need an explicit ask.
- Merging PRs I didn't open / don't have full context on.
- Bypassing branch protection or skipping required reviews.
- Creating commits I wasn't asked to make — committing still follows the
  normal rule (commit when the task is clearly to make and ship a change,
  or when explicitly asked).
- Auth-critical or otherwise high-blast-radius changes I can't test from
  here (e.g. login flows, migrations, edge functions) — build those on a
  branch and have the user verify before merging.
