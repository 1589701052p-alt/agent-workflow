// RFC-085 T2 — lightweight cross-file resolution support (PURE).
//
//  - `scanClassDecls`     : a SHALLOW class-name→file index (regex over decl
//    lines, NOT a full parse) so a type name can be located to its file lazily.
//  - `inferLocalTypes`    : best-effort `varName → TypeName` from a method's
//    params + its class's fields + local `Type v` / `v = new Type()` decls.
//
// Both are heuristic (the RFC's accepted "尽力而为"): statically-typed languages
// resolve well; dynamic ones (no type text) mostly yield nothing → unresolved.

/** class/interface/struct/enum/trait/object declaration name → file path(s). */
export function scanClassDecls(file: string, source: string): string[] {
  const out = new Set<string>()
  const re = /\b(?:class|interface|struct|enum|trait|object)\s+([A-Za-z_]\w*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    if (m[1] !== undefined) out.add(m[1])
  }
  void file
  return [...out]
}

/** Merge per-file class names into a name → files index. */
export function buildClassIndex(
  perFile: Array<{ file: string; names: string[] }>,
): Map<string, string[]> {
  const idx = new Map<string, string[]>()
  for (const { file, names } of perFile) {
    for (const n of names) {
      const arr = idx.get(n) ?? []
      if (!arr.includes(file)) arr.push(file)
      idx.set(n, arr)
    }
  }
  return idx
}

/** Best-effort `varName → TypeName` (leaf) from the given declaration texts. Scans
 *  three shapes, language-agnostic-ish:
 *   - `Type name`            (Java/Go/Rust/C++ params, fields, locals)
 *   - `name: Type`           (TS/Scala/Python annotations)
 *   - `name = new Type(`     (constructions)
 *  Only Capitalised type names are taken (class convention) to limit noise. */
export function inferLocalTypes(...texts: Array<string | undefined>): Map<string, string> {
  const out = new Map<string, string>()
  const text = texts.filter((t): t is string => t !== undefined).join('\n')
  const put = (name: string | undefined, type: string | undefined): void => {
    if (name === undefined || type === undefined) return
    if (!/^[A-Z]/.test(type)) return
    if (!out.has(name)) out.set(name, type.replace(/<.*$/, '')) // drop generics
  }
  // name = new Type(
  for (const m of text.matchAll(/\b(\w+)\s*[:=]\s*new\s+([A-Za-z_][\w.]*)/g))
    put(m[1], leafType(m[2]))
  // name: Type   (annotation; not `::` scope, not `=`)
  for (const m of text.matchAll(/\b(\w+)\s*:\s*([A-Z][\w.]*)/g)) put(m[1], leafType(m[2]))
  // Type name   (type-first; Type is Capitalised, name lower-ish)
  for (const m of text.matchAll(/\b([A-Z][\w.]*(?:<[^>]*>)?)\s+([a-z_]\w*)\b/g))
    put(m[2], leafType(m[1]))
  return out
}

function leafType(t: string | undefined): string | undefined {
  if (t === undefined) return undefined
  const base = t.replace(/<.*$/, '')
  const parts = base.split(/[.:]+/).filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? base
}
