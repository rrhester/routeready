// Single source of the checklist "is this instance complete?" rule.
//
// Mirrors private.checklist_instance_reconcile (migration 0436): an instance
// is complete when every REQUIRED item is done; if there are no required
// items, fall back to "every item done" so all-optional checklists can still
// finish; an empty checklist never completes.
//
// This used to be duplicated: dashboard/live.js carried the runner-UI copy
// (keyed on completed_at) and scripts/test-checklist-completion.mjs carried a
// hand-mirrored copy (keyed on a `done` flag), which could silently drift
// (project-review PR#19). Both now call this one function; `isDone(item)`
// adapts it to each caller's item shape — live.js passes
// `i => !!i.completed_at`, the tests pass `i => i.done`.

export function isChecklistComplete(items, isDone = (i) => !!i.done) {
  const list = items || [];
  const required = list.filter((i) => i.required);
  if (required.length > 0) return required.every(isDone);
  return list.length > 0 && list.every(isDone);
}
