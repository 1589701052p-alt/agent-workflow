// RFC-083 PR-A — extract a symbol-node set from one source file.
//
// Pipeline: parse → run the language's extraction query → for each match derive
// (kind, name, qualifiedName, parentId, signature, bodyHash, range). Nesting is
// taken from the syntax tree (a function inside a class body → method, qualified
// `Class.method`), NOT from the flat query, so qualified names are accurate.
//
// bodyHash semantics drive graphDiff:
//   - container (class/interface/struct/enum/trait/object): signature is omitted
//     so identity = kind+qualifiedName stays STABLE across member edits (adding a
//     method must not read as delete+recreate of the class). bodyHash = the
//     declaration header (name + heritage) so a container shows "modified" only
//     when its own declaration changes.
//   - leaf (function/method/field/import): signature = the declaration header
//     (params/return) for overload identity; bodyHash = the full node text so a
//     body-only edit reads as "modified".

import { createHash } from 'node:crypto'
import type Parser from 'web-tree-sitter'
import type { LangId, SymbolKind, SymbolNode } from '@agent-workflow/shared'
import { parseSource } from './parser'
import { getLangExtraction, DEGRADED_LANGS, type ExtractionConfig } from './queries'

type TsNode = Parser.SyntaxNode

const CLASS_LIKE: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
  'namespace',
  'module',
])

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '').trim()
}

interface RawDef {
  node: TsNode
  nameNode: TsNode | null
  rawKind: SymbolKind
}

/**
 * Extract symbol nodes from `source` for `lang`. Returns [] when the language
 * has no extraction config. Throws on a fatal parse failure (caller maps to
 * `parse-error`).
 */
export async function extractSymbols(opts: {
  lang: LangId
  grammarFile: string
  filePath: string
  source: string
}): Promise<{ symbols: SymbolNode[]; hadError: boolean }> {
  const cfg = getLangExtraction(opts.lang)
  if (cfg === undefined) return { symbols: [], hadError: false }
  const { tree, language } = await parseSource(opts.grammarFile, opts.source)
  const query = language.query(cfg.query)
  try {
    // tree-sitter recovers from syntax errors instead of throwing, so a grammar
    // that can't parse a construct (e.g. a newer syntax the pinned grammar
    // predates) silently yields a partial tree. Surface that as `hadError` so
    // the file is marked degraded rather than a misleading "ok".
    const hadError = tree.rootNode.hasError
    return { symbols: buildSymbols(query.matches(tree.rootNode), opts, cfg), hadError }
  } finally {
    query.delete()
    tree.delete()
  }
}

