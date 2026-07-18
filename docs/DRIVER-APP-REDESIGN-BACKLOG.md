# Driver-app redesign — remaining backlog

The driver-app redesign (`design/driver-app-redesign/PROPOSAL.md`) mostly
shipped in app versions v181/v182 (Today screen, tab rename, Messages inbox,
More hub, pickup-on-Today §9.5). These proposal items were **not** built and
have lived only in the proposal doc — captured here (project-review PR#44) so
they're tracked, with an explicit keep/drop decision each.

| # | Proposal item | Status | Notes |
| --- | --- | --- | --- |
| §9.1 | **Break tracking** on Today | Not built — **decide** | No backing data model yet (breaks aren't recorded anywhere). Needs a `driver_breaks` table + check-in/out UI before the Today affordance is meaningful. |
| §9.2 | **Server-side inspection gating of check-out** | Not built — **keep** | Today the DVIC inspection is client-encouraged, not enforced. Gating check-out server-side (reject `driver_checkout` without a completed inspection for the shift) is a real compliance win. |
| §9.4 | **One-tap sticky check-in with undo** | Not built — **keep (small)** | Reduce the check-in flow to a single tap with a few-second undo, instead of the current confirm step. Pure client UX. |
| §3 | **Concept-A timeline** as a "day detail" drill-in | Not built — **drop unless asked** | The timeline mock (screen 16) was a concept; the shipped Schedule view covers the need. Revisit only if drivers ask for an hour-by-hour view. |
| §9 | **"What changed" in-app note** for the Home→Today / Chat→Messages renames | Not built — **drop** | The renames shipped months ago; a migration note now is stale. Close. |

## How to use this

When one of these is picked up, delete its row here and let the code +
its PR be the record. If a row is decided "drop", delete it too. This file
should trend toward empty; when it's empty, delete it and archive
`PROPOSAL.md` under `design/`.
