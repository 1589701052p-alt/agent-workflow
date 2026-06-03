// Regression: opening an agent's edit page must preserve outputKinds.
// Bug: agentToDraft in routes/agents.detail.tsx omitted outputKinds, so every
// reopen reset port kinds to default 'string' — the user's saved markdown /
// markdown_file selection was lost on next page load. Locks the per-port kind
// round-trip on the detail page.

import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { agentToDraft } from '../src/routes/agents.detail'

describe('agentToDraft', () => {
  test('preserves outputKinds so reopening the edit page keeps saved kinds', () => {
    const agent: Agent = {
      id: 'a1',
      name: 'demo',
      description: 'd',
      outputs: ['report', 'note'],
      outputKinds: { report: 'markdown_file', note: 'markdown' },
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    }

    const draft = agentToDraft(agent)

    expect(draft.outputKinds).toEqual({ report: 'markdown_file', note: 'markdown' })
  })

  // RFC-080 PR-C: the parametric kinds now selectable via KindSelect must
  // survive the detail→edit→save round-trip exactly like the legacy kinds.
  // This is the persistence round-trip lock (the KindSelect write path is
  // covered by OutputsEditor.test.tsx; the kind grammar by kind-select.test.tsx).
  test('preserves parametric kinds (path<json> / list<path<md>> / signal)', () => {
    const agent: Agent = {
      id: 'a2',
      name: 'splitter',
      description: 'd',
      outputs: ['data', 'docs', 'done'],
      outputKinds: { data: 'path<json>', docs: 'list<path<md>>', done: 'signal' },
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    }

    expect(agentToDraft(agent).outputKinds).toEqual({
      data: 'path<json>',
      docs: 'list<path<md>>',
      done: 'signal',
    })
  })
})