function buildSymbols(
  matches: Parser.QueryMatch[],
  opts: { lang: LangId; filePath: string; source: string },
  cfg: ExtractionConfig,
): SymbolNode[] {
  // ---- Pass 1: collect raw defs, indexed by tree-node id for nesting lookup.
  const raws: RawDef[] = []
  const byNodeId = new Map<number, RawDef>()
  for (const m of matches) {
    let defCap: Parser.QueryCapture | undefined
    let nameCap: Parser.QueryCapture | undefined
    for (const c of m.captures) {
      if (c.name === 'name') nameCap = c
      else if (c.name.startsWith('def.')) defCap = c
    }
    if (defCap === undefined) continue
    const rawKind = defCap.name.slice('def.'.length) as SymbolKind
    const raw: RawDef = { node: defCap.node, nameNode: nameCap?.node ?? null, rawKind }
    // A single tree node can be captured once per def pattern; first wins.
    if (byNodeId.has(defCap.node.id)) continue
    byNodeId.set(defCap.node.id, raw)
    raws.push(raw)
  }

  const nearestDefAncestor = (n: TsNode): RawDef | null => {
    let p = n.parent
    while (p !== null) {
      const r = byNodeId.get(p.id)
      if (r !== undefined) return r
      p = p.parent
    }
    return null
  }

  const leafName = (r: RawDef): string => {
    if (r.rawKind === 'import') {
      const raw = r.nameNode !== null ? r.nameNode.text : r.node.text
      const cleaned = stripQuotes(norm(raw))
      return cleaned !== '' ? cleaned : norm(r.node.text)
    }
    return r.nameNode !== null ? r.nameNode.text : ''
  }

  // ---- Pass 2: qualifiedName + final kind (memoized over the parent chain).
  const qnameCache = new Map<RawDef, string>()
  const qualifiedName = (r: RawDef): string => {
    const cached = qnameCache.get(r)
    if (cached !== undefined) return cached
    const parent = nearestDefAncestor(r.node)
    let prefix = ''
    if (parent !== null && parent.rawKind !== 'import') {
      prefix = `${qualifiedName(parent)}.`
    } else if (cfg.receiverPrefix !== undefined) {
      const recv = cfg.receiverPrefix(r.node)
      if (recv !== null && recv !== '') prefix = `${recv}.`
    }
    const qn = prefix + leafName(r)
    qnameCache.set(r, qn)
    return qn
  }

  const finalKind = (r: RawDef): SymbolKind => {
    if (r.rawKind === 'function') {
      const parent = nearestDefAncestor(r.node)
      if (parent !== null && CLASS_LIKE.has(parent.rawKind)) return 'method'
      // Rust impl methods: captured as functions, qualified by a receiver type.
      if (cfg.receiverPrefix !== undefined) {
        const recv = cfg.receiverPrefix(r.node)
        if (recv !== null && recv !== '') return 'method'
      }
    }
    return r.rawKind
  }

  // ---- Pass 3: ids first (parentId needs sibling ids), then nodes.
  interface Built {
    raw: RawDef
    kind: SymbolKind
    name: string
    qn: string
    id: string
  }
  const built: Built[] = []
  const idByRaw = new Map<RawDef, string>()
  // class-like name → id, for receiver-based parent linking (Go methods).
  const classLikeIdByName = new Map<string, string>()
  for (const r of raws) {
    const name = leafName(r)
    if (name === '') continue
    const kind = finalKind(r)
    const qn = qualifiedName(r)
    const id = `${opts.filePath}#${qn}:${kind}:${r.node.startPosition.row + 1}`
    idByRaw.set(r, id)
    if (CLASS_LIKE.has(kind)) classLikeIdByName.set(qn, id)
    built.push({ raw: r, kind, name, qn, id })
  }

  const degraded = DEGRADED_LANGS.has(opts.lang)
  const out: SymbolNode[] = []
  for (const b of built) {
    const node = b.raw.node
    const bodyChild = node.childForFieldName('body')
    const isContainer = CLASS_LIKE.has(b.kind)
    let signature: string | undefined
    let bodyHashInput: string
    if (isContainer) {
      // identity stable across member edits (signature omitted)
      const header =
        bodyChild !== null
          ? opts.source.slice(node.startIndex, bodyChild.startIndex)
          : `${b.kind} ${b.qn}`
      bodyHashInput = norm(header)
    } else if (bodyChild !== null) {
      signature = norm(opts.source.slice(node.startIndex, bodyChild.startIndex))
      bodyHashInput = norm(node.text)
    } else {
      signature = norm(node.text)
      bodyHashInput = norm(node.text)
    }

    const structuralParent = nearestDefAncestor(node)
    let parentId = structuralParent !== null ? idByRaw.get(structuralParent) : undefined
    if (parentId === undefined && cfg.receiverPrefix !== undefined) {
      const recv = cfg.receiverPrefix(node)
      if (recv !== null && recv !== '') parentId = classLikeIdByName.get(recv)
    }

    out.push({
      id: b.id,
      kind: b.kind,
      name: b.name,
      qualifiedName: b.qn,
      signature,
      bodyHash: hash(bodyHashInput),
      lang: opts.lang,
      filePath: opts.filePath,
      range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
      parentId,
      confidence: degraded ? 'inferred' : 'extracted',
      degraded: degraded ? true : undefined,
    })
  }
  return out
}
