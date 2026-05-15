// RFC-010 — remark 插件：把 PUA marker（INS_OPEN/CLOSE、DEL_OPEN/CLOSE）
// 从 mdast 的 text 节点里切出来，替换成带 hName='span' + className 的
// "diffMark" 节点。mdast→hast 阶段会按 hName/hProperties 直接生成
// <span class="diff-ins"|"diff-del">，全程不依赖 rehype-raw（保持 RFC-008
// 的 XSS-safe 不变量）。
//
// 算法：
//   1. 递归 visit 所有节点；对每个有 children 的节点扫描其 children。
//   2. 若一个 text 子节点的 value 含 marker，调 splitMarkers 拆成
//      (text | diffMark)[] 序列，原地替换 children 数组。
//   3. 未配对的 open marker 静默吞掉（容错），保证渲染不崩。
//
// 不引入 unist-util-visit 依赖，递归足够用。

import { MARKERS } from './markdownDiff'

// 注意：直接在 source 用 PUA 字符字面量做 regex character class 容易在
// 编辑链路上被剥（曾被 Write 工具脱掉），改为运行时拼接，从 MARKERS
// 单一来源派生，避免漂移。
const ANY_MARKER_RE = new RegExp(
  '[' + MARKERS.INS_OPEN + MARKERS.INS_CLOSE + MARKERS.DEL_OPEN + MARKERS.DEL_CLOSE + ']',
)

interface TextNode {
  type: 'text'
  value: string
}

interface DiffMarkNode {
  type: 'diffMark'
  data: {
    hName: 'span'
    hProperties: { className: string[] }
  }
  children: TextNode[]
}

interface ParentNode {
  type: string
  children?: AnyNode[]
  value?: string
}

type AnyNode = ParentNode | TextNode | DiffMarkNode

type Mode = 'context' | 'ins' | 'del'

/**
 * 状态机扫一遍 s，按 marker 切分输出 (text | diffMark)[]。
 * 未配对的 open marker 直接丢，未配对的 close marker 当作普通字符。
 */
export function splitMarkers(s: string): Array<TextNode | DiffMarkNode> {
  const out: Array<TextNode | DiffMarkNode> = []
  let mode: Mode = 'context'
  let buf = ''

  const flushContext = () => {
    if (buf.length > 0) {
      out.push({ type: 'text', value: buf })
      buf = ''
    }
  }
  const flushDiff = (kind: Mode) => {
    if (buf.length > 0) {
      out.push({
        type: 'diffMark',
        data: {
          hName: 'span',
          hProperties: { className: [kind === 'ins' ? 'diff-ins' : 'diff-del'] },
        },
        children: [{ type: 'text', value: buf }],
      })
      buf = ''
    }
  }

  for (const ch of s) {
    if (mode === 'context') {
      if (ch === MARKERS.INS_OPEN) {
        flushContext()
        mode = 'ins'
      } else if (ch === MARKERS.DEL_OPEN) {
        flushContext()
        mode = 'del'
      } else if (ch === MARKERS.INS_CLOSE || ch === MARKERS.DEL_CLOSE) {
        // 未配对 close — 当作普通字符吞掉（不渲染 PUA）
      } else {
        buf += ch
      }
    } else if (mode === 'ins') {
      if (ch === MARKERS.INS_CLOSE) {
        flushDiff('ins')
        mode = 'context'
      } else if (ch === MARKERS.INS_OPEN || ch === MARKERS.DEL_OPEN || ch === MARKERS.DEL_CLOSE) {
        // 嵌套 / 错位：先关上当前 diff，再继续解析当前字符
        flushDiff('ins')
        mode = 'context'
        if (ch === MARKERS.INS_OPEN) mode = 'ins'
        else if (ch === MARKERS.DEL_OPEN) mode = 'del'
      } else {
        buf += ch
      }
    } else {
      // mode === 'del'
      if (ch === MARKERS.DEL_CLOSE) {
        flushDiff('del')
        mode = 'context'
      } else if (ch === MARKERS.DEL_OPEN || ch === MARKERS.INS_OPEN || ch === MARKERS.INS_CLOSE) {
        flushDiff('del')
        mode = 'context'
        if (ch === MARKERS.DEL_OPEN) mode = 'del'
        else if (ch === MARKERS.INS_OPEN) mode = 'ins'
      } else {
        buf += ch
      }
    }
  }

  // 终止：未闭合的 diff 段落直接吞掉（保留文本但不加高亮）
  if (mode === 'context') {
    flushContext()
  } else {
    if (buf.length > 0) out.push({ type: 'text', value: buf })
    buf = ''
  }

  return out
}

function transformChildren(parent: ParentNode): void {
  const kids = parent.children
  if (kids === undefined) return
  const next: AnyNode[] = []
  for (const child of kids) {
    if (child.type === 'text') {
      const value = (child as TextNode).value
      if (ANY_MARKER_RE.test(value)) {
        next.push(...splitMarkers(value))
      } else {
        next.push(child)
      }
    } else {
      next.push(child)
      transformChildren(child as ParentNode)
    }
  }
  parent.children = next
}

/**
 * unified Plugin（loose typing — 不强依赖 unified/mdast 类型包，避免
 * 在 frontend package.json 多塞依赖）。
 */
export function remarkDiffMarkers(): (tree: ParentNode) => void {
  return (tree) => {
    transformChildren(tree)
  }
}
