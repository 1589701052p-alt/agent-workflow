// RFC-010 — Markdown 渲染态 diff 的核心：把两份 markdown 用 jsdiff 算
// 差异，再把添加 / 删除段用 PUA marker 包起来后拼回单串 markdown。
// 这串 markdown 喂给 react-markdown，配合 remarkDiffMarkers 插件就能在
// 渲染态 prose 上看到内联高亮。
//
// 三种 granularity 共用同一管线，差异仅在 jsdiff 入参：
//   word  → diffWordsWithSpace（+ CJK Intl.Segmenter pre-segmenting）
//   line  → diffLines
//   block → 按空行切块后 diffLines（沿用旧 DiffView.diffBlocks 思路）

import { diffArrays, diffLines, diffWordsWithSpace, type Change } from 'diff'

export type DiffGranularity = 'word' | 'line' | 'block'

/** PUA marker codepoints — 见 design.md §PUA marker 选择。 */
export const MARKERS = {
  INS_OPEN: '',
  INS_CLOSE: '',
  DEL_OPEN: '',
  DEL_CLOSE: '',
} as const

const ANY_MARKER_RE = /[-]/g
const ZWSP = '​'

/**
 * UTF-8 / CJK-safe word splitter（与 DiffView.splitForWordDiff 同一思路：
 * jsdiff 的 \W 切分对 CJK 整段不友好，先用 Intl.Segmenter 在 CJK 之间塞
 * 零宽空格，diff 完后再剥掉）。导出供测试与 DiffView 复用。
 */
export function splitForWordDiff(s: string): string {
  const Seg = (globalThis as Record<string, unknown>).Intl as
    | { Segmenter?: typeof Intl.Segmenter }
    | undefined
  if (Seg?.Segmenter === undefined) return s
  // eslint-disable-next-line no-irregular-whitespace
  if (!/[　-鿿가-힯]/.test(s)) return s
  const seg = new Seg.Segmenter('zh', { granularity: 'word' })
  let out = ''
  for (const it of seg.segment(s)) {
    out += it.segment + ZWSP
  }
  return out
}

/**
 * 行首结构性 markdown 前缀（heading / list / blockquote / table cell 起手 |）。
 * marker 不能落在这些字符之前，否则 markdown 解析失败。我们把 marker 推到
 * 前缀之后。
 */
