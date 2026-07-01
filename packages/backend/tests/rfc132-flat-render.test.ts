// RFC-132 PR-1 / T1 — renderFlatClarifyQueue: the single FLAT `## Clarify Q&A` block.
//
// Locks the INTENTIONAL behavior change (proposal 验收 #7①): the round-grouped
// buildClarifyPromptBlock loop (self / questioner) + the designer-only buildExternalFeedbackBlock
// collapse into ONE flat, peer list. Regression guards this file pins:
//   - NO `### Round N`, NO history-vs-current split, NO sibling scope, NO per-question directive
//     trailer, ZERO attribution (RFC-099 — no who-asked / who-answered / owner / user id).
//   - self / questioner / designer entries render IDENTICALLY (the flat model has no role grouping;
//     T1's input type carries no role field at all).
//   - manual (§15) renders its body as an equal peer bullet.
//   - empty / all-empty input → undefined; order is stable (input order preserved).
//
// PR-1 lands renderFlatClarifyQueue UNWIRED; PR-2 / PR-4 route the injectors through it. If this
// golden turns red under a later refactor, the flat contract changed — re-confirm it is intended.

import { describe, expect, test } from 'bun:test'

import {
  FLAT_CLARIFY_QUEUE_BLOCK_TITLE,
  renderFlatClarifyQueue,
  type ClarifyAnswer,
  type ClarifyOption,
  type ClarifyQuestion,
  type FlatClarifyEntry,
} from '@agent-workflow/shared'

function opt(label: string, recommended = false): ClarifyOption {
  return { label, description: '', recommended, recommendationReason: '' }
}

function question(
  id: string,
  title: string,
  kind: 'single' | 'multi',
  options: ClarifyOption[],
): ClarifyQuestion {
  return { id, title, kind, recommended: false, options }
}

function singleAns(qid: string, label: string): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: [label],
    customText: '',
  }
}
function multiAns(qid: string, labels: string[]): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: labels.map((_, i) => i),
    selectedOptionLabels: labels,
    customText: '',
  }
}
function customAns(qid: string, text: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [], selectedOptionLabels: [], customText: text }
}

