<!-- Squash-merge. Never merge red. See CONTRIBUTING.md. -->

## What & why

<!-- One or two sentences: what changes and the reason. -->

## Changes

<!-- Bullet the notable changes. -->
-

## Verification

<!-- How you checked it. Delete lines that don't apply. -->
- [ ] `npm run smoke` passes (parse + header parity + lint)
- [ ] `npm test` passes (if tested code changed)
- [ ] Ran locally / clicked through the affected UI (see docs/LOCAL-DEV.md)

## Migrations / secrets / deploy notes

<!-- Delete this section if none. -->
- [ ] Adds a migration → SQL pasted in the PR body for the operator to run;
      idempotent; next unused ordinal; anon RPCs `grant … to anon`.
- [ ] Changes a driver-shell asset → `SHELL_CACHE` bumped in `app/sw.js`.
- [ ] Touches `.github/workflows/**` → shipped as its own PR (Actions won't
      run CI on a workflow-editing PR).
- [ ] New runtime secret → documented in `supabase/SECRETS.md`.