const LEADING_BLOCK_PREFIX_RE = /^(\s*(?:>+\s*)*(?:[-*+]\s+|#{1,6}\s+|\d+\.\s+|\|\s*)?)([\s\S]*)$/

/** 判断一行是否完全空白（含纯 marker，剥掉后为空）。 */
function isBlank(line: string): boolean {
  return line.replace(ANY_MARKER_RE, '').trim().length === 0
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/

/**
 * 把一段 value 用 open/close marker 逐行包裹。规则：
 *   - 空行不包（保持段落分隔）
 *   - 行首 markdown 结构前缀（`# ` / `- ` / `> ` / `| ` / `1. `）保留在
 *     marker 之外
 *   - fenced code block 的 fence 行（` ``` ` / `~~~`）以及 fence 内部行
 *     不包 marker：marker 落在 fence 头部会让 markdown 解析器丢掉整个
 *     fence；落在 fence 内部又只是 code 文本内的 PUA 字符（remark 不会
 *     把它转成 hast `<span>`）—— 两种情况都没意义。block 模式下旧 / 新
 *     代码块仍会以正常 prose 在前后渲染，reviewer 可以直接对比。
 */
function wrapLines(value: string, open: string, close: string): string {
  if (value.length === 0) return ''
  const lines = value.split('\n')
  const wrapped: string[] = []
  let fenceMarker = ''
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMarker !== '') {
      wrapped.push(line)
      if (fenceMatch !== null && (fenceMatch[2] ?? '').startsWith(fenceMarker)) {
        fenceMarker = ''
      }
      continue
    }
    if (fenceMatch !== null) {
      wrapped.push(line)
      fenceMarker = fenceMatch[2] ?? ''
      continue
    }
    if (isBlank(line)) {
      wrapped.push(line)
      continue
    }
    const m = LEADING_BLOCK_PREFIX_RE.exec(line)
    const prefix = m?.[1] ?? ''
    const body = m?.[2] ?? line
    wrapped.push(prefix + open + body + close)
  }
  return wrapped.join('\n')
}

/**
 * block 模式的 diff：把空行分隔的"段"当原子单元，用 jsdiff `diffArrays`
 * 在 string[] 上跑严格相等比较，每个变更段内部用 `\n\n` 还原段间分隔。
 *
 * 旧实现把所有块用 `\n` join 后再走 `diffLines`，会导致代码块 / 表格 /
 * 列表的内部 `\n` 被当作 line 边界，块结构被切散。改用 diffArrays 后
 * 每个 block 作为一个原子 token 进入 diff，结构得以保留。
 */
function diffBlocks(left: string, right: string): Change[] {
  const splitBlocks = (s: string): string[] => s.split(/\n{2,}/g)
  const raw = diffArrays<string>(splitBlocks(left), splitBlocks(right))
  // diffArrays 的 value 是 string[]：把同向连续块用 \n\n 拼回 markdown
  // 字符串。强转 unknown 是因为 jsdiff 的 Change 公共类型 value=string，
  // 而 diffArrays 内部用了 ChangeObject<string[]>。
  return raw.map((c) => ({
    ...c,
    value: (c.value as unknown as string[]).join('\n\n'),
  }))
}

/**
 * line 模式必须保证每条 jsdiff change 的 value 都以 `\n` 结尾，否则相邻
 * removed + added 拼回 markdown 时会糊在一行——典型表现：
 *   - heading 改字 → 第二行的 `## ` 落进第一行 heading 的 text 里
 *   - 列表项改字 → 两 `<li>` 合成一个，新行 `<span class="diff-ins">`
 *     直接接在旧行 `<span class="diff-del">` 后面，看起来像"新行没标绿"
 * jsdiff diffLines 在 input 不含 trailing newline 时 emit 的最后一段
 * value 也没有 \n，所以在调用前先 normalize 两侧都补一个 \n。
 */
function ensureTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith('\n') ? s : s + '\n'
}

function computeChanges(left: string, right: string, granularity: DiffGranularity): Change[] {
  if (granularity === 'word') {
    return diffWordsWithSpace(splitForWordDiff(left), splitForWordDiff(right))
  }
  if (granularity === 'line') {
    return diffLines(ensureTrailingNewline(left), ensureTrailingNewline(right))
  }
  return diffBlocks(left, right)
}

/**
 * 主入口：给定 left / right 两份 markdown 与 granularity，返回一份 merged
 * markdown：添加段被 INS marker 包裹、删除段被 DEL marker 包裹，其它部分
 * 原样。三种 granularity 共用 wrapLines 逻辑（每非空行独立包对，行首
 * markdown 结构前缀保留在 marker 之外）。
 *
 * 输出会剥掉 splitForWordDiff 注入的 ZWSP——保留 ZWSP 会污染用户复制
 * 的文本（与 DiffView.postProcessWordSegments 行为对齐）。
 */
export function buildMergedMarkdown(
  left: string,
  right: string,
  granularity: DiffGranularity = 'word',
): string {
  const changes = computeChanges(left, right, granularity)
  // block 模式每个 change 是 0+ 块（已用 \n\n 拼接），相邻 change 之间也
  // 必须有 \n\n 才能维持段落边界；word/line 模式下相邻 change 直接拼接。
  const separator = granularity === 'block' ? '\n\n' : ''
  const parts: string[] = []
  for (const c of changes) {
    if (c.added === true) {
      parts.push(wrapLines(c.value, MARKERS.INS_OPEN, MARKERS.INS_CLOSE))
    } else if (c.removed === true) {
      parts.push(wrapLines(c.value, MARKERS.DEL_OPEN, MARKERS.DEL_CLOSE))
    } else {
      parts.push(c.value)
    }
  }
  return parts.join(separator).replaceAll(ZWSP, '')
}

// 仅供测试与 DiffView 内部复用。
export const _internal = {
  wrapLines,
  isBlank,
  LEADING_BLOCK_PREFIX_RE,
  diffBlocks,
  computeChanges,
}
