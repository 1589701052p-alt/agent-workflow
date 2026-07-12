# RFC-161 任务画布反问节点点击直达反问页 — plan

单 RFC 单 PR；commit 前缀 `feat(shared,backend,frontend): RFC-161 …`。无 migration。姊妹镜像 RFC-158，
复用其已落地的 review 三件套模式 / canvasRef RefObject / navigate。

## 任务分解

- **RFC-161-T0 判据事实源 + 后端 stamp**（无依赖，shared+backend）
  - shared（`schemas/clarify.ts`，居 `ClarifyRoundStatus` 旁）：`ClarifyNodeNavKind` +
    `clarifyNavKindForRoundStatus(status)`（awaiting_human→'awaiting' / answered→'answered' /
    canceled·abandoned·undefined·null→null）。
  - shared（`schemas/task.ts`）：`NodeRunSchema.clarifyNavKind?: 'awaiting'|'answered'|null`（紧邻
    RFC-158 `reviewNavKind`，读时派生注释）。
  - backend `task.ts`：`getTaskNodeRuns` 在 dvRows 后加一次 clarify_rounds 载入（按 taskId，走
    `idx_clarify_rounds_task`）→ 构建「node_run id → createdAt-max 轮状态」映射（**与 `getClarifyRoundDetail`
    的 `desc(createdAt).limit(1)` 同选法**）；`runs.map` 内每行紧邻 `reviewNavKind` 加
    `clarifyNavKind = clarifyNavKindForRoundStatus(latestRoundByRun.get(r.id)?.status)`，**再据已载
    `task.status` 抑制孤儿 awaiting**（`canceled`/`failed` + 'awaiting' → null，设计门 Codex ②a），return 增字段。
    **`getClarifyRoundDetail` 及 clarify 写路径选轮不动**（选轮一致性划为非目标，设计门 Codex ⑥，§4.5/§3）。
  - 测试（design §6 组 1-4c）：映射矩阵 / NodeRunSchema 形状 / stamping（含 **canceled round→null**、
    **abandoned→null**、**无 round guard→null**、**幂等重放两轮（createdAt 相异）取最新→awaiting**、
    **canceled/failed 任务孤儿 awaiting→null 而 interrupted/answered 不 gate** 反例先红后绿）/
    stamp↔getClarifyRoundDetail 标签对拍（createdAt 相异）+ **不 404 属性**（stamp 非空 ⟹ getClarifyRoundDetail
    不抛 404）；不为同 createdAt 竞态构造选轮测试（§4.5 非目标）。
- **RFC-161-T1 前端推导纯函数**（依赖 T0 的 shared 字段）
  - 新 `packages/frontend/src/lib/clarify-node-nav.ts`：`deriveClarifyNodeNav`（**纯 freshest-run**——节点
    当前态 = ULID 最新 run，读它 stamp：awaiting→awaiting / answered→answered / 否则 null；镜像
    `deriveReviewNodeNav`，唯一差别是不按 parentNodeRunId 过滤；`ulidNewest` 复用/镜像 `review-node-nav.ts`。
    **不用 awaiting 优先**——设计门两轮证伪，见 §2.3）。
  - 测试组 5：freshest-run 矩阵 ≥14 case（含 **freshest awaiting 含同存更旧 answered→awaiting**、
    **freshest answered 含同存更旧 awaiting→answered**、**freshest null 遮蔽更旧 answered/stale-awaiting→null**
    〔Codex 两轮反例，注释链接 §2.3〕、多 awaiting/answered 取 freshest、带 parent 分片 run 参与、字段缺席
    严判、不串扰）。
- **RFC-161-T2 画布提示通道**（依赖 T1 的类型）
  - `CanvasNodeData.clarifyNav?: 'awaiting' | 'answered'`（`nodes/types.ts`）。
  - `WorkflowCanvas` 新可选 prop `clarifyNavs`：ref-guard + effect deps + `toFlowNodes` 增参
    （初始 useState + def-sync effect 两调用点，`__testToFlowNodes` 钩子同步扩参；两 kind 注入；
    仿 `reviewNavs` 模式，不传 = 字节不变）。
  - `ClarifyNode` + `CrossClarifyNode`：`data-clarify-nav` 属性 + 提示行（复用同组 i18n key）；
    `styles.css` 两 kind cursor + 提示行样式；i18n `clarifyNode.navAwaiting` / `navAnswered` 双语
    （zh 类型块+值块 / en 值块）。
  - 测试组 6、7：两渲染器三态（undefined = 编辑器 golden-lock）+ `__testToFlowNodes` 注入行为
    （两 kind 染色、非反问不染）+ CSS / i18n 锁。
