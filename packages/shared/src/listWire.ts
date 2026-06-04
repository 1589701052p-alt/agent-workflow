// RFC-060 / RFC-079 — list<T> wire-form item splitter.
//
// Kept in its own DEPENDENCY-FREE module (no imports) so the shared barrel can
// re-export it without pulling `outputKinds/list.ts` — which transitively
// imports the parametric OutputKindHandler registry. Re-exporting from
// `outputKinds/list.ts` added an `index.ts → list.ts → registry.ts → list.ts`
// init edge that, under `bun build --compile`, reordered module init so the
// registry's frozen handler array saw the list handler as `undefined`
// (`TypeError: undefined is not an object (evaluating 't.subReasons')`). Only
// the compiled single binary surfaces it; typecheck/tests do not. Keeping the
// splitter cycle-free is the fix.
//
// Wire form: a list<T> port's raw content is newline-separated entries; each
// non-empty trimmed line is one item, declaration order preserved. Blank lines
// (leading/trailing/between) are dropped. Empty list = empty string → [].

export function splitListItems(rawContent: string): string[] {
  return rawContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// -----------------------------------------------------------------------------
// RFC-081 — list<markdown> INLINE wire form.
//
// `list<path<md>>` items are single-line worktree paths, so the one-item-per-
// line `splitListItems` above works. `list<markdown>` items are multi-line
// document bodies, which newline-splitting cannot frame. Inline-body lists
// therefore separate documents with a BOUNDARY LINE: a line equal (after trim)
// to MARKDOWN_DOC_BOUNDARY. It is an HTML comment — valid markdown that renders
// to nothing and is vanishingly rare in real content. The list<markdown> prompt
// guidance instructs the agent to emit it between documents and to NOT include
// it inside a document (a document containing the marker line would split
// wrongly — the documented constraint, same spirit as a CSV delimiter).
//
// This module stays dependency-free (see the header note) so the codec can be
// re-exported from the barrel without re-creating the init cycle.
// -----------------------------------------------------------------------------

export const MARKDOWN_DOC_BOUNDARY = '<!-- @@aw-doc-boundary@@ -->'

/** Strip leading/trailing blank lines from one document body. */
function trimDocEdges(body: string): string {
  return body.replace(/^\n+/, '').replace(/\n+$/, '')
}

/**
 * Split inline `list<markdown>` wire content into per-document bodies, in order.
 * Boundary lines (a line whose trim equals MARKDOWN_DOC_BOUNDARY) delimit docs;
 * each doc's outer blank lines are trimmed; empty docs are dropped. Empty input
 * → []. Inverse of {@link joinMarkdownDocs} for any bodies that don't themselves
 * contain a boundary line.
 */
export function splitMarkdownDocs(rawContent: string): string[] {
  if (rawContent.trim().length === 0) return []
  const docs: string[] = []
  let cur: string[] = []
  for (const line of rawContent.split('\n')) {
    if (line.trim() === MARKDOWN_DOC_BOUNDARY) {
      docs.push(cur.join('\n'))
      cur = []
    } else {
      cur.push(line)
    }
  }
  docs.push(cur.join('\n'))
  return docs.map(trimDocEdges).filter((d) => d.trim().length > 0)
}

/** Join per-document markdown bodies into inline `list<markdown>` wire content. */
export function joinMarkdownDocs(bodies: readonly string[]): string {
  return bodies.map(trimDocEdges).join(`\n${MARKDOWN_DOC_BOUNDARY}\n`)
}
