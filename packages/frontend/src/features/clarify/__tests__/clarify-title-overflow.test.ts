/**
 * 回归防护：反问「问题列表」（components/clarify/QuestionForm.tsx）问题标题「出框」修复。
 *
 * 背景：RFC 系列把反问表单重构为 QuestionForm，问题标题仍用 .clarify-question__title
 * （重构后样式仅剩 flex:1; min-width:0）。该类一度没有任何换行处理，长无空格串
 * （如 move/setDirection/getHead/getBody/isGrowing）会溢出反问卡片框——而同卡片的
 * .clarify-option__label / .clarify-option__description 早已带 word-break:break-word。
 *
 * 修复：给 .clarify-question__title 补 overflow-wrap:anywhere + word-break:break-word，
 * 与同级选项标签风格一致。
 *
 * CSS 布局无法在 jsdom 断言（vitest css:false、jsdom 不做布局），故以源码层文本断言兜底
 * 锁定这条规则——被改回去本测试即转红。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 用 __dirname + resolve（仓库其它 source-guard 测试的惯例）——不要用 fileURLToPath(new
// URL(..., import.meta.url))，它在 vitest 下抛 The URL must be of scheme file（→ 0 tests）。
const css = readFileSync(resolve(__dirname, '..', '..', '..', 'styles.css'), 'utf8')

describe('clarify question title overflow guard', () => {
  it('wraps long content in .clarify-question__title so it does not overflow the card', () => {
    const idx = css.indexOf('.clarify-question__title {')
    expect(idx).toBeGreaterThan(-1)
    const body = css.slice(idx, css.indexOf('}', idx))
    expect(body).toMatch(/overflow-wrap\s*:\s*anywhere/)
    expect(body).toMatch(/word-break\s*:\s*break-word/)
  })
})
