// RFC-142 — 决策信息块（ReviewDecisionInfo）回归锁。
//
// 锁定 design D1 的展示规则：
//   - rejected：决策 chip + 决策人 + 时间 + 「退回原因」全文；原因缺失显示占位。
//   - superseded：决策人为系统（不渲染 AttributionChip）+ 'upstream-refreshed'
//     映射为系统作废说明文案。
//   - iterated：显示决策人/时间，但**不**重复展示 decisionReason（它是渲染态
//     评论块，与冻结评论重复）。
//   - pending / 无决策：整块不渲染。
// 另加源代码层兜底断言：reviews.detail.tsx 双视图（当前 + 历史）都接入本组件，
// 且不再整体隐藏 system 决策行（RFC-099 旧行为）。

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ReviewDecisionInfo } from '../src/components/review/ReviewDecisionInfo'
import i18n from '../src/i18n'

describe('ReviewDecisionInfo', () => {
  test('rejected：chip + 决策人 + 时间 + 退回原因全文', async () => {
    await i18n.changeLanguage('en-US')
    render(
      <ReviewDecisionInfo
        decision="rejected"
        decisionReason={'missing error handling\nsee section 3'}
        decidedAt={1751000000000}
        decidedBy="u-alice"
        decidedByRole="owner"
        user={{
          id: 'u-alice',
          username: 'alice',
          displayName: 'Alice',
          role: 'user',
          status: 'active',
        }}
      />,
    )
    expect(screen.getByTestId('review-decision-info')).toBeTruthy()
    expect(screen.getByText('rejected')).toBeTruthy()
    expect(screen.getByText('Alice')).toBeTruthy()
    const reason = screen.getByTestId('review-decision-reason')
    expect(reason.textContent).toContain('Rejection reason')
    expect(reason.textContent).toContain('missing error handling')
    expect(reason.textContent).toContain('see section 3')
    expect(screen.getByText(/Decided at/)).toBeTruthy()
  })

  test('rejected 原因缺失 → 占位「未记录」', async () => {
    await i18n.changeLanguage('en-US')
    render(<ReviewDecisionInfo decision="rejected" decisionReason={null} decidedBy="u-1" />)
    expect(screen.getByTestId('review-decision-reason').textContent).toContain('(not recorded)')
  })

  test("superseded：'upstream-refreshed' 映射系统作废文案，决策人显示「系统」", async () => {
    await i18n.changeLanguage('en-US')
    render(
      <ReviewDecisionInfo
        decision="superseded"
        decisionReason="upstream-refreshed"
        decidedAt={1751000000000}
        decidedBy="system"
      />,
    )
    expect(screen.getByText('superseded')).toBeTruthy()
    expect(screen.getByText('System')).toBeTruthy()
    expect(screen.getByTestId('review-decision-reason').textContent).toContain(
      'Upstream output refreshed',
    )
  })

  test('iterated：显示决策人/时间，但不重复展示 decisionReason', async () => {
    await i18n.changeLanguage('en-US')
    render(
      <ReviewDecisionInfo
        decision="iterated"
        decisionReason={'### Comment 1\n**Comment**: tighten this'}
        decidedAt={1751000000000}
        decidedBy="u-carol"
        decidedByRole="user"
        user={{
          id: 'u-carol',
          username: 'carol',
          displayName: 'Carol',
          role: 'user',
          status: 'active',
        }}
      />,
    )
    expect(screen.getByText('iterated')).toBeTruthy()
    expect(screen.getByText('Carol')).toBeTruthy()
    expect(screen.queryByTestId('review-decision-reason')).toBeNull()
    expect(screen.queryByText(/tighten this/)).toBeNull()
  })

  test('pending / 无决策 → 不渲染', () => {
    const { container: c1 } = render(
      <ReviewDecisionInfo decision="pending" decidedBy="u-1" decisionReason="x" />,
    )
    expect(c1.querySelector('[data-testid="review-decision-info"]')).toBeNull()
    const { container: c2 } = render(<ReviewDecisionInfo decision={undefined} />)
    expect(c2.querySelector('[data-testid="review-decision-info"]')).toBeNull()
  })
})

describe('reviews.detail 接入（源代码层兜底）', () => {
  test('单文档详情双视图走 ReviewDecisionInfo；system 行不再整体隐藏', () => {
    const src = readFileSync(resolve(__dirname, '../src/routes/reviews.detail.tsx'), 'utf-8')
    expect(src).toContain("from '@/components/review/ReviewDecisionInfo'")
    expect(src).toContain('<ReviewDecisionInfo')
    // 历史只读视图的数据源接入（RFC-149：decisionReason / decidedAt 等逐字段
    // 三元收敛进 pickViewedVersion，历史 payload 仍是双视图切换的数据源）。
    expect(src).toMatch(/pickViewedVersion\(view,\s*historicalDetail\.data,/)
    expect(src).toContain('decisionReason={viewed.decisionReason}')
    expect(src).toContain('decidedAt={viewed.decidedAt}')
    // RFC-099 旧行为回归锁：不得再以「决策人是 system」为条件整体隐藏决策行
    //（RFC-149 后哨兵判定统一走 shared 的 isSystemDecision，本路由不得出现
    // 任何 'system' 字面量比较）。
    expect(src).not.toMatch(/[!=]==\s*'system'/)
  })

  test("组件内 system 行判定走 shared isSystemDecision（不再手写 === 'system'）", () => {
    const src = readFileSync(
      resolve(__dirname, '../src/components/review/ReviewDecisionInfo.tsx'),
      'utf-8',
    )
    // RFC-149（design §4）：哨兵拼写的单一事实源在 shared/schemas/review.ts。
    expect(src).toMatch(/isSystemDecision\(props\.decidedBy\)/)
    expect(src).not.toMatch(/[!=]==\s*'system'/)
  })
})
