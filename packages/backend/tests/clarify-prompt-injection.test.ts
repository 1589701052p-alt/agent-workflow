// RFC-023 — prompt-token injection contract for clarify.
//
// Locks the four builtin token names + auto-append section behaviour from
// design.md §4.3 + plan.md T3 §C2. The grep-style source-code guards prove
// the token strings still appear in shared/src/prompt.ts: if a refactor
// renames any of them, this test breaks loudly rather than silently
// dropping the substitution.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildClarifyProtocolBlock, renderUserPrompt } from '@agent-workflow/shared'

const PROMPT_TS_PATH = resolve(__dirname, '../../shared/src/prompt.ts')

describe('RFC-023 prompt token substitution', () => {
  test('replaces all four __clarify_*__ tokens when context is set', () => {
    const out = renderUserPrompt({
      promptTemplate:
        'iter={{__clarify_iteration__}} remaining={{__clarify_remaining__}}\nQ:\n{{__clarify_questions__}}\nA:\n{{__clarify_answers__}}',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: {
        questionsBlock: '### Q1: which db?',
        answersBlock: '### Q1\nSelected: "Postgres"',
        iteration: '1',
        remaining: '4',
      },
    })
    expect(out).toContain('iter=1 remaining=4')
    expect(out).toContain('### Q1: which db?')
    expect(out).toContain('Selected: "Postgres"')
  })

  test('auto-appends `## Clarify Q&A` sections when tokens are not referenced in the template', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Please continue based on prior clarifications.',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: {
        questionsBlock: '### Q1: which db?',
        answersBlock: '### Q1\nSynthesis: User chose: "Postgres"',
        iteration: '1',
        remaining: '',
      },
    })
    expect(out).toContain('## Clarify Q&A — Prior Rounds (Questions)')
    expect(out).toContain('## Clarify Q&A — Prior Rounds (Answers)')
  })

  test('omits auto-append sections when blocks are empty', () => {
    const out = renderUserPrompt({
      promptTemplate: 'plain run',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: { questionsBlock: '', answersBlock: '', iteration: '0', remaining: '' },
    })
    expect(out).not.toContain('## Clarify Q&A')
  })

  test('buildClarifyProtocolBlock contains the "EITHER ... OR ... NEVER both" rule', () => {
    const block = buildClarifyProtocolBlock()
    expect(block).toContain('<workflow-clarify>')
    expect(block).toContain('NEVER both')
    expect(block).toContain('Clarify mode is enabled for this node')
  })
})

describe('RFC-023 prompt.ts source-code-text grep guard', () => {
  // These are stable, externally visible token names per the RFC. Renaming any
  // of them silently is a contract break (frontend / backend / agent prompts
  // all reference the same strings). The guard makes any rename loud.
  const required = [
    '__clarify_questions__',
    '__clarify_answers__',
    '__clarify_iteration__',
    '__clarify_remaining__',
  ]
  const src = readFileSync(PROMPT_TS_PATH, 'utf8')

  for (const token of required) {
    test(`prompt.ts mentions ${token}`, () => {
      expect(src).toContain(token)
    })
  }
})
