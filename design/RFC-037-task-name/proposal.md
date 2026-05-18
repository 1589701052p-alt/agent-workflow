# RFC-037 — 任务名称（task.name）：启动时必填，列表 / 详情 / 收件箱 / clarify / review 全链路呈现

| 字段     | 值                                                                                                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编号     | RFC-037                                                                                                                                                                                                                                                                                                                           |
| 状态     | Draft                                                                                                                                                                                                                                                                                                                             |
| 作者     | binquanwang                                                                                                                                                                                                                                                                                                                       |
| 提交日期 | 2026-05-18                                                                                                                                                                                                                                                                                                                        |
| 关联     | [RFC-005 human review](../RFC-005-human-review/proposal.md), [RFC-023 clarify](../RFC-023-agent-clarify/proposal.md), [RFC-024 launch from git URL](../RFC-024-launch-from-git-url/proposal.md), [RFC-032 nav redesign](../RFC-032-nav-redesign/proposal.md), [RFC-036 multi-user collab](../RFC-036-multi-user-collaboration/proposal.md) |

## 1. 背景

当前 `tasks` 表里没有 "任务名称" 字段，所有 task 在列表 / 详情 / 收件箱里都只能靠以下几种标识区分：

- `id` — 26 字符 ULID，列表里只展示 `slice(-10)`（`packages/frontend/src/routes/tasks.tsx:104`）。用户视角是一串无意义随机字符。
- `workflowName` — 同一个 workflow 多次启动得到的任务全部重名，无法区分。
- `repoPath` — 同一仓库 + 同一 workflow 的多次任务还是重名。
- `startedAt` — 仅时间，无业务语义。

实际工作流里用户经常一天里给同一 workflow 起 5–20 个 task（例如 "code-review" workflow 跑不同 PR / 不同分支 / 不同 commit），靠"启动时间最近的是 a1b2c3d4ef"完全没法记住。RFC-036 引入多用户协作之后，inbox / clarify / review 列表混入了别人发的 task，"我刚才发的修分页 bug 的那个 task 在哪一行" 这种场景靠 short id 翻找不可行。

需要给每个 task 一个**用户可读的名称**字段，启动时必填，所有承载 task 主标识的列表 / 详情 / 跨页面摘要里都用它替代或补充 short id。

## 2. 目标

1. **schema 加 name**：`tasks` 表新增 `name TEXT NOT NULL` 列；shared `TaskSchema` / `TaskSummarySchema` 同步加 `name: string` 字段（必填、非 nullable）。
2. **启动时必填**：`POST /api/tasks` 的 `StartTaskSchema` 要求 `name: string`，后端 `trim` 后长度 ≥ 1 且 ≤ 255；缺失 / 纯空白返 422，错误码 `validation`。multipart 上传分支同样校验。
3. **launcher 表单**：`/workflows/$id/launch` 表单顶部新增"任务名称"输入框，必填校验；前端把 name 串进 `buildLaunchBody` / `buildLaunchFormDataV2` / `buildLaunchFormData` 三条提交路径。
4. **tasks 列表 Linear 风**：`/tasks` 表格首列改为 `Name`、ID 折叠成 name 单元格内的副标题（`<code>` 短串 + tooltip 全 ID + copy）；Workflow / Status / Started / Repo / Error 列顺序不变。
5. **task detail H1**：`/tasks/$id` 页面 H1 渲染 `task.name`，下方一行副标题显示完整 ID + status chip + 现有元信息。
6. **inbox / clarify / review 全链路**：
   - 后端 `ClarifySessionSummarySchema` / `ReviewSummarySchema` 各新增 `taskName: string` 字段（必填，从 join 出来的 `tasks.name` 透传；老兼容详见 §5 回填）；
   - 前端 `homepage.ts mergeInboxItems` / `InboxDrawer.tsx` clarify+review 两类行 + `/clarify` 列表 + `/clarify/$id` 详情 + `/reviews` 列表 + `/reviews/$id` 详情都显示 `taskName`。
