// DiffView source-level lock — RFC-010.
//
// RFC-010 把三种 granularity（word / line / block）全部 delegate 到
// MarkdownDiffView，并删掉了原来的左右源码 pane + 滚动同步 + 一系列
// _internal helper。这套断言锁定那次重构：
//   - 不允许 DiffView 重新出现 useEffect / useRef / pane 渲染（一旦有人
//     "回退"到旧的源码红绿块实现，本测试立刻红）
//   - 必须把 granularity 透传给 MarkdownDiffView（不能硬编码某种 mode）
//   - import 链必须保留 MarkdownDiffView
//
// 历史：旧版本（RFC-005 PR-E T34）测试的是 _internal 辅助函数
// （changesToSegments / headingSlug / slugify / computeDiff），那些函数
// 在 RFC-010 中已删除，对应测试也一并删除。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/components/review/DiffView.tsx'),
  'utf8',
)

describe('RFC-010 — DiffView 是 MarkdownDiffView 的薄壳', () => {
  test('imports MarkdownDiffView', () => {
    expect(source).toMatch(
      /import\s+\{\s*MarkdownDiffView\s*\}\s+from\s+['"]\.\/MarkdownDiffView['"]/,
    )
  })

  test('granularity 必须透传给 MarkdownDiffView（不能硬编码）', () => {
    expect(source).toMatch(/<MarkdownDiffView[^/>]*granularity=\{granularity\}/)
  })

  test('left / right 直接转发给 MarkdownDiffView', () => {
    expect(source).toMatch(/<MarkdownDiffView[^/>]*left=\{left\}/)
    expect(source).toMatch(/<MarkdownDiffView[^/>]*right=\{right\}/)
  })

  test('外层 wrapper 带 data-granularity，便于样式 / 调试探针', () => {
    expect(source).toMatch(/data-granularity=\{granularity\}/)
  })

  test('不再含 useEffect / useRef / 旧 pane 渲染（防止回退到 side-by-side 源码）', () => {
    expect(source).not.toMatch(/useEffect|useRef/)
    expect(source).not.toMatch(/diff-view__pane|renderPane|changesToSegments|headingSlug/)
  })

  test('公开类型 DiffGranularity 仍导出（reviews.detail 依赖）', () => {
    expect(source).toMatch(/export type DiffGranularity/)
  })
})
