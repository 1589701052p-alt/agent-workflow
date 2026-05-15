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
    // RFC-012：markdown 表格分隔符行（`|---|---|`）不能携带任何 PUA marker，
    // 否则 GFM 表分隔符正则匹配失败、整张表降级为段落。整张表已在 word 路径
    // 上由占位符保证为单一 ins/del/unchanged change，分隔行不带 marker
    // 不会丢失 diff 语义（颜色仍由 header/body 行的 marker 提供）。
    if (TABLE_SEP_RE.test(line)) {
      wrapped.push(line)
      continue
    }
    if (TABLE_ROW_RE.test(line)) {
      // RFC-012：表格 header / body 行（不是 separator）按 cell 逐个包 marker。
      // 一行内的 open/close 不能跨 `|`——markdown 解析时 `|` 是单元格边界，
      // 跨界的 open 与 close 落在不同 `<td>` 里、remarkDiffMarkers 看到的
      // 各自是孤儿 marker，统统被吞，diff 高亮消失。逐 cell 包就避免了。
      wrapped.push(wrapTableRowCells(line, open, close))
      continue
    }
    const m = LEADING_BLOCK_PREFIX_RE.exec(line)
    const prefix = m?.[1] ?? ''
    const body = m?.[2] ?? line
    wrapped.push(prefix + open + body + close)
  }
  return wrapped.join('\n')
}

// 把"行首 `|`"的表格行按未转义 `|` 切成 cells，对每个非空 cell 用
// open/close 包裹其修剪后的 body（保留周边空白在 marker 外侧）。前后
// 哑 cell（leading / trailing `|` 之前 / 之后）不包。
function wrapTableRowCells(line: string, open: string, close: string): string {
  const parts = line.split(/(?<!\\)\|/g)
  const wrapped = parts.map((cell, i) => {
    if (i === 0 || i === parts.length - 1) {
      if (cell.trim() === '') return cell
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(cell)
    if (m === null) return cell
    const lead = m[1] ?? ''
    const inner = m[2] ?? ''
    const tail = m[3] ?? ''
    if (inner.length === 0) return cell
    return lead + open + inner + close + tail
  })
  return wrapped.join('|')
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

// RFC-012 — markdown 表格块原子化（仅 word 路径用）。
//
// 背景：jsdiff `diffWordsWithSpace` 把每个 `|` / 单个 `-` / `:` 当独立 token
// 对齐。当左右两侧表格列数 / 分隔符宽度不同（或一侧是表、一侧是段落）时，
// jsdiff 在分隔符 `-` 粒度上把内容碎成一堆 ins/del，wrapLines 又把每条碎片
// 包了 marker，最终 GFM 表分隔符正则识别失败，整张表降级为 `<p>` + 裸 `|---|`
// 字符可见——肉眼像"乱码"。
//
// 对策：word 路径在 splitForWordDiff 之前，把每张 markdown 表抽出来用单个
// PUA 占位符替换；diff 完再把占位符还原成原表文本。占位符是 1-codepoint
// `\W` 非单词字符，jsdiff 一定会把它独立成 token——整张表要么 unchanged、
// 要么 ins、要么 del，不会内部碎裂。

const TABLE_ROW_RE = /^ {0,3}\|/
const TABLE_SEP_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
// 占位符用 U+E010-U+EFFF 区间（与 MARKERS 的 U+E000-U+E003 留 12 字隔离带），
// 每张表分配 1 个 codepoint；左右两侧通过"内容是否字节相等"决定共用 / 独立。
const TABLE_PLACEHOLDER_BASE = 0xe010
const TABLE_PLACEHOLDER_END = 0xefff
const TABLE_PLACEHOLDER_RE = /[-]/g

/**
 * 找出 text 中所有 markdown 表格块，返回每块的起止行号与内容。
 * 表格起点：行匹配 TABLE_ROW_RE 且下一行匹配 TABLE_SEP_RE；
 * 延续直到出现非 TABLE_ROW_RE 行或 EOF。
 */
function findTableBlocks(text: string): Array<{ start: number; end: number; content: string }> {
  const lines = text.split('\n')
  const blocks: Array<{ start: number; end: number; content: string }> = []
  let i = 0
  while (i < lines.length) {
    if (
      TABLE_ROW_RE.test(lines[i] ?? '') &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1] ?? '')
    ) {
      let j = i + 1
      while (j + 1 < lines.length && TABLE_ROW_RE.test(lines[j + 1] ?? '')) j++
      blocks.push({ start: i, end: j, content: lines.slice(i, j + 1).join('\n') })
      i = j + 1
    } else {
      i++
    }
  }
  return blocks
}

/**
 * 把 text 内每段 blocks[i] 替换成 placeholders[i]（单行）。其它行保持不变。
 * 调用者保证 blocks 与 placeholders 长度一致、blocks 按起始行升序。
 */