7. **老数据回填**：migration 把已有 `tasks` 行的 `name` 回填为对应 `workflows.name`（缺失 join 则填空串后再 `UPDATE tasks SET name = 'task-' || substr(id, -10) WHERE name = ''` 兜底，保证 NOT NULL 落得下）。
8. **重名允许**：不加 unique / 不加复合 unique。任务名只做显示标识。
9. **API fallback 不开**：脚本 / CLI / `RemoteTrigger` 调 `POST /api/tasks` 不传 name → 统一 422，不做服务端自动生成。版本升级前的脚本必须先接入新字段。
10. **测试与现状对齐**：新增 backend / shared / frontend 测试覆盖（详见 design.md §6）；同时把所有现存 `mutate({ workflowId, repoPath, ... })`、`POST /api/tasks` body fixture 补上 name 字段，确保套件零退化。

## 3. 非目标

- **不**新增按 name 的搜索 / 过滤 / 排序（tasks 页 status filter 不动；homepage / inbox 也不改）。未来如做"任务搜索"另起 RFC。
- **不**做 name 的 unique 约束 / 同 workflow 下重名校验 / 跨 workflow 全局唯一。
- **不**在 workflow 定义里加默认 task name 模板（YAML / workflow editor 零改动）。
- **不**支持 name 国际化 / 多语言变体（一个字符串字段，用户写什么就存什么）。
- **不**做 emoji / markdown / 链接渲染（一律按 plain text 渲染，前端 `escapeHtml` 兜底）。
- **不**改 `tasks.id`（ULID 仍是真主键 / API 主标识 / WS 通道 key）。
- **不**对已有 daemon token 路径或 RFC-036 多用户路径的鉴权 / 可见性逻辑做任何修改。
- **不**新增 audit 字段（`name_updated_by` / `name_updated_at` 不要）；name 一旦写入不允许后续 PATCH 修改（v1 简化，未来再说）。
- **不**改 export task / backup / restore（已有路径靠 `tasks` 列原样序列化，新列自动随附；本 RFC 仅声明兼容）。

## 4. 用户故事

### US-1 — 开发者批量启动同 workflow

> Bob 一天里给 `code-review` workflow 启动了 8 个 task，分别 review 不同 PR。他在 `/workflows/code-review/launch` 每次都先填"任务名称"如 `PR-1234 分页 bug 修复`、`PR-1235 i18n 漏字` 等再点 Start。到 `/tasks` 列表，每一行最左侧是任务名，他一眼能看清哪一行是哪个 PR；点进去 detail 页 H1 就是任务名，浏览器 tab title 也是 `agent-workflow · PR-1234 分页 bug 修复`。

### US-2 — 多人协作 inbox

> Alice 是 reviewer。她在 inbox drawer 看到 7 条待评审：之前每行只看到 review 节点名 + workflow 名 + 时间，相同模板的不同 task 完全看不出区别。现在每行多出一个任务名 chip（`Bob · PR-1234 分页 bug 修复 · review:final`），她直接知道该评哪个。

### US-3 — 必填强制

> Carol 在 launcher 没填任务名就点了 Start，按钮在静态校验阶段已经被 disable；她还是用 curl 直接打 `POST /api/tasks` 跳过前端，后端返 422 `{ code: 'validation', message: 'name is required (1..255 chars after trim)' }`，Carol 在脚本里补上 name 重试 OK。

### US-4 — 老仓库升级 zero-touch

> Dave 装新版本后启动 daemon，migration 自动跑：所有他历史 task 的 name 字段被回填为 workflow 名（例如 80 条 `code-review` task 全部 name='code-review'）。他打开 `/tasks` 仍然能看到老 task，每行 name 显示 `code-review`、id 副标题保持唯一。他不需要做任何手动操作；新发的 task 才被强制要求填名字。

## 5. 验收

