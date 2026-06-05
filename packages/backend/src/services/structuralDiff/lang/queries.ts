// RFC-083 PR-A — per-language tree-sitter extraction queries + config.
//
// Each pattern captures the definition node as `@def.<kind>` and its name node
// as `@name`. `extract.ts` walks matches, derives qualifiedName/parentId from
// syntactic nesting, reclassifies functions→methods inside class-like scopes,
// and computes signature/bodyHash. Kinds here are the raw SymbolKind values;
// imports may have no `@name` (Python), handled by extract.ts.
//
// These queries were validated against the tree-sitter-wasms 0.20-era grammars
// (node-type names differ slightly from current docs). Java/Rust/C++/Scala
// extraction lands in PR-B.

import type Parser from 'web-tree-sitter'
import type { LangId } from '@agent-workflow/shared'

type TsNode = Parser.SyntaxNode

export interface ExtractionConfig {
  query: string
  /** Language-specific receiver prefix for a definition's qualifiedName
   *  (Go methods: `func (t T) Foo` → `T.Foo`). */
  receiverPrefix?: (node: TsNode) => string | null
}

const PYTHON = `
(class_definition name: (identifier) @name) @def.class
(function_definition name: (identifier) @name) @def.function
(import_statement) @def.import
(import_from_statement) @def.import
(class_definition
  body: (block (expression_statement (assignment left: (identifier) @name)) @def.field))
`

const GO = `
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @def.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @def.interface
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(field_declaration name: (field_identifier) @name) @def.field
(import_spec path: (interpreted_string_literal) @name) @def.import
`

const TYPESCRIPT = `
(class_declaration name: (_) @name) @def.class
(interface_declaration name: (_) @name) @def.interface
(enum_declaration name: (_) @name) @def.enum
(method_definition name: (property_identifier) @name) @def.method
(function_declaration name: (identifier) @name) @def.function
(public_field_definition name: (property_identifier) @name) @def.field
(variable_declarator name: (identifier) @name value: (arrow_function)) @def.function
(import_statement source: (string) @name) @def.import
`

const JAVASCRIPT = `
(class_declaration name: (identifier) @name) @def.class
(method_definition name: (property_identifier) @name) @def.method
(function_declaration name: (identifier) @name) @def.function
(field_definition property: (property_identifier) @name) @def.field
(variable_declarator name: (identifier) @name value: (arrow_function)) @def.function
(import_statement source: (string) @name) @def.import
`

function goReceiver(node: TsNode): string | null {
  const recv = node.childForFieldName('receiver')
  if (recv === null) return null
  const types = recv.descendantsOfType('type_identifier')
  const first = types[0]
  return first !== undefined ? first.text : null
}

const EXTRACTION: Partial<Record<LangId, ExtractionConfig>> = {
  python: { query: PYTHON },
  go: { query: GO, receiverPrefix: goReceiver },
  typescript: { query: TYPESCRIPT },
  javascript: { query: JAVASCRIPT },
}

export function getLangExtraction(lang: LangId): ExtractionConfig | undefined {
  return EXTRACTION[lang]
}

export function hasExtraction(lang: LangId): boolean {
  return EXTRACTION[lang] !== undefined
}

/** Languages whose baseline extraction is best-effort (UI marks "incomplete").
 *  Populated in PR-B (cpp, scala). Empty in PR-A. */
export const DEGRADED_LANGS: ReadonlySet<LangId> = new Set<LangId>([])
