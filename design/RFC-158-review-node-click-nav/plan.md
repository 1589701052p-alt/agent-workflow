# RFC-158 任务画布评审节点点击直达评审页 — plan

单 RFC 单 PR；commit 前缀 `feat(shared,backend,frontend): RFC-158 …`。无 migration。

## 任务分解

- **RFC-158-T0 判据事实源 + 详情直建**（无依赖，shared+backend）
  - shared（`schemas/review.ts`，居 `isSystemDecider` 旁）：
    - `selectCurrentReviewRound(rows)` —— 泛型选择器，返回 `{representative, members}`（single
      最高 versionIndex 含 superseded / multi pending-优先-否则最新轮成员集，镜像
      getReviewDetail:1143-1177）；透传行身份供 getReviewDetail 渲染。
    - `isHumanReviewConclusion(representative)` —— `decision∈{approved,rejected,iterated} ∧ !isSystemDecider(decidedBy)`。
  - shared（`schemas/task.ts`）：`NodeRunSchema.reviewNavKind?: 'awaiting'|'decided'|null`
    （紧邻 RFC-078 双字段，读时派生注释）。
  - backend `review.ts`：`getReviewDetail` 的 single/multi current 选择重构为调
    `selectCurrentReviewRound`（消 fork，行为保持）；摘要按 nodeRunId 直建——从
    `listReviewSummaries` 循环体抽纯拼装 helper，list/detail 共用（修全局 limit-500 截断 404）；
    单文档 body 读取包 try/catch→`body=''`（镜像多文档，令「有版本⟹可渲染」成立、修 body-missing 404）。
  - backend `task.ts`：`getTaskNodeRuns` dv 投影 +4 列 `decidedBy`/`itemIndex`/`roundGeneration`/`reviewIteration`（每-doc，非 node_run），
    每行算 `reviewNavKind`：`round=selectCurrentReviewRound(rows)`；`round&&status==='awaiting_review'`
    →'awaiting'；`round&&isHumanReviewConclusion(round.representative)`→'decided'；否则 null
    （`round===null` 的空 list review 零版本行自然落 null，杜绝跳 404）。
  - 测试（design §6 组 1-5b，回归 case 先红后绿）：选择器矩阵 / 人工判据矩阵 /
    stamping 八形态（含 **空 list review→null** 与 **re-park-supersede→null** 反例）/
    detail↔选择器同源对拍 / 501 条截断回归 + list-detail 拼装对拍 / 单文档 body-missing→`body=''`。
- **RFC-158-T1 三态推导纯函数**（依赖 T0 的 shared 字段）
  - 新 `packages/frontend/src/lib/review-node-nav.ts`：`deriveReviewNodeNav`
    （纯 ULID 编排 over `reviewNavKind`：'awaiting' 优先 → 'decided' 取 ULID 最新 → null；top-level only）。
  - 测试组 6：矩阵 ≥12 case（含 **'awaiting' 优先**、多 'decided' 取 ULID 最新、
    字段缺席严判、子行忽略、不串扰）。
- **RFC-158-T2 画布提示通道**（依赖 T1 的类型）
  - `CanvasNodeData.reviewNav?: 'awaiting' | 'decided'`（`nodes/types.ts`）。
  - `WorkflowCanvas` 新可选 prop `reviewNavs`：ref-guard + effect deps + `toFlowNodes` 增参
    （初始 useState + def-sync effect 两调用点，`__testToFlowNodes` 钩子同步扩参；
    仿 `questionCounts` 模式，不传 = 字节不变）。
  - `ReviewNode`：`data-review-nav` 属性 + 提示行；`styles.css` cursor + 提示行样式；
    i18n `reviewNode.navAwaiting` / `navDecided` 双语。
  - 测试组 7、9：ReviewNode 渲染三态（undefined = 编辑器 golden-lock）+ `__testToFlowNodes`
    注入行为 + CSS / i18n 锁。
- **RFC-158-T3 任务详情接线**（依赖 T1、T2）
  - `TaskStatusCanvas`：`useNavigate` + `reviewNodeIds` / `reviewNavByNode` / `reviewNavs` memo +
    `onSelect` review 分支（clearSelection → onSelectNodeRun(null) → 条件 navigate）+
    `canvasRef` prop 类型 `React.Ref` → `React.RefObject<WorkflowCanvasHandle | null>`。
  - 测试组 8：接线源码锁（分支先于 drawer 映射 / clearSelection 先于 navigate /
    目标路由 + `search:{}` / drawer 永不为 review 打开）。
  - 既有锁锚点更新：`tasks-detail-drawer-close-reclick.test.ts` 的 canvasRef 类型 regex 一条；
    node-runs 响应 / NodeRunSchema 全字段锁如有随增列更新；review-summary 既有测试对拍保绿。
- **RFC-158-T4 门禁与验证**（依赖 T0-T3）
  - 全量 rg 复核锁面：`TaskStatusCanvas|onSelectNodeRun|latestRunByNode|canvas-node--review|ReviewNode|reviewNav|reviewNavKind|selectCurrentReviewRound|isHumanReviewConclusion|getReviewDetail|listReviewSummaries`
    扫 `packages/*/tests` + `e2e/`，逐命中确认绿或已迁移。
  - `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿后 push，
    随即查 GitHub Actions 结论（`gh run list/view` conclusion 为准）。
  - 实现门 Codex review，findings 修完再交付。
  - 视觉基线：无需刷新（8 页快照不含任务详情画布；编辑器画布 golden-lock）。

## 验收清单（对照 proposal §5）

- [ ] review 节点点击永不开 drawer（drawer 已开时点击 → 关闭且不重开）
- [ ] awaiting_review → 跳 `/reviews/{awaiting run}`
- [ ] `reviewNavKind='decided'` → 跳 ULID 最新此类行；打回重跑未开新轮窗口必须可点并回显该结论
- [ ] `reviewNavKind=null` → 点击零动作（cascade 系统代决 / re-park-supersede 空 pending / **空 list review 零版本** / 字段缺席 / 全部无人工当前轮 / 无 run）
- [ ] 无空 decided 视图（stamp 与 getReviewDetail 同源，恒渲染人工结论）
- [ ] 可点击时提示行 + pointer；不可点击时两者皆无
- [ ] 点击后选中态即时释放，同节点连续点击每次生效（wedge 防护）
- [ ] 老评审 500+ 截断回归先红后绿；`/reviews` 列表行为不变
- [ ] 编辑器画布字节零变化；非 review 节点行为零变化
- [ ] 新测试九组全绿 + 既有锁按盘点迁移 + 四门禁全绿 + CI conclusion success
