// RFC-W002 - locks the pure `buildInteractionFeed` aggregation contract: the
// four interaction-type mappings, the (ts, sortId) chronological ordering, and
// every boundary called out in plan.md T1 / design.md §8. If a future refactor
// changes which events surface or how they sort, this file must go red so the
// break is caught before the timeline UI drifts.

import { describe, expect, test } from 'bun:test'

import {
  buildInteractionFeed,
  INTERACTION_FEED_MAX_ITEMS,
  type BuildInteractionFeedArgs,
} from '../src/index'

// --- helpers -----------------------------------------------------------------

function snapshot(nodes: Array<{ id: string; title?: string; agentName?: string }>): string {
  return JSON.stringify({
    $schema_version: 3,
    inputs: [],
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: 'agent-single',
      position: { x: 0, y: 0 },
      title: n.title,
      agentName: n.agentName,
    })),
    edges: [],
  })
}

const baseArgs: BuildInteractionFeedArgs = {
  task: { id: 'task1', startedAt: 1000, inputsJson: JSON.stringify({ requirement: 'build it' }) },
  nodeRuns: [],
  outputs: [],
  clarifyRounds: [],
  docVersions: [],
  reviewComments: [],
  workflowSnapshot: snapshot([
    { id: 'A', title: 'Designer', agentName: 'agentA' },
    { id: 'B', agentName: 'agentB' },
  ]),
}

// --- human_input -------------------------------------------------------------

describe('buildInteractionFeed - human_input', () => {
  test('emits one human_input item from tasks.inputs, ts=startedAt', () => {
    const r = buildInteractionFeed(baseArgs)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({
      kind: 'human_input',
      ts: 1000,
      sortId: 'task1',
      inputs: { requirement: 'build it' },
    })
    expect(r.items[0].id).toBe('input:task1')
  })

  test('null inputsJson -> no human_input item', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      task: { id: 'task1', startedAt: 1000, inputsJson: null },
    })
    expect(r.items).toHaveLength(0)
  })

  test('non-string input values are stringified, not dropped', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      task: { id: 'task1', startedAt: 5, inputsJson: JSON.stringify({ count: 3, flag: true }) },
    })
    expect(r.items[0].inputs).toEqual({ count: '3', flag: 'true' })
  })
})

// --- node_output -------------------------------------------------------------

describe('buildInteractionFeed - node_output', () => {
  test('done run with one port -> one item, jumpTarget session', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      nodeRuns: [{ id: 'runA', nodeId: 'A', status: 'done', finishedAt: 2000 }],
      outputs: [{ nodeRunId: 'runA', portName: 'design', content: '# plan', kind: 'markdown' }],
    })
    const out = r.items.find((i) => i.kind === 'node_output')!
    expect(out).toBeDefined()
    expect(out.nodeRunId).toBe('runA')
    expect(out.nodeName).toBe('Designer') // title wins over agentName
    expect(out.outputs).toEqual([{ portName: 'design', content: '# plan', kind: 'markdown' }])
    expect(out.jumpTarget).toEqual({ kind: 'session', nodeRunId: 'runA' })
  })

  test('multi-port run -> ONE item with all ports', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      nodeRuns: [{ id: 'runA', nodeId: 'A', status: 'done', finishedAt: 2000 }],
      outputs: [
        { nodeRunId: 'runA', portName: 'design', content: 'p1', kind: 'markdown' },
        { nodeRunId: 'runA', portName: 'notes', content: 'p2', kind: 'string' },
      ],
    })
    const outs = r.items.filter((i) => i.kind === 'node_output')
    expect(outs).toHaveLength(1)
    expect(outs[0].outputs).toHaveLength(2)
  })

  test('done run with no outputs -> skipped (no empty card)', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      nodeRuns: [{ id: 'runA', nodeId: 'A', status: 'done', finishedAt: 2000 }],
      outputs: [],
    })
    expect(r.items.filter((i) => i.kind === 'node_output')).toHaveLength(0)
  })

  test('non-done run -> skipped', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      nodeRuns: [{ id: 'runA', nodeId: 'A', status: 'running', finishedAt: null }],
      outputs: [{ nodeRunId: 'runA', portName: 'design', content: 'x', kind: 'markdown' }],
    })
    expect(r.items.filter((i) => i.kind === 'node_output')).toHaveLength(0)
  })

  test('agentName used when no title; nodeId when neither', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      workflowSnapshot: snapshot([{ id: 'B', agentName: 'agentB' }]),
      nodeRuns: [{ id: 'runB', nodeId: 'B', status: 'done', finishedAt: 2000 }],
      outputs: [{ nodeRunId: 'runB', portName: 'out', content: 'x', kind: 'string' }],
    })
    const out = r.items.find((i) => i.kind === 'node_output')!
    expect(out.nodeName).toBe('agentB')
    expect(out.agentName).toBe('agentB')
  })
})

