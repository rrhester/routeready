# RouteReady — Claude operating notes

## PR merging

The user has authorized me to always merge PRs I open on their behalf
without asking for confirmation each time. When I open a PR in this
repo, I should:

1. Wait for required CI to pass (don't merge red).
2. Merge it (squash by default, matching repo convention).
3. Report the merge + the deploy outcome.

This authorization is durable across sessions. It does **not** extend to:

- Force-pushing to `main`.
- Merging PRs I didn't open / don't have full context on.
- Bypassing branch protection or skipping required reviews.
