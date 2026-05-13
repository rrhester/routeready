# RouteReady — Claude operating notes

## Shipping changes

The user has authorized me to ship my own work in this repo end-to-end,
without pausing for confirmation — push **and merge** automatically
(reaffirmed 2026-05-13). Once I've committed a unit of work, I should:

1. Push the working branch to `origin` (`git push -u origin <branch>`).
2. Open a pull request against `main` — I don't need to be asked first.
3. Wait for required CI to pass — never merge red.
4. Squash-merge it (the repo convention) — don't wait for the user.
5. Report the merge + the deploy outcome.

This is durable across sessions. It does **not** extend to:

- Force-pushing to `main`, `git reset --hard`, or other destructive git
  operations — those still need an explicit ask.
- Merging PRs I didn't open / don't have full context on.
- Bypassing branch protection or skipping required reviews — if CI is red
  or a required review is missing, leave it open and report why.
- Creating commits I wasn't asked to make — committing still follows the
  normal rule (commit when the task is clearly to make and ship a change,
  or when explicitly asked).

For auth-critical or otherwise high-blast-radius changes I can't fully
test from here (login flows, DB migrations, edge functions): still ship
them on the same PR, but call them out prominently in the PR body so the
user can review post-merge / coordinate the deploy. Merge once CI is
green like anything else — don't block on verification unless the user
has said otherwise for that specific change.
