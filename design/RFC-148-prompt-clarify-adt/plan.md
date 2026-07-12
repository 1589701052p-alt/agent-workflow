# RFC-148 · prompt/clarify 协议 ADT + RFC-132 收尾（plan）

> 3 commit；每步 golden 表护航。授权语境：G3-G10 批量授权，设计门后直接实现。

## 任务分解

### RFC-148-T1 golden 矩阵 + 防回潮断言（先钉，零行为变更）

- `rfc148-prompt-golden-matrix.test.ts`：renderUserPrompt 活组合 ≈16 行字节锁 +
  renderEnvelopeFollowupPrompt reason 6 值格；零生产者防回潮断言
  （crossClarifyContext 构造 / 4 死函数调用 / questionsBlock·answersBlock 生产赋值）。
- **commit PR-1**：`test(prompt): RFC-148 PR-1 golden 矩阵先钉 + 零生产者防回潮断言`

### RFC-148-T2 RFC-132 收尾删除

- design §3 接线表全执行：prompt.ts 死段/死字段/5 恒空 token、clarify.ts 5 死函数、
  runner 死管道；测试删 2 / 重写 2 / 拆分 2 / 大删 4 / 适配 1。
- 判据：golden 矩阵零改动全绿 + 纯行为锁群零改动全绿。
- **commit PR-2**：`refactor(prompt): RFC-148 PR-2 RFC-132 收尾——三代叠置注入路径死族全删`

### RFC-148-T3 promptMode + clarifyChannel 判别联合

- shared 两 ADT + RunNodeOptions 8 散装字段收敛（4+4）；runner 5 守卫改判别、
  `?? 'envelope-missing'` 删除、reason union 第三份删除；scheduler 组装点改产对象；
  renderUserPrompt 入参改 channel；PromptPreview 机械适配。
- 新单测：非法组合编译期不可表示 + 判别行为格；golden 矩阵单点更新签名。
- **commit PR-3**：`refactor(runner): RFC-148 PR-3 promptMode+clarifyChannel 判别联合——8 散装字段收敛`

## 门禁节奏

每 commit：typecheck×3 + lint + format + 定向套件（golden 矩阵 + clarify/prompt 群）；
PR-3 后全量（backend+frontend）+ binary smoke（shared 导出面变更）→ push → CI
conclusion 直查 → Codex 实现门循环至收敛。

## 验收清单

- [ ] golden 矩阵先行且全程绿（T2/T3 字节零变化机器证明）
- [ ] design §1.1 死族清单全删 + 防回潮断言生效
- [ ] promptMode/clarifyChannel 落地：非法组合不可表示、兜底与第三份 union 消灭
- [ ] 测试处置按盘点清单（删 2/重写 2/拆分 2/大删 4/适配 1）；纯行为锁群零改动
- [ ] 门禁 + CI + Codex 双门