// --- clarify_question / clarify_answer --------------------------------------

describe('buildInteractionFeed - clarify Q&A', () => {
  const questionsJson = JSON.stringify([
    { id: 'q1', title: 'Which DB?', kind: 'single', options: ['Postgres', 'MySQL'] },
  ])
  const answersJson = JSON.stringify([
    {
      questionId: 'q1',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['Postgres'],
      customText: '',
    },
  ])

  test('answered round -> question + answer items; answer ts=answeredAt', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      clarifyRounds: [
        {
          id: 'round1',
          kind: 'self',
          askingNodeId: 'B',
          intermediaryNodeRunId: 'clarifyRun1',
          status: 'answered',
          questionsJson,
          answersJson,
          createdAt: 3000,
          answeredAt: 4000,
        },
      ],
    })
    const q = r.items.find((i) => i.kind === 'clarify_question')!
    const a = r.items.find((i) => i.kind === 'clarify_answer')!
    expect(q.ts).toBe(3000)
    expect(q.nodeName).toBe('agentB')
    expect(q.questions).toHaveLength(1)
    expect(q.jumpTarget).toEqual({ kind: 'clarify', roundId: 'round1', nodeRunId: 'clarifyRun1' })
    expect(a.ts).toBe(4000)
    expect(a.answers).toHaveLength(1)
    expect(a.questions).toHaveLength(1) // carried for "Q -> A" context
  })

  test('unanswered round -> only question item', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      clarifyRounds: [
        {
          id: 'round1',
          kind: 'self',
          askingNodeId: 'B',
          intermediaryNodeRunId: 'clarifyRun1',
          status: 'awaiting_human',
          questionsJson,
          answersJson: null,
          createdAt: 3000,
          answeredAt: null,
        },
      ],
    })
    expect(r.items.filter((i) => i.kind === 'clarify_question')).toHaveLength(1)
    expect(r.items.filter((i) => i.kind === 'clarify_answer')).toHaveLength(0)
  })

  test('corrupt questionsJson -> round skipped (feed never throws)', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      clarifyRounds: [
        {
          id: 'round1',
          kind: 'self',
          askingNodeId: 'B',
          intermediaryNodeRunId: 'clarifyRun1',
          status: 'awaiting_human',
          questionsJson: '{not json',
          answersJson: null,
          createdAt: 3000,
          answeredAt: null,
        },
      ],
    })
    expect(r.items.filter((i) => i.kind === 'clarify_question')).toHaveLength(0)
  })
})

// --- review_decision ---------------------------------------------------------

describe('buildInteractionFeed - review_decision', () => {
  test('rejected version -> item with reason + comments from review_comments', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      docVersions: [
        {
          id: 'dv1',
          reviewNodeRunId: 'reviewRun1',
          sourceNodeId: 'A',
          decision: 'rejected',
          decisionReason: 'missing tests',
          commentsJson: '[]',
          decidedAt: 5000,
        },
      ],
      reviewComments: [
        { docVersionId: 'dv1', selectedText: 'foo', commentText: 'fix this', author: 'alice' },
      ],
    })
    const rv = r.items.find((i) => i.kind === 'review_decision')!
    expect(rv.ts).toBe(5000)
    expect(rv.nodeName).toBe('Designer')
    expect(rv.review).toEqual({
      decision: 'rejected',
      reason: 'missing tests',
      comments: [{ selectedText: 'foo', commentText: 'fix this', author: 'alice' }],
    })
    expect(rv.jumpTarget).toEqual({ kind: 'review', nodeRunId: 'reviewRun1', docVersionId: 'dv1' })
  })

  test('pending + superseded versions skipped; decided with null decidedAt skipped', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      docVersions: [
        {
          id: 'dv1',
          reviewNodeRunId: 'r1',
          sourceNodeId: 'A',
          decision: 'pending',
          decisionReason: null,
          commentsJson: '[]',
          decidedAt: null,
        },
        {
          id: 'dv2',
          reviewNodeRunId: 'r1',
          sourceNodeId: 'A',
          decision: 'superseded',
          decisionReason: null,
          commentsJson: '[]',
          decidedAt: 5000,
        },
        {
          id: 'dv3',
          reviewNodeRunId: 'r1',
          sourceNodeId: 'A',
          decision: 'approved',
          decisionReason: null,
          commentsJson: '[]',
          decidedAt: null,
        },
      ],
    })
    expect(r.items.filter((i) => i.kind === 'review_decision')).toHaveLength(0)
  })
})

