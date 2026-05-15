// RFC-010 — MarkdownDiffView 集成测试。
// 锚定：组件确实把 PUA marker 渲染成带 .diff-ins / .diff-del 的 <span>，
// 标题等块级结构在渲染中保留，<script> 字面量不会真生成 <script> 元素。

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownDiffView } from '@/components/review/MarkdownDiffView'

describe('MarkdownDiffView', () => {
  test('段内 word 改动 → .diff-ins / .diff-del span', () => {
    const { container } = render(
      <MarkdownDiffView left="the order_status enum" right="the order_status field" />,
    )
    const ins = container.querySelectorAll('.diff-ins')
    const del = container.querySelectorAll('.diff-del')
    expect(ins.length).toBeGreaterThan(0)
    expect(del.length).toBeGreaterThan(0)
    const insText = Array.from(ins)
      .map((n) => n.textContent ?? '')
      .join('')
    const delText = Array.from(del)
      .map((n) => n.textContent ?? '')
      .join('')
    expect(insText).toContain('field')
    expect(delText).toContain('enum')
  })

  test('heading 改字 → 仍然是 <h1>，不被 marker 拆散', () => {
    const { container } = render(<MarkdownDiffView left="# Old Title" right="# New Title" />)
    const h1 = container.querySelector('h1')
    expect(h1).not.toBeNull()
    expect(h1?.querySelector('.diff-ins')).not.toBeNull()
    expect(h1?.querySelector('.diff-del')).not.toBeNull()
  })

  test('list item 改字 → 仍然是 <ul><li>', () => {
    const { container } = render(
      <MarkdownDiffView left={'- buy milk\n- buy bread'} right={'- buy oats\n- buy bread'} />,
    )
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(2)
    // 第一项含 ins/del；第二项是纯 context
    const first = items[0]
    expect(first?.querySelector('.diff-ins')).not.toBeNull()
    expect(first?.querySelector('.diff-del')).not.toBeNull()
  })

  test('CJK：你好世界 → 你好新世界 仅 1 个 .diff-ins', () => {
    const { container } = render(<MarkdownDiffView left="你好世界" right="你好新世界" />)
    const ins = container.querySelectorAll('.diff-ins')
    expect(ins.length).toBe(1)
    // 渲染后 splitForWordDiff 注入的 ZWSP 仍可能残留在 segment 末尾，
    // 用 normalize（剥 ZWSP）后断言纯字面值，对未来字体 / 搜索友好。
    const ZWSP = '​'
    const norm = (s: string | null | undefined) => (s ?? '').replaceAll(ZWSP, '')
    expect(norm(ins[0]?.textContent)).toBe('新')
  })

  test('安全：<script> 字面量不会渲染成真实 <script>', () => {
    const { container } = render(
      <MarkdownDiffView left="hello" right="<script>alert(1)</script>" />,
    )
    expect(container.querySelectorAll('script').length).toBe(0)
  })

  test('完全相同 → 没有 .diff-ins / .diff-del', () => {
    const { container } = render(<MarkdownDiffView left="hello world" right="hello world" />)
    expect(container.querySelectorAll('.diff-ins').length).toBe(0)
    expect(container.querySelectorAll('.diff-del').length).toBe(0)
  })

  test('容器带 markdown-diff-view class，便于 CSS 局部作用域', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" />)
    expect(container.querySelector('.markdown-diff-view')).not.toBeNull()
  })

  test('容器带 data-granularity，反映传入 prop（默认 word）', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" />)
    expect(container.querySelector('[data-granularity="word"]')).not.toBeNull()
  })
})

