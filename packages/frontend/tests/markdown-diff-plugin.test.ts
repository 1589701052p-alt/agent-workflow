// RFC-010 — remarkDiffMarkers 单元测试。
// 锚定：splitMarkers 的字符状态机正确切分 PUA marker；插件递归 visit 把
// markdown text 节点替换成 (text | diffMark)[]；mdast→hast 阶段
// hName/hProperties 的形状不能变（一旦变会让 react-markdown 渲染丢 class）。

import { describe, expect, test } from 'vitest'
import { MARKERS } from '@/lib/review/markdownDiff'
import { remarkDiffMarkers, splitMarkers } from '@/lib/review/remarkDiffMarkers'

const { INS_OPEN, INS_CLOSE, DEL_OPEN, DEL_CLOSE } = MARKERS

describe('splitMarkers', () => {
  test('纯文本 → 单 text 节点', () => {
    const out = splitMarkers('hello world')
    expect(out).toEqual([{ type: 'text', value: 'hello world' }])
  })

  test('INS marker → diffMark + 正确 hName/hProperties', () => {
    const out = splitMarkers(`hello ${INS_OPEN}new${INS_CLOSE} world`)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ type: 'text', value: 'hello ' })
    expect(out[1]).toEqual({
      type: 'diffMark',
      data: {
        hName: 'span',
        hProperties: { className: ['diff-ins'] },
      },
      children: [{ type: 'text', value: 'new' }],
    })
    expect(out[2]).toEqual({ type: 'text', value: ' world' })
  })

  test('DEL marker → className=diff-del', () => {
    const out = splitMarkers(`${DEL_OPEN}old${DEL_CLOSE}`)
    expect(out).toHaveLength(1)
    const node = out[0] as { type: 'diffMark'; data: { hProperties: { className: string[] } } }
    expect(node.type).toBe('diffMark')
    expect(node.data.hProperties.className).toEqual(['diff-del'])
  })

  test('混合 ins+del 段', () => {
    const out = splitMarkers(`${DEL_OPEN}a${DEL_CLOSE} ${INS_OPEN}b${INS_CLOSE}`)
    const kinds = out.map((n) => {
      if (n.type === 'diffMark') return n.data.hProperties.className[0]
      return 'text'
    })
    expect(kinds).toEqual(['diff-del', 'text', 'diff-ins'])
  })

  test('未配对 open marker → 内容不丢，仅丢 marker 本身', () => {
    const out = splitMarkers(`hello ${INS_OPEN}world`)
    // 终止时 'world' 在 ins buf 内未闭合 → 当成 text flush
    const concat = out
      .map((n) => (n.type === 'text' ? n.value : (n.children[0]?.value ?? '')))
      .join('')
    expect(concat.includes('world')).toBe(true)
    expect(concat.includes(INS_OPEN)).toBe(false)
  })

  test('未配对 close marker → 当无效字符吞掉', () => {
    const out = splitMarkers(`hello${INS_CLOSE}world`)
    const concat = out.map((n) => (n.type === 'text' ? n.value : '')).join('')
    expect(concat).toBe('helloworld')
  })

  test('错位嵌套 → 优雅闭合不崩', () => {
    const out = splitMarkers(`${INS_OPEN}a${DEL_OPEN}b${DEL_CLOSE}`)
    // 入 ins 模式 → 遇 DEL_OPEN → 闭合 ins 段 'a' 然后开 del 段 'b'
    expect(out.length).toBeGreaterThan(0)
    const insClasses = out
      .filter((n) => n.type === 'diffMark')
      .map(
        (n) =>
          (n as { data: { hProperties: { className: string[] } } }).data.hProperties.className[0],
      )
    expect(insClasses).toContain('diff-ins')
    expect(insClasses).toContain('diff-del')
  })
})

describe('remarkDiffMarkers plugin', () => {
  test('递归 visit：替换 text 子节点', () => {
    // 模拟一棵 mdast root → paragraph → text，text 内含 INS marker
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: `hello ${INS_OPEN}new${INS_CLOSE}` }],
        },
      ],
    }
    const transform = remarkDiffMarkers()
    transform(tree)
    const para = tree.children[0] as { children: Array<{ type: string }> }
    expect(para.children).toHaveLength(2)
    expect(para.children[0]?.type).toBe('text')
    expect(para.children[1]?.type).toBe('diffMark')
  })

  test('深嵌套（emphasis 内）：marker 仍被替换', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'emphasis',
              children: [{ type: 'text', value: `${INS_OPEN}bold${INS_CLOSE}` }],
            },
          ],
        },
      ],
    }
    const transform = remarkDiffMarkers()
    transform(tree)
    const emphasis = (
      tree.children[0] as { children: Array<{ children: Array<{ type: string }> }> }
    ).children[0]
    expect(emphasis?.children[0]?.type).toBe('diffMark')
  })

  test('无 marker 的 text → 不动', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'plain' }] }],
    }
    const before = JSON.stringify(tree)
    remarkDiffMarkers()(tree)
    expect(JSON.stringify(tree)).toBe(before)
  })
})