// --- ordering + truncation ---------------------------------------------------

describe('buildInteractionFeed - ordering', () => {
  test('mixed kinds sorted by ts asc', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      task: { id: 'task1', startedAt: 1000, inputsJson: JSON.stringify({ r: 'x' }) },
      nodeRuns: [{ id: 'runA', nodeId: 'A', status: 'done', finishedAt: 2000 }],
      outputs: [{ nodeRunId: 'runA', portName: 'out', content: 'y', kind: 'string' }],
      docVersions: [
        {
          id: 'dv1',
          reviewNodeRunId: 'rr',
          sourceNodeId: 'A',
          decision: 'approved',
          decisionReason: null,
          commentsJson: '[]',
          decidedAt: 9000,
        },
      ],
    })
    expect(r.items.map((i) => i.kind)).toEqual(['human_input', 'node_output', 'review_decision'])
  })

  test('equal ts -> sortId tiebreaker (localeCompare)', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      task: { id: 'task1', startedAt: 5000, inputsJson: JSON.stringify({ r: 'x' }) },
      docVersions: [
        {
          id: 'dvZ',
          reviewNodeRunId: 'r',
          sourceNodeId: 'A',
          decision: 'approved',
          decisionReason: null,
          commentsJson: '[]',
          decidedAt: 5000,
        },
        {
          id: 'dvA',
          reviewNodeRunId: 'r',
          sourceNodeId: 'A',
          decision: 'approved',
          decisionReason: null,
          commentsJson: '[]',
          decidedAt: 5000,
        },
      ],
    })
    // ts ties at 5000; sortId breaks the tie lexicographically: 'dvA' < 'dvZ' < 'task1'
    expect(r.items.map((i) => i.id)).toEqual(['review:dvA', 'review:dvZ', 'input:task1'])
  })
})

describe('buildInteractionFeed - truncation', () => {
  test('over cap -> truncated=true, keeps most recent MAX, total=original', () => {
    const docs = Array.from({ length: INTERACTION_FEED_MAX_ITEMS + 5 }, (_, i) => ({
      id: `dv${String(i).padStart(5, '0')}`,
      reviewNodeRunId: 'r',
      sourceNodeId: 'A',
      decision: 'approved',
      decisionReason: null,
      commentsJson: '[]',
      decidedAt: 1000 + i, // ascending ts
    }))
    // isolate to doc versions only (null inputsJson -> no human_input item),
    // so total is exactly the doc-version count and the cap math is unambiguous.
    const r = buildInteractionFeed({
      ...baseArgs,
      task: { id: 'task1', startedAt: 1000, inputsJson: null },
      docVersions: docs,
    })
    expect(r.truncated).toBe(true)
    expect(r.total).toBe(INTERACTION_FEED_MAX_ITEMS + 5)
    expect(r.items).toHaveLength(INTERACTION_FEED_MAX_ITEMS)
    // the oldest 5 (dv00000..dv00004) dropped; most recent kept
    expect(r.items[0].id).toBe('review:dv00005')
    expect(r.items[r.items.length - 1].id).toBe(
      `review:dv${String(INTERACTION_FEED_MAX_ITEMS + 4).padStart(5, '0')}`,
    )
  })

  test('under cap -> truncated=false', () => {
    const r = buildInteractionFeed(baseArgs)
    expect(r.truncated).toBe(false)
    expect(r.total).toBe(r.items.length)
  })
})

// --- snapshot robustness -----------------------------------------------------

describe('buildInteractionFeed - snapshot robustness', () => {
  test('corrupt workflowSnapshot -> nodeId fallback, no throw', () => {
    const r = buildInteractionFeed({
      ...baseArgs,
      workflowSnapshot: '{not json',
      nodeRuns: [{ id: 'runA', nodeId: 'A', status: 'done', finishedAt: 2000 }],
      outputs: [{ nodeRunId: 'runA', portName: 'out', content: 'x', kind: 'string' }],
    })
    expect(r.items.find((i) => i.kind === 'node_output')!.nodeName).toBe('A')
  })
})
