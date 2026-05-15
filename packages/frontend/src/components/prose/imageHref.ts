// RFC-008 T1 — resolve an `<img src="...">` href for the Prose renderer.
//
// Moved out of `MarkdownView.tsx:resolveImageHref` so T3 can delete the old
// renderer without dragging this helper along. Pure function; covered by
// `tests/prose-image-href.test.ts`.
//
// Rules:
//   - absolute URLs (http: / https: / data: / blob: / protocol-relative) pass through
//   - workspace-relative paths are rewritten to /api/worktree-files/{taskId}/{path}
//     when a taskId is provided
//   - without taskId, the original href stays (broken-image is visible during preview)
export function resolveImageHref(href: string, taskId: string | undefined): string {
  if (href.length === 0) return href
  if (/^(?:[a-z]+:|\/\/)/i.test(href)) return href
  if (taskId === undefined || taskId.length === 0) return href
  const clean = href.replace(/^\.\//, '').replace(/^\/+/, '')
  return `/api/worktree-files/${encodeURIComponent(taskId)}/${clean}`
}