describe('RFC-132 T1 — renderFlatClarifyQueue', () => {
  test('empty queue → undefined', () => {
    expect(renderFlatClarifyQueue([])).toBeUndefined()
  })

  test('all-empty manual entries → undefined (nothing renderable)', () => {
    expect(
      renderFlatClarifyQueue([
        { manualTitle: '', manualBody: '' },
        { manualTitle: null, manualBody: null },
        { manualTitle: '   ', manualBody: '\n  ' },
      ]),
    ).toBeUndefined()
  })

  test('single Q&A → block with one flat bullet', () => {
    const q = question('q1', 'Which database?', 'single', [opt('Postgres', true), opt('MySQL')])
    const block = renderFlatClarifyQueue([{ question: q, answer: singleAns('q1', 'Postgres') }])
    expect(block).toBe(
      [
        '## Clarify Q&A',
        '',
        '- Q: Which database?',
        '  Type: single-choice / Options: Postgres [recommended], MySQL',
        '  Answer: User chose: "Postgres"',
      ].join('\n'),
    )
  })

  test('MIXED self/questioner/designer/manual → golden flat string (all Q&A peers, manual as body)', () => {
    // Entries 1/2/3 originate from self / questioner / designer respectively — the flat model renders
    // them IDENTICALLY (no role marker, no round header). Entry 4 is a manual (§15) instruction.
    const selfQ = question('q1', 'DB choice', 'single', [opt('Postgres', true), opt('MySQL')])
    const questionerQ = question('q2', 'Features', 'multi', [opt('A'), opt('B'), opt('C')])
    const designerQ = question('q3', 'Style', 'single', [opt('X'), opt('Y')])
    const entries: FlatClarifyEntry[] = [
      { question: selfQ, answer: singleAns('q1', 'Postgres') },
      { question: questionerQ, answer: multiAns('q2', ['A', 'B']) },
      { question: designerQ, answer: customAns('q3', 'Z') },
      { manualTitle: 'Deadline', manualBody: 'Ship by Friday.' },
    ]
    const block = renderFlatClarifyQueue(entries)
    expect(block).toBe(
      [
        '## Clarify Q&A',
        '',
        '- Q: DB choice',
        '  Type: single-choice / Options: Postgres [recommended], MySQL',
        '  Answer: User chose: "Postgres"',
        '- Q: Features',
        '  Type: multi-choice / Options: A, B, C',
        '  Answer: User selected: "A", "B"',
        '- Q: Style',
        '  Type: single-choice / Options: X, Y',
        '  Answer: User chose custom answer: "Z"',
        '- Deadline',
        '  Ship by Friday.',
      ].join('\n'),
    )
  })

  test('NO round / scope / directive / attribution markers in the rendered block', () => {
    const selfQ = question('q1', 'DB choice', 'single', [opt('Postgres', true), opt('MySQL')])
    const designerQ = question('q2', 'Style', 'single', [opt('X'), opt('Y')])
    const block =
      renderFlatClarifyQueue([
        { question: selfQ, answer: singleAns('q1', 'Postgres') },
        { question: designerQ, answer: singleAns('q2', 'X') },
        { manualTitle: 'Note', manualBody: 'Do the thing.' },
      ]) ?? ''
    // No round grouping (buildClarifyPromptBlock) / no history-vs-current.
    expect(block).not.toContain('### Round')
    expect(block).not.toContain('Round ')
    // No sibling scope block (RFC-128 renderSiblingScopeBlock).
    expect(block).not.toContain('Scope of this run')
    // No designer External-Feedback source header (buildExternalFeedbackBlock).
    expect(block).not.toContain('## External Feedback')
    expect(block).not.toContain("### From '")
    // No per-question directive trailer (renderClarifyDirectiveTrailer).
    expect(block).not.toContain('KEEP CLARIFYING')
    expect(block).not.toContain('STOP CLARIFYING')
    expect(block).not.toContain('User directive')
    // RFC-099 zero-attribution: no owner / user id / role snapshot leaks.
    expect(block).not.toContain('owner')
    expect(block).not.toContain('user')
    expect(block.toLowerCase()).not.toContain('answered by')
    // The ONLY heading is the single flat block title (`##`), never a per-entry `###`.
    expect(block).toContain(FLAT_CLARIFY_QUEUE_BLOCK_TITLE)
    expect(block).not.toContain('###')
  })

  test('order is stable — entries render in input order (caller pre-sorts by dispatched_at/id)', () => {
    const qa = question('a', 'Alpha', 'single', [opt('1'), opt('2')])
    const qb = question('b', 'Bravo', 'single', [opt('1'), opt('2')])
    const forward = renderFlatClarifyQueue([
      { question: qa, answer: singleAns('a', '1') },
      { question: qb, answer: singleAns('b', '2') },
    ])
    const reversed = renderFlatClarifyQueue([
      { question: qb, answer: singleAns('b', '2') },
      { question: qa, answer: singleAns('a', '1') },
    ])
    expect(forward).not.toBe(reversed)
    expect((forward ?? '').indexOf('Alpha')).toBeLessThan((forward ?? '').indexOf('Bravo'))
    expect((reversed ?? '').indexOf('Bravo')).toBeLessThan((reversed ?? '').indexOf('Alpha'))
  })

  test('unanswered question (answer undefined) → renders the "did not answer" synthesis', () => {
    const q = question('q1', 'Skipped?', 'single', [opt('Yes'), opt('No')])
    const block = renderFlatClarifyQueue([{ question: q, answer: undefined }]) ?? ''
    expect(block).toContain('  Answer: User did not answer this question.')
  })

  test('manual body-only (no title) → plain bullet; multi-line body indents under the bullet', () => {
    const block = renderFlatClarifyQueue([{ manualTitle: null, manualBody: 'line one\nline two' }])
    expect(block).toBe(['## Clarify Q&A', '', '- line one', '  line two'].join('\n'))
  })

  test('manual title-only (empty body) → single title bullet', () => {
    const block = renderFlatClarifyQueue([{ manualTitle: 'Just a heading', manualBody: '' }])
    expect(block).toBe(['## Clarify Q&A', '', '- Just a heading'].join('\n'))
  })

  test('empty manual entries are skipped but do not suppress renderable peers', () => {
    const q = question('q1', 'Kept?', 'single', [opt('Yes'), opt('No')])
    const block = renderFlatClarifyQueue([
      { manualTitle: '', manualBody: '' },
      { question: q, answer: singleAns('q1', 'Yes') },
      { manualTitle: null, manualBody: null },
    ])
    expect(block).toBe(
      [
        '## Clarify Q&A',
        '',
        '- Q: Kept?',
        '  Type: single-choice / Options: Yes, No',
        '  Answer: User chose: "Yes"',
      ].join('\n'),
    )
  })
})