function replaceTableBlocks(
  text: string,
  blocks: Array<{ start: number; end: number }>,
  placeholders: string[],
): string {
  if (blocks.length === 0) return text
  const lines = text.split('\n')
  const out: string[] = []
  let cursor = 0
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k]!
    for (let i = cursor; i < b.start; i++) out.push(lines[i] ?? '')
    out.push(placeholders[k] ?? '')
    cursor = b.end + 1
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i] ?? '')
  return out.join('\n')
}

/**
 * word 路径专属：抽 left / right 中所有表格块，按位置 + 内容相等性分配
 * 占位符——左右第 i 块内容字节相等时共用同一占位符（保留 unchanged 语义），
 * 否则两侧各分配独立占位符（jsdiff 会作为 del + ins emit，渲染成两张表）。
 *
 * 返回 lookup 把占位符 codepoint 映射回原表文本，供 restoreTablePlaceholders
 * 在 diff 完成后回填。
 */
function pretreatTablesForWordDiff(
  left: string,
  right: string,
): { lTokens: string; rTokens: string; lookup: Map<string, string> } {
  const lBlocks = findTableBlocks(left)
  const rBlocks = findTableBlocks(right)
  if (lBlocks.length === 0 && rBlocks.length === 0) {
    return { lTokens: left, rTokens: right, lookup: new Map() }
  }
  const lookup = new Map<string, string>()
  let next = TABLE_PLACEHOLDER_BASE
  const alloc = (content: string): string => {
    if (next > TABLE_PLACEHOLDER_END) {
      // 极端兜底：表数超过 ~4080 时退回不保护（行为退回到 RFC-010 原状）。
      // 测试断言不依赖此分支；保留是为了不抛错。
      return ''
    }
    const ph = String.fromCodePoint(next++)
    lookup.set(ph, content)
    return ph
  }
  const lPh: string[] = []
  const rPh: string[] = []
  const n = Math.max(lBlocks.length, rBlocks.length)
  for (let i = 0; i < n; i++) {
    const lb = lBlocks[i]
    const rb = rBlocks[i]
    if (lb !== undefined && rb !== undefined && lb.content === rb.content) {
      const ph = alloc(lb.content)
      lPh.push(ph)
      rPh.push(ph)
    } else {
      if (lb !== undefined) lPh.push(alloc(lb.content))
      if (rb !== undefined) rPh.push(alloc(rb.content))
    }
  }
  return {
    lTokens: replaceTableBlocks(left, lBlocks, lPh),
    rTokens: replaceTableBlocks(right, rBlocks, rPh),
    lookup,
  }
}

/**
 * 把 changes 里每个 value 中的表格占位符还原成 lookup 中的原表文本。
 *
 * 回填时强制在表前后补 `\n\n`：当 jsdiff emit 相邻的 removed + added 两条
 * change 时，把它们拼到同一物理行（word 模式 separator=""），下一段表会
 * 紧接上一段表的最后一行 `| 文档状态 | 初稿 |[DC]| 项目 | 内容 |[IC]`，
 * markdown 解析器只能把它们当成一张表的多行，分隔符就此错位。补 `\n\n`
 * 保证每张表独立成段；wrapLines 看到的空白行会原样保留，不会插入 marker。
 */
function restoreTablePlaceholders(changes: Change[], lookup: Map<string, string>): Change[] {
  if (lookup.size === 0) return changes
  return changes.map((c) => ({
    ...c,
    value: c.value.replace(TABLE_PLACEHOLDER_RE, (ch) => {
      const content = lookup.get(ch)
      if (content === undefined) return ch
      return '\n\n' + content + '\n\n'
    }),
  }))
}

function computeChanges(left: string, right: string, granularity: DiffGranularity): Change[] {
  if (granularity === 'word') {
    // RFC-012：先抽出表格块用占位符替换，再走 splitForWordDiff + jsdiff，
    // 最后还原占位符。splitForWordDiff 看到的只是占位符 + 非表文本，CJK
    // 分词不会触及表内容；jsdiff 因占位符是 \W 单 codepoint 一定把整张表
    // 当原子 token 对齐。
    const pre = pretreatTablesForWordDiff(left, right)
    const raw = diffWordsWithSpace(splitForWordDiff(pre.lTokens), splitForWordDiff(pre.rTokens))
    return restoreTablePlaceholders(raw, pre.lookup)
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
  // RFC-012 表格保护：供测试锁定 word 路径的 pretreat / restore 行为。
  findTableBlocks,
  pretreatTablesForWordDiff,
  restoreTablePlaceholders,
  TABLE_ROW_RE,
  TABLE_SEP_RE,
  TABLE_PLACEHOLDER_BASE,
  TABLE_PLACEHOLDER_END,
}
