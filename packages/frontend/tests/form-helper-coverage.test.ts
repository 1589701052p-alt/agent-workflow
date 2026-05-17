// RFC-035 PR2 — locks the Form helper migration invariant.
//
// The audit (design/ux-audit.md §2.4) listed seven routes that should
// migrate to the shared <Form.Field> / <TextInput> / <NumberInput> /
// <TextArea> / <Switch> primitives. At the time of RFC-035 each of those
// routes already delegates its form fragment to a per-domain component
// (AgentForm / McpFields / PluginFields / SkillFields) which uses the
// helpers internally — so the migration is effectively complete.
//
// This file locks the invariant: each route MUST keep delegating to a
// helper-using component instead of growing a fresh <input> / <textarea>
// directly. If a future regression adds a naked input back, this fires.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

const TARGET_ROUTES = [
  'routes/agents.new.tsx',
  'routes/agents.detail.tsx',
  'routes/plugins.new.tsx',
  'routes/plugins.detail.tsx',
  'routes/mcps.new.tsx',
  'routes/mcps.detail.tsx',
  'routes/clarify.detail.tsx',
] as const

describe('RFC-035 Form helper coverage', () => {
  for (const route of TARGET_ROUTES) {
    test(`${route} has no naked <input> or <textarea> JSX`, () => {
      const body = readFileSync(path.resolve(SRC, route), 'utf8')
      // Look for the literal opening JSX. We accept `<input` inside a
      // string literal or comment too, so be a bit forgiving — but the
      // real signal is a JSX-like form-control opener at the start of a
      // line or after whitespace/tag boundary.
      const naked = body.match(/[\s>]<(input|textarea)[\s/>]/g) ?? []
      expect(naked, `${route}: ${JSON.stringify(naked)}`).toEqual([])
    })
  }
})
