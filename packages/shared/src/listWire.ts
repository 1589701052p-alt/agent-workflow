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
