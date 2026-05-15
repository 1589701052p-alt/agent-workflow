# RFC-010 — 技术设计

## 模块拓扑

```
DiffView (薄壳，只做 granularity 转发)
  └─→ MarkdownDiffView(left, right, granularity)    // 三模式共用
          ├─ buildMergedMarkdown(left, right, granularity)   // lib/review/markdownDiff.ts
          ├─ ReactMarkdown
          │    ├─ remarkPlugins:  [remarkGfm, remarkAlert, remarkMath, remarkDiffMarkers]
          │    └─ rehypePlugins:  (与 Prose 同款：rehype-katex / slug / autolink-headings / external-links)
          └─ fallback：构建 / 渲染异常时回到 <pre>
```

旧的"左右两栏 + 源码红绿块 + 标题 slug 滚动同步"实现整体删除（含 `_internal.changesToSegments` / `headingSlug` / `slugify` / pane 渲染 / `useEffect` 滚动同步）。

## 数据流

```
left, right, granularity (word | line | block)
  │
  ▼ jsdiff
     - word :  diffWordsWithSpace(splitForWordDiff(L), splitForWordDiff(R))
     - line :  diffLines(L, R)
     - block:  diffLines(splitBlocks(L).join('\n'), splitBlocks(R).join('\n'))
               + 把 '\n' 还原为 '\n\n' 维持段落分隔
Change[]
  │
  ▼ buildMergedMarkdown 把 added / removed 段用 wrapLines 逐行包 PUA marker
merged: string  含 PUA marker:
  U+E000 INS_OPEN  / U+E001 INS_CLOSE
  U+E002 DEL_OPEN  / U+E003 DEL_CLOSE
  │
  ▼ remark 解析 (gfm)
mdast tree
  │
  ▼ remarkDiffMarkers visitor
mdast tree（marker 拆分进自定义 'diffMark' 节点；带 hName/hProperties 直达 hast）
  │
  ▼ remark→rehype + 现有 rehype 链
hast
  │
  ▼ react-markdown render
JSX  含 <span class="diff-ins"> / <span class="diff-del">
```

## 三模式 jsdiff 路径差异

| granularity | jsdiff 调用                                                         | wrap 单位                | 典型 review 场景                               |
| ----------- | ------------------------------------------------------------------- | ------------------------ | ---------------------------------------------- |
| word        | `diffWordsWithSpace` + `splitForWordDiff`                           | 单词 / 标点 / 空白 token | 段内小修、错字、术语调整                       |
| line        | `diffLines`                                                         | 整行                     | 单条新增 / 删除、列表项增删、单行 heading 改动 |
| block       | `diffArrays<string>` on `splitBlocks(s)` 数组（每块作为原子 token） | 整段（空行分隔）         | 整段重写、段落顺序调整、章节级新增 / 删除      |

`wrapLines` 对三种粒度统一处理：

- marker 推到行首结构前缀（`# ` / `- ` / `> ` / `| ` / `1. `）之后；
- 空行不包；多行段每非空行独立包一对 marker；
- **fenced code 行（` ``` ` / `~~~`）以及 fence 内部行不包**——marker 落在 fence 头会让 markdown 丢掉整个代码块；落在 fence 内又只是 code 文本里的 PUA 字符（不会变 hast `<span>`）。block 模式下旧 / 新两个代码块照常以 prose 形式前后渲染，reviewer 直接对照即可。

这保证：

- 行 / 块级删除时，`<h2>`、`<li>`、表格 cell、` ```ts ` 仍能被 markdown 解析器正确识别
- 单段 add / del 即使横跨多个 block，每个 block 内 marker 都自闭合，remark 插件不会遇到跨 block 的未闭合 marker

**block 模式段间分隔**：`buildMergedMarkdown` 在 block 路径下用 `\n\n` 把每个 change 的产物拼起来（word / line 直接拼接）。这条至关重要——否则 `[DEL]A[/DEL][INS]B[/INS]` 会被 markdown 解析成单段。

## PUA marker 选择

使用 Unicode 私用区（Private Use Area）4 个字符：

| 用途      | 码点 | 助记 |
| --------- | ---- | ---- |
| INS open  | ``  | + 开 |
| INS close | ``  | + 关 |
| DEL open  | ``  | − 开 |
| DEL close | ``  | − 关 |

**为什么 PUA**：