- **AC-1**：DB migration `0021_rfc037_task_name.sql` 跑完后 `tasks.name` 列存在 + NOT NULL；老 task 的 name 不为空。
- **AC-2**：`POST /api/tasks` 不传 name / 传空串 / 传纯空格 → 422；正常传 → 201 返新 task 行含 name。
- **AC-3**：`POST /api/tasks` body 内 `"  hello  "` → DB 存 `"hello"`（trim）。
- **AC-4**：`POST /api/tasks` body 内长度 > 255 → 422。
- **AC-5**：`GET /api/tasks` / `GET /api/tasks/:id` 响应 schema 含 `name: string`。
- **AC-6**：`GET /api/clarify` / `GET /api/reviews` 列表响应每行含 `taskName: string`，值与 join `tasks.name` 一致。
- **AC-7**：`/workflows/$id/launch` 表单顶部有"任务名称"输入框；不填 / 纯空白 → Start 按钮 disabled。
- **AC-8**：`/tasks` 表格首列是 Name，ID 在同单元格内做副标题；旧列顺序 Workflow / Status / Started / Repo / Error 保留。
- **AC-9**：`/tasks/$id` H1 渲染 `task.name`，ID 在副标题。
- **AC-10**：inbox drawer + `/clarify` + `/clarify/$id` + `/reviews` + `/reviews/$id` 都显示 `taskName`。
- **AC-11**：i18n 中英对称新增 keys 全部落齐；新 keys 在 zh-CN `Resources` 接口里同步声明。
- **AC-12**：本地 `bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions HEAD CI 六 jobs 全绿。
- **AC-13**：所有现存测试零退化（既有 backend / frontend / shared / e2e 套件全部跑通），新增测试 ≥ 35 条（详见 design.md §6 分布）。
- **AC-14**：multi-person working tree 安全 —— 不删 / 不改他人 untracked 文件，commit 仅按路径精确 `git add` 自己的改动。

## 6. 风险

1. **老脚本 / CLI 调 POST 缺 name 会立刻 422**。缓解：在 STATE.md 升级提示 + plan.md PR Acceptance 里写明 "本 PR 是 breaking change for 自动化脚本"；release note 强调；不做 fallback 是用户已确认的产品决策。
2. **migration 回填策略**：tasks 行删 workflow 后 `workflowName` join 已经是 null（schema 上 `workflowName: z.string().nullable()`）。回填 SQL 必须有 fallback `'task-' || substr(id, -10)`，否则 NOT NULL 约束会拒绝 ALTER。已在 design.md §2 钉死 SQL 形态。
3. **inbox / clarify / review 全链路 schema 改动**：`ClarifySessionSummarySchema` 与 `ReviewSummarySchema` 加必填 `taskName` 会让现存 fixture 全红。缓解：所有 fixture 一次性补；schema 加 `taskName: z.string()` 必填（不做 nullable）—— 强制对齐，避免半就绪状态。
4. **inbox WS 推送格式变化**：现有 `clarify.*` / `review.*` WS payload 形态会多一字段。前端 `useClarifyWs` / `useReviewsSync` 解析层用 zod parse → 兼容追加字段。后端按 RFC-036 的多用户 inbox 闭包推送 `taskName`。
5. **列表布局重排可能撞 e2e**：`/tasks` Linear 风改动会移列；e2e/main.spec.ts 现在已经用 role + accessible name 选择器，但需要审查 `tasks-list-id-status-nowrap.test.ts` / `task-status-i18n.test.ts` / `tasks-workflow-name.test.ts` 等既有断言；如有列下标硬编码就转成 role/aria 选择器。
6. **detail 页 H1 改动可能撞既有 a11y / e2e**：`task-detail-page-tabs.test.ts` / `task-detail-repo-url.test.ts` 等不查 H1 文本即可保留；改动文本断言的测试需要同步更新。
7. **YAML 工作流定义 不需要改**：本 RFC 字段是 task-level（per-launch），不在 workflow definition 上，YAML import/export / workflow.validator.ts 零改动。已在 §3 非目标钉死。
8. **重名允许产生 UI 混淆**：可接受 —— 重名时 detail 链接还是用 ID 精确路由；同行 ID 副标题作 disambiguator。

## 7. 备选方案

- **方案 A（已选）**：必填 name + 强制 422，前后端一刀切。
- **方案 B（被否）**：可选 name + 服务端 fallback `{workflowName}-{shortId}`。优点：脚本零迁移；缺点：UI 一半 task 是占位名，用户体验未改善。
- **方案 C（被否）**：把 name 字段加到 workflow definition（YAML），launcher 渲染默认值。缺点：workflow 是模板、name 是 instance 标识，语义不对位；YAML schema bump + migration 成本大。
- **方案 D（被否）**：Linear 风列表 + 隐藏 ID 列。缺点：调试 / 跨端复制 / e2e 仍需 short id 可见。已在用户问答阶段定为 Linear-style 但保留 ID 作副标题。
- **方案 E（被否）**：name 改成可后置 PATCH（detail 页"重命名"按钮）。v1 不做，简化权限决策（谁能改名 / 是否同步 WS / audit log），未来按需另立 RFC。