describe('MarkdownDiffView — line granularity', () => {
  test('单行改字 → 整行 ins / del', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'hello world\nstable line\n'}
        right={'hello earth\nstable line\n'}
        granularity="line"
      />,
    )
    const ins = container.querySelectorAll('.diff-ins')
    const del = container.querySelectorAll('.diff-del')
    expect(ins.length).toBeGreaterThan(0)
    expect(del.length).toBeGreaterThan(0)
    const insText = Array.from(ins)
      .map((n) => n.textContent ?? '')
      .join('')
    const delText = Array.from(del)
      .map((n) => n.textContent ?? '')
      .join('')
    expect(insText).toContain('hello earth')
    expect(delText).toContain('hello world')
  })

  test('整行新增 → 仅 ins', () => {
    const { container } = render(
      <MarkdownDiffView left={'a\nb\n'} right={'a\nb\nc\n'} granularity="line" />,
    )
    expect(container.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.diff-del').length).toBe(0)
  })

  test('容器 data-granularity 反映 line', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" granularity="line" />)
    expect(container.querySelector('[data-granularity="line"]')).not.toBeNull()
  })

  // 用户回归（line 模式 CJK 单行替换）：
  //   left  "单人/双人游戏模式"
  //   right "单人游戏模式"
  // 旧实现下，新行的 INS marker 渲染丢失（用户原话：下面那句话没标绿）。
  // 锁住：渲染后必须同时存在 .diff-del 和 .diff-ins，文本各对应。
  test('CJK 单行替换 → 同时渲染 .diff-del 和 .diff-ins span', () => {
    const { container } = render(
      <MarkdownDiffView left={'单人/双人游戏模式'} right={'单人游戏模式'} granularity="line" />,
    )
    expect(container.querySelector('.diff-del')?.textContent).toBe('单人/双人游戏模式')
    expect(container.querySelector('.diff-ins')?.textContent).toBe('单人游戏模式')
  })

  test('列表项内 CJK 单行替换 → li 内同时含 .diff-del 和 .diff-ins', () => {
    const { container } = render(
      <MarkdownDiffView
        left={['- 单人/双人游戏模式', '- 多人游戏模式'].join('\n')}
        right={['- 单人游戏模式', '- 多人游戏模式'].join('\n')}
        granularity="line"
      />,
    )
    const items = container.querySelectorAll('li')
    expect(items.length).toBeGreaterThanOrEqual(2)
    const allDel = container.querySelector('.diff-del')
    const allIns = container.querySelector('.diff-ins')
    expect(allDel?.textContent).toBe('单人/双人游戏模式')
    expect(allIns?.textContent).toBe('单人游戏模式')
  })

  // 用户回归：root cause 是 jsdiff diffLines 在 input 缺尾 \n 时 emit 的
  // 最后一段 value 也没 \n，buildMergedMarkdown 拼回时 DEL + INS 糊在一行，
  // 第二行的 markdown 结构字符（## / -）落进第一行的 text 里，导致：
  //   - heading 模式下两 h2 合成一个 <h2>，第二个 ## 变成 heading 内文本
  //   - list 模式下两 li 合成一个 <li>，新行 INS 紧贴在旧行 DEL 后面
  // 修复：computeChanges 在 line 路径上对 left/right 做 ensureTrailingNewline。
  test('裸 heading 替换（无 trailing \\n）→ 必须渲染 2 个独立 <h2>', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'## 单人/双人游戏模式'}
        right={'## 单人游戏模式'}
        granularity="line"
      />,
    )
    const headings = container.querySelectorAll('h2')
    expect(headings.length).toBe(2)
    expect(headings[0]?.querySelector('.diff-del')?.textContent).toBe('单人/双人游戏模式')
    expect(headings[1]?.querySelector('.diff-ins')?.textContent).toBe('单人游戏模式')
  })

  test('裸 list item 替换（无 trailing \\n）→ 必须渲染 2 个独立 <li>', () => {
    const { container } = render(
      <MarkdownDiffView left={'- 单人/双人游戏模式'} right={'- 单人游戏模式'} granularity="line" />,
    )
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(2)
    expect(items[0]?.querySelector('.diff-del')?.textContent).toBe('单人/双人游戏模式')
    expect(items[1]?.querySelector('.diff-ins')?.textContent).toBe('单人游戏模式')
  })
})

describe('MarkdownDiffView — block granularity', () => {
  test('整段重写 → 旧段 del + 新段 ins，结构保留', () => {
    const left = 'first paragraph\n\nold paragraph two\n\nthird paragraph\n'
    const right = 'first paragraph\n\nbrand new paragraph two\n\nthird paragraph\n'
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    const ins = container.querySelectorAll('.diff-ins')
    const del = container.querySelectorAll('.diff-del')
    expect(del.length).toBeGreaterThan(0)
    expect(ins.length).toBeGreaterThan(0)
    const allText = container.textContent ?? ''
    expect(allText).toContain('first paragraph')
    expect(allText).toContain('third paragraph')
  })

  test('整段新增（含 heading + list）→ 渲染保留 <h2> + <ul>', () => {
    const left = 'paragraph one\n'
    const right = 'paragraph one\n\n## New Section\n\n- bullet a\n- bullet b\n'
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    expect(container.querySelector('h2')).not.toBeNull()
    expect(container.querySelectorAll('li').length).toBe(2)
    expect(container.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
  })

  test('容器 data-granularity 反映 block', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" granularity="block" />)
    expect(container.querySelector('[data-granularity="block"]')).not.toBeNull()
  })

  // 用户回归：block 模式必须真正 RENDER 出独立段落，不再像旧 line 实现
  // 那样把多块挤进一行或被代码块吞掉。
  test('段落级改动 → 渲染成 4 个独立 <p>，旧段 del / 新段 ins 各自成段', () => {
    const left = 'Intro.\n\nMiddle old.\n\nEnd.'
    const right = 'Intro.\n\nMiddle new.\n\nEnd.'
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs.length).toBe(4) // Intro / Middle old / Middle new / End
    expect(paragraphs[1]?.querySelector('.diff-del')?.textContent).toBe('Middle old.')
    expect(paragraphs[2]?.querySelector('.diff-ins')?.textContent).toBe('Middle new.')
  })

  test('代码块改动 → 渲染保留 <pre><code> 结构（fence 不被 marker 拆破）', () => {
    const left = ['# Spec', '', '```ts', 'old()', '```'].join('\n')
    const right = ['# Spec', '', '```ts', 'new()', '```'].join('\n')
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    // 必须有正确解析出的 <pre> + <code>，否则就说明 fence 被 marker 破坏
    expect(container.querySelector('pre code')).not.toBeNull()
    const allText = container.textContent ?? ''
    expect(allText).toContain('old()')
    expect(allText).toContain('new()')
  })
})