- 不会出现在任何正常 markdown / 代码 / CJK 文本中（私用区按定义不分配字符）。
- 不是 markdown 结构字符（不是 `#`、`*`、`_`、`-`、`>`、`|`、` `` ` `、`[`、`]`），不会触发任何 markdown 语法误判。
- 是 1-codepoint 字符，对 word-diff 文本长度的影响最小，jsdiff 输出回放时不易破坏。

## `buildMergedMarkdown` 算法

```ts
function buildMergedMarkdown(
  left: string,
  right: string,
  granularity: 'word' | 'line' | 'block' = 'word',
): string {
  const changes =
    granularity === 'word'
      ? diffWordsWithSpace(splitForWordDiff(left), splitForWordDiff(right))
      : granularity === 'line'
        ? diffLines(left, right)
        : diffBlocks(left, right) // diffArrays<string> on splitBlocks(s)
  // block 模式段间必须用 \n\n 隔开（否则相邻段糊成一个 markdown 段落）；
  // word / line 模式无此需求，直接拼接。
  const sep = granularity === 'block' ? '\n\n' : ''
  const parts: string[] = []
  for (const c of changes) {
    if (c.added === true) parts.push(wrapLines(c.value, INS_OPEN, INS_CLOSE))
    else if (c.removed === true) parts.push(wrapLines(c.value, DEL_OPEN, DEL_CLOSE))
    else parts.push(c.value)
  }
  return parts.join(sep).replaceAll(ZWSP, '')
}

function diffBlocks(left: string, right: string): Change[] {
  // 关键：把"段"作为原子 token 进 diffArrays，避免代码块 / 列表的内部
  // \n 被 diffLines 当 line 边界拆散（旧实现踩过这坑——block 看起来等同
  // 于 line，且代码块 fence 被切散后丢渲染）。
  const splitBlocks = (s: string): string[] => s.split(/\n{2,}/g)
  const raw = diffArrays<string>(splitBlocks(left), splitBlocks(right))
  return raw.map((c) => ({
    ...c,
    value: (c.value as unknown as string[]).join('\n\n'),
  }))
}
```

`wrapLines(value, open, close)` 的细节：**遇到 `\n` 时按行切**，每非空行段独立包一对 marker；fence 行（` ``` ` / `~~~`）及 fence 内部行不包：

```
wrap('foo\n# Bar\nbaz', '', '')
  →  'foo\n# Bar\nbaz'
```

为什么这样：marker 跨行会导致 markdown 解析时 marker 落在不同 mdast block 内（标题节点 + 段落节点），但 mdast 没有跨 block 的"连续高亮"概念。按行切之后每对 marker 完整落在某一个 block 的某个 inline text 节点中，remark 插件只需做局部 split 即可。

**特殊处理**：

- 完全空行（`\n\n` 之间）：不包 marker，原样保留以维持段落分隔。
- 如果某一行已经以 `#`、`-`、`>` 等 block 触发字符开头，marker 落在行首会让 markdown 解析失败（`# Bar` 不是 heading）。**对策**：在 wrap 时，若某行匹配 `^(\s*[#>-]+\s+)(.*)`，把 marker 放到前缀之后：`'#  ' + 'Bar'`。同理 `^(\s*\d+\.\s+)`、`^(\s*\|\s*)`。
- 若 wrap 后某段为空字符串（仅纯空白），不输出 marker。

## `remarkDiffMarkers` 插件

```ts
const remarkDiffMarkers: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'text', (node, index, parent) => {
    if (parent === undefined || index === undefined) return
    if (!/[-]/.test(node.value)) return
    parent.children.splice(index, 1, ...splitMarkers(node.value))
    return [SKIP, index] // 跳过新插入的节点
  })
}
```

`splitMarkers(s: string)` 逐字符扫描，输出 `(text | diffMark)[]`：

- 状态机：`{ buffer: string, mode: 'context'|'ins'|'del' }`
- 遇到 ``：flush context buffer（push text 节点），切到 ins 模式
- 遇到 ``：flush ins buffer 为 `{ type: 'diffMark', hName: 'span', hProperties: { className: ['diff-ins'] }, children: [text] }`，回 context
- DEL 同理但 className `diff-del`
- 终止：剩余 buffer 视作 context flush；任何未配对的 open marker 静默吞掉（容错）

自定义节点形态（mdast→hast 阶段直接消费 `data.hName` / `data.hProperties`）：

```ts
{
  type: 'diffMark',
  data: {
    hName: 'span',
    hProperties: { className: ['diff-ins'] }   // or ['diff-del']
  },
  children: [{ type: 'text', value: '...' }]
}
```

**类型扩展**：在插件文件顶端用 `declare module 'mdast'` 把 `diffMark` 加入 mdast 的 `BlockContentMap`/`PhrasingContentMap`，让 TypeScript 不抱怨；运行时 react-markdown 看到 `data.hName` 就直接把节点降级成 `<span>` 渲染，children 走默认。

## 代码块 / inline code 策略（v1 限制）

fenced code block 内部和 inline code 内部的 PUA marker **不会被 remark 解析为 marker**——它们是 code 节点的 `value` 而不是 inline text node。因此 `buildMergedMarkdown` 输出的 marker 若落在 code block 中会原样显示为不可见 PUA 字符（默认字体不渲染），看起来像没有标。

v1 处理：**不做特殊处理**。如果 code 内部有改动，整段代码块在 word diff 中通常会被拆成"删除整段旧 + 插入整段新"，外层 marker 落在 code 块前后的换行附近，wrap 后包成两段（旧 fence 段被 DEL，新 fence 段被 INS），用户能识别出是代码块换了。