- **RFC-161-T3 任务详情接线 + WS 刷新配套**（依赖 T1、T2）
  - `TaskStatusCanvas`：`clarifyNodeIds` / `clarifyNavByNode` / `clarifyNavs` memo（紧邻 review 三件套）+
    `onSelect` clarify 分支（clearSelection → onSelectNodeRun(null) → 条件 navigate `/clarify/$nodeRunId`，
    无 search）；复用 RFC-158 已就位的 `useNavigate` / `canvasRef: RefObject`。
  - `hooks/useTaskSync.ts`：补 `cross-clarify.created`/`answered`/`rejected` 三规则 invalidate
    `['tasks',taskId,'node-runs']`(+clarifyKeys)，`answered`/`rejected` **保留**既有 directives（§4.6，
    cross↔self 同等待遇；设计门 Codex ③①）。
  - `routes/clarify.ts`：defer 分支 `sealResult.roundFullySealed` 时补 emit intermediary run 的
    `node.status(done)`（§4.7 best-effort，全客户端经现有 node.status 规则刷 node-runs；仅全量封存发）+
    `components/clarify/CentralizedAnswerDialog.tsx` 成功 handler 追加 node-runs 本地失效（设计门 Codex ④②）。
  - 测试组 8、9、10 + 4c：接线源码锁 + useTaskSync 三 cross 事件 node-runs invalidation（含保留 directives）+
    集中面板本地 node-runs 失效 + backend defer 全量封存发 node.status（self/cross；部分封存不发）。
- **RFC-161-T4 门禁与验证**（依赖 T0-T3）
  - 全量 rg 复核锁面：`TaskStatusCanvas|onSelectNodeRun|latestRunByNode|canvas-node--clarify|ClarifyNode|CrossClarifyNode|clarifyNav|clarifyNavKind|shouldShowClarifyJump|getClarifyRoundDetail|NodeRunSchema`
    扫 `packages/*/tests` + `e2e/`，逐命中确认绿或已迁移（尤其 NodeRunSchema 全字段锁增列、
    ClarifyNode/CrossClarifyNode 既有渲染锁走 undefined 分支保绿、`shouldShowClarifyJump` 锁零改动）。
  - `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿后 push，随即查
    GitHub Actions 结论（`gh run list/view` conclusion 为准，feedback_post_commit_ci_check）。
  - 设计门 + 实现门 Codex review，findings 各修完再进/交付（feedback_codex_review_after_changes）。
  - 视觉基线：无需刷新（8 页快照不含任务详情画布；编辑器画布 golden-lock）。

## 验收清单（对照 proposal §5）

- [ ] 反问节点点击永不开 drawer（drawer 已开时点击 → 关闭且不重开）
- [ ] `clarifyNavKind='awaiting'` → 跳 `/clarify/{awaiting run}`（可交互）
- [ ] `clarifyNavKind='answered'` → 跳该节点最新 answered run（只读回显）
- [ ] `clarifyNavKind=null` → 点击零动作（无 round guard / canceled / abandoned / pending / 字段缺席 / 无 run）
- [ ] 无空视图无 404（stamp 与 getClarifyRoundDetail 同源，取最新轮）
- [ ] 纯 freshest-run：节点当前态=ULID 最新 run，更新的 null/guard run 恒遮蔽更旧 answered/stale-awaiting（Codex 两轮反例）
- [ ] canceled/failed 任务孤儿 awaiting 经后端 gate 判 null（interrupted/answered 不 gate）
- [ ] 分片自反问落 freshest run；待答分片经 shard switcher / 表格「去回答」可达（文档化 v1）
- [ ] 可点击时提示行 + pointer（clarify 与 cross-clarify 两渲染器都有）；不可点击时两者皆无
- [ ] 点击后选中态即时释放，同节点连续点击每次生效（wedge 防护）
- [ ] 编辑器画布字节零变化；非反问节点行为零变化；表格「去回答」按钮 + `/clarify` 列表行为零变化
- [ ] 新测试八组全绿 + 既有锁按盘点迁移 + 四门禁全绿 + CI conclusion success