后续若用户反馈强烈，可以增加：在 `buildMergedMarkdown` 之前，先用 fenced-code-aware 切分，把每个 fence 当原子单元参与 line diff，code 内部不参与 word diff。

## 失败模式与降级

- **plugin 抛错**：`MarkdownDiffView` 用 try/catch 包裹 buildMergedMarkdown 的调用与 ReactMarkdown 的渲染；任一失败时 fallback 到一个简易 `<pre>{merged}</pre>` 单栏视图（保留 marker 字符不可见，至少不崩页）。
- **极大文档**：jsdiff word diff 是 `O(n·m)`。本 RFC 不另设阈值；review 文档体量与现有 word 模式持平，已被 RFC-005 接受。
- **未配对 marker**：插件 splitMarkers 容错丢弃。
- **input 末尾缺 trailing `\n`（line 模式）**：jsdiff `diffLines` 在这种情况下 emit 的最后一段 value 也没有 `\n`，buildMergedMarkdown 拼回 markdown 时相邻 removed + added 会糊在同一物理行——典型崩溃：heading 改字第二行的 `## ` 落进第一行 heading 的 text 里、列表项改字两 `<li>` 合成一个新行 INS 紧贴旧行 DEL。**对策**：`computeChanges` 在 line 路径调用 `diffLines` 前对 left / right 做 `ensureTrailingNewline` normalize（见同名函数），保证每条 change 的 value 都以 `\n` 结尾。

## 测试策略

文件 / 用例：

1. `tests/markdown-diff-build.test.ts` — `buildMergedMarkdown` 纯函数
   - identical → 无 marker
   - heading 改字（`# Old` → `# New`）→ marker 落在标题文本内
   - list item 改字
   - inline emphasis 改字（`**foo**` → `**bar**`）
   - 整段新增 / 整段删除（多行）
   - 行首 `#` / `-` / `>` 保留为前缀
   - CJK：`你好世界` vs `你好新世界` 仅 `新` 一个 ins 段
   - 安全：`<script>` 字面量被原样保留在输出中（react-markdown 阶段才转义）

2. `tests/markdown-diff-plugin.test.ts` — `remarkDiffMarkers`
   - 输入纯文本 `hi` 经 unified+remark-parse → 树中含 `diffMark` 节点
   - 嵌套 `**foo**`：marker 应落在 emphasis 的 text 子节点上
   - 未配对 open marker 不崩
   - data.hName / data.hProperties 正确

3. `tests/markdown-diff-view.test.tsx` — `MarkdownDiffView` 集成（react-testing-library + happy-dom）
   - **word**（默认 granularity）：段内改字 → ins/del span；heading 改字保留 `<h1>`；list item 改字保留 `<li>`；CJK 仅 1 个 ins；完全相同时无 ins/del；`<script>` 不渲染；容器带 `.markdown-diff-view`
   - **line**：单行改字 → ins/del；整行新增 → 整行包 ins；**裸 heading 替换（无 trailing `\n`）必须渲染 2 个独立 `<h2>`**；**裸 list item 替换（无 trailing `\n`）必须渲染 2 个独立 `<li>`**（见 §失败模式 trailing-newline 部分）
   - **block**：整段重写 → 旧段 del + 新段 ins；整段新增 → 整段 ins

4. `tests/diff-view.test.ts` — 全部重写：
   - 删除旧的 `_internal` helper 测试（`changesToSegments` / `headingSlug` / `slugify` / `splitForWordDiff` / `computeDiff` 路径已不存在）
   - 保留 / 新增源码层断言：`DiffView.tsx` 必须 import `MarkdownDiffView` 且对三种 granularity 都把 `granularity` 透传给 `MarkdownDiffView`，不得再含 `useEffect` / `useRef` / pane 渲染代码

## 样式

`packages/frontend/src/styles.css` 追加：

```css
.markdown-diff-view .diff-ins {
  background: #d4f8d4;
  color: #064a06;
  border-radius: 2px;
  padding: 0 2px;
}
.markdown-diff-view .diff-del {
  background: #fadbdb;
  color: #6a0a0a;
  text-decoration: line-through;
  border-radius: 2px;
  padding: 0 2px;
}

@media (prefers-color-scheme: dark) {
  .markdown-diff-view .diff-ins {
    background: #16401a;
    color: #aef0a8;
  }
  .markdown-diff-view .diff-del {
    background: #3a1414;
    color: #f4a4a4;
  }
}
```

仅在 `MarkdownDiffView` 容器内生效，避免 `.diff-` 类名被其他组件误中。

## 与 Prose 的代码复用

`Prose.tsx` 当前把 remark / rehype 配置内联在组件函数里。本 RFC **不抽公共配置**——避免引入跨组件的隐性耦合，且 `MarkdownDiffView` 不需要 PlantUML / 图片 zoom（它只渲染 doc_version body 文本，没有相对路径图片解析需求）。`MarkdownDiffView` 自己声明一份精简的 plugin 列表（gfm + alert + math + diffMarkers + 同款 rehype 链），略去 `taskId` / `plantumlEndpoint`。如未来发现需要保持完全同款，再做抽公共。
