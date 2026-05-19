# RFC-049 — Port Content Validation → Same-Session Follow-up Repair（端口内容校验失败 → 同 session 追问修复，覆盖三种 kind × 反问通道矩阵）

Status: Draft
Author: WangBinquan
Created: 2026-05-19

## 背景

RFC-005 引入了 `agent.outputKinds: Record<port, 'string' | 'markdown' | 'markdown_file'>` 这一层；RFC-042 引入了"envelope 形态错 → 同 session 追问"恢复机制（envelope-missing / both-present / clarify-malformed 三类）；RFC-042 的 Planned follow-up 段还点了一条"followup 这一轮把 markdown_file 两步协议同步进 prompt"——但只覆盖 prompt 文案那一面，没真的让框架在**端口内容**校验失败时也走追问。

实际生产里看到的 fail 路径：

1. **markdown_file 路径不存在 / 越界 / 空路径**——`packages/backend/src/services/envelope.ts:204-241 resolvePortContent` 抛 `markdown-file-empty-path` / `markdown-file-escapes-worktree` / `markdown-file-read-failed` 三类 `ValidationError`。runner 把这种异常包成 `errorMessage` 落 `node_runs` 行（具体落点见 §design.md），scheduler 当作普通失败处理。
2. **markdown_file 路径存在但 envelope.ts 走的是 forgiveness path**——`tryReadInWorktreeMarkdownPath`（同文件 273-309 行）在 outputKinds 没声明 markdown_file 时尝试自动把单行 `.md` 路径解读成文件读取，失败时静默 fallback 回 raw 字符串；这条不是 fail，但是个"看起来跑通了、下游拿到的内容是路径字符串"的坑。
3. **envelope 形态合法但内容空 / 内容不匹配 kind 期望**——例如声明 `markdown_file` 但端口内容是多行 markdown 正文（agent 把 body 直接塞进去）；声明 `string` 但端口塞了完整 markdown 文档（不是错误但难下游用）。当前框架什么都不做。

这些路径**目前都不触发 RFC-042 的追问**，因为 RFC-042 识别集合只看 envelope 形态错的四个 prefix（`no <workflow-output>` / `clarify-and-output-both-present` / `clarify-questions-*`）。结果就是 markdown_file 路径不存在这种"模型答了但没落盘"的低级错误，要么直接红、要么靠 retries 全新 session 烧 token 重跑一整轮。

并且，用户在评审 RFC-042 时点出了两条新约束：

- **三种 kind 都要纳入**：不是只盯着 markdown_file，string / markdown 也要在这套框架里有明确的"今天不做校验"的契约，以及未来加 kind 时不用改 scheduler / runner 主干。
- **反问通道 on/off 必须是矩阵**：节点挂了 clarify channel 时，追问文案得继续遵守 RFC-039 的"默认偏向 clarify"偏向；没挂时走单 envelope 文案。"按 kind 修端口"指令必须能正交叠加在两种文案上。

本 RFC 把这两层纳入框架自身能力。

## 目标

- (G1) **三种 kind 的契约显式化 + 单点接管所有注入点**：每个 `AgentOutputKind` 由**一个 handler 模块**完整接管所有相关能力——(a) prompt 侧引导（首轮 user prompt 拼接）、(b) parse 侧校验（envelope 解析后、写入 `node_run_outputs` 之前）、(c) 校验失败时的**短追问文案**（追问要修哪个 port、按什么契约修）、(d) 该 kind 独占的失败码集合（subReason 命名空间）。今天三种 kind 的契约表如下：

  | kind            | prompt 引导                                              | parse 校验                                                                              | followup 文案要点                                                                                |
  | --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
  | `string`        | 无（裸 bullet）                                          | 无（passthrough）                                                                       | n/a — 不会触发校验失败                                                                           |
  | `markdown`      | 无（裸 bullet）                                          | 无（passthrough；非空只是 warning）                                                     | n/a — 不会触发校验失败                                                                           |
  | `markdown_file` | 两步协议短句 + `buildMarkdownFilePortGuidance`（已落地，PR-A 搬进 handler） | 五层（**本 RFC 把后两层从原先没有的状态加进来**）：① 路径非空；② 路径在 worktree 内；③ 文件存在可读；④ 后缀 ∈ {`.md`, `.markdown`}；⑤ 文件内容 trim 后非空 | 列出失败 port + 失败 sub-reason（5 种）+ 重申两步协议短句 + 提醒"必须落盘成 .md 且内容非空"   |

- (G2) **校验失败 → 同 session 追问恢复**：扩展 RFC-042 的 `decideEnvelopeFollowup` 识别集合，把 `port-validation-*` 系列错误也认成"可同 session 追问"的子类，**仅当**满足 RFC-042 既有的三条前置条件（exitCode === 0 + 有 opencodeSessionId + 有 agent text）时进入追问；否则降级全新 session。复用 RFC-042 已有的 `--session <id>` 透传 + `renderEnvelopeFollowupPrompt` 入口；新增 per-port-failure 文案段。
- (G3) **反问通道 × kind 矩阵**：追问文案在以下 6 个组合里都行为明确：

  | 行号  | hasClarifyChannel | failing kinds 含 markdown_file | 行为                                                                                                                                                  |
  | ----- | ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
  | M1    | off               | no                             | 文案 = RFC-042 当前的 envelope-missing 段（不可达——只有 markdown_file 会产生 port-validation 失败；string/markdown 不会）                              |
  | M2    | off               | yes                            | 文案 = "envelope 收到了但 port X 内容不合 markdown_file 契约：原因 = Y。请在同一 session 内执行两步协议：先落盘 file，再只发 worktree 相对路径"        |
  | M3    | on，directive=n/a | no                             | 同 M1，不可达                                                                                                                                         |
  | M4    | on，directive=n/a | yes                            | 文案 = M2 的 markdown_file 段 + 末尾追加 RFC-023/039 的 bi-modal 提醒（"本节点仍支持 clarify，本轮按 RFC-039 默认偏向，下一轮再来；但本轮必须把这一格端口修了"）        |
  | M5    | on，directive=continue | yes                        | 文案 = M4 + RFC-039 strong-bias 短句（"用户已点继续反问"）。markdown_file 段顺序固定排在 RFC-039 短句之前，避免 RFC-039 句被夹中间                       |
  | M6    | on，directive=stop | yes                            | 文案 = M4（stop 不追加 strong-bias，已对齐 RFC-042 §A2-A3）                                                                                            |

  顺序锚定（避免 refactor 串行错位）：`[bi-modal preamble] → [per-kind repair blocks（按 failures 出现顺序去重；每 kind 一段，handler 自己渲染本段全部文案，包括"两步协议"短句这种 kind-specific 提示）] → [RFC-039 strong-bias trailer]`。未来加 `code_file` 等新 kind 时，新 handler 的 `buildRepairBlock` 段会**自动**插在同一位置，主干渲染路径零改动。
- (G4) **`OutputKindHandler` 静态接口接管所有 kind 注入点（高扩展性 + 互不干扰）**：本 RFC 把"按 kind 派发"从今天的"散落多处的 switch + 自由组合的辅助函数"升级到**一个显式 handler 接口**，目录 `packages/backend/src/services/outputKinds/`，每个 kind 一个文件 export 一个 `OutputKindHandler` 对象，接口字段：
  - `kind: AgentOutputKind`
  - `subReasons: ReadonlySet<string>`——该 kind **独占**的失败码集合；模块加载期 `outputKinds/index.ts` 把所有 handler 的 subReasons 拍平，重名直接 `throw`，CI 红。
  - `buildPromptGuidance({ ports }) → string | null`——首轮 user prompt 注入；仅传入"声明为本 kind 的端口"，handler 看不见别人的端口。`null` = 跳过（string/markdown 走这条）。
  - `validate(rawContent, ctx) → ValidateResult`——envelope 解析后的 per-port 校验。
  - `buildRepairBlock({ failures, ports }) → string | null`——followup repair 文案段；仅传入"本 kind 端口的失败"，handler 看不见别人 kind 的失败。`null` = 跳过。

  主干代码（envelope.ts / scheduler.ts / runner.ts / shared prompt.ts）改成**只迭代 handler**：
  - `buildProtocolBlock(agent)` 遍历 agent 声明的 distinct kinds，调每个 handler 的 `buildPromptGuidance`，拼接非 null 段；
  - envelope `resolvePortContent` 按 kind 拿对应 handler 调 `validate`；失败 errorMessage 写 `port-validation-<kind>-<subReason>`（**升级到 kind 命名空间**，详见下节失败码表）；
  - scheduler 决策 / runner followup 渲染时按 failures 里的 kind 分组，分别调对应 handler 的 `buildRepairBlock`，拼成"每 kind 一段"的 repair block，段间空行隔开、顺序按"失败首次出现顺序去重"。

  **互不干扰的强制机制**：
  1. subReason 用 kind 命名空间 → 命名永不冲突；
  2. 模块加载期 assert subReasons 拍平唯一 → 构造期就拦住误命名；
  3. handler 每个方法接收的 ports/failures 都是"本 kind 子集"，看不见其他 kind 的输入 → 不可能误注入到别人的 prompt / repair 段。

  **不引入运行时 plugin loader / 动态注册 / 跨进程注册表 / 公共 `register()` API**——handlers 仍然是静态 import 到 `outputKinds/index.ts` 的 const 表；新增第 4 种 kind = 新增一个文件 + 在 index.ts 加一行 import + 加一行表项，主干代码零改动。"静态可扩展"是底线，"运行时可插拔"现在仍然显式拒绝。
- (G5) **既有 RFC-042 路径零退化**：envelope-structural failures（missing / both / clarify-malformed）的判定 + prompt 渲染 + 重试预算扣减完全不变；新增的 `port-validation-*` 是同决策函数（`decideEnvelopeFollowup`）的额外分支，互相不冲突。
- (G6) **新增一列 + 一次 migration**：在 `node_runs` 加 nullable JSON 列 `port_validation_failures_json` 存放 failures 列表（结构化 + 可索引 + 不污染 errorMessage 后半段），migration 0026。errorMessage 只保留 `port-validation-<kind>-<subReason>: <human-readable detail>` 人类可读前半段（kind 命名空间，见下节失败码表），scheduler 决定追问时从新列读 failures 数组（结构化 `{ port, kind, subReason, detail }`，scheduler 不依赖 errorMessage 后半段 string-parse 即可拿到 kind 字段路由到 handler）。**老行（pre-RFC-049 落库）该列恒 NULL**，与 RFC-046/047 NULL 三态对齐。

## 非目标

- 不为 `string` / `markdown` kind 引入任何**强制**校验（schema validate / 长度限制 / 关键词检查）。本 RFC 只把契约写在文档里：今天这两种 kind 的契约就是 "no validation"。
- 不改 `buildProtocolBlock` / `buildMarkdownFilePortGuidance`（首轮 prompt 已经写得够清楚）；本 RFC 只动 followup 那一面，加 per-kind repair 段。
- 不改 envelope 解析三件套（`detectEnvelopeKind` / `extractLastEnvelope` / `extractClarifyEnvelopeBody`）。
- 不改 RFC-042 默认 retries=3；本 RFC 共享同一份 retries 预算。
- 不引入"启发式抽取"——不试图从模型的非 envelope 文本里"猜"内容。
- **删除 forgiveness path（breaking change）**：`tryReadInWorktreeMarkdownPath`（envelope.ts:273）整段移除；agent 想让端口走"文件内容"，必须在 frontmatter 显式声明 `outputKinds: { port: markdown_file }`，否则 envelope 内容按字符串透传给下游。详见 §"生产扫描" + §R7。
- **不**引入运行时 plugin loader / 动态注册表 / 公共 `register(handler)` API / `package.json` 插件读取（见 G4）。OutputKindHandler 接口是**静态**的——handlers 在编译期 import 进 `outputKinds/index.ts` 的 const 表；接口本身不导出到 `packages/shared` 公共 API barrel，作 internal extension point 使用。
- 不动 opencode 源码。

## 当前三种 kind 的契约和失败码（最小集）

定义统一 errorMessage prefix `port-validation-<kind>-<subReason>`——**kind 命名空间**为底，scheduler 通过最外层 `port-validation-` prefix 命中决定追问，再剥出 `<kind>` 段路由到对应 handler 渲染 repair 文案。envelope.ts 把现有的三类 `ValidationError` 全部转码到这一 prefix。

| errorMessage prefix                                | 触发场景                                                                | 同 session 追问？ |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ----------------- |
| `port-validation-markdown_file-empty-path`         | markdown_file port 的 `<port>` 内容 trim 后为空                          | ✅ + 前置三条件   |
| `port-validation-markdown_file-escapes-worktree`   | markdown_file port 的路径解析后落在 worktree 外（lexical 或 realpath）   | ✅ + 前置三条件   |
| `port-validation-markdown_file-missing-file`       | markdown_file port 的路径在 worktree 内但 `readFileSync` 失败            | ✅ + 前置三条件   |
| `port-validation-markdown_file-wrong-extension`    | markdown_file port 的路径后缀 ∉ {`.md`, `.markdown`}（大小写不敏感）     | ✅ + 前置三条件   |
| `port-validation-markdown_file-empty-file`         | markdown_file port 路径合法、文件读到了，但内容 trim 后为空              | ✅ + 前置三条件   |
| _(预留)_ `port-validation-<kind>-<subReason>`      | 第 4 种 kind 落地时由 handler 自行声明 `subReasons` 集合；跨 kind 由 `<kind>` 段隔离命名空间，**永不冲突**。模块加载期 assert 全部 handler subReasons 拍平唯一，重名 throw | ✅ + 前置三条件   |

string / markdown 不产生 `port-validation-*` 失败——handler 的 `validate` 永远返回 `{ ok: true }`，契约就是 no validation。

errorMessage 完整文案保留与现状一致的人类可读部分（`markdown_file 'foo.md': ENOENT`），只在前缀做命名空间升级：从 `markdown-file-*: ...` 改成 `port-validation-<kind>-<sub>: ...`。所有现有 grep 守卫测试 / 日志归类需要做对应更新（统一计入测试矩阵 A8）。

**结构化 failures payload** 同步写入新列 `node_runs.port_validation_failures_json`（JSON 数组，每项 `{ port, kind, subReason, detail }`，其中 `subReason` 是 handler 内的**扁平短码**如 `missing-file`、`kind` 字段单独存——errorMessage 里的 `<kind>-<sub>` 复合码不重复落到 JSON 里），让 scheduler 不依赖 errorMessage 后半段 string-parse 就能判定追问 + 路由到对应 handler。

## 生产扫描

落地 PR-B 前必须先扫一遍生产 agent 表，把"声明了 `outputs` 但漏 `outputKinds: markdown_file`、却把 `<port>` 当 .md 路径用"的 agent 列出来，让作者补 frontmatter 之后再发版。**本地 dev box（2026-05-19 扫描结果）**：

```text
coder            outputs=[software_design, test_design]  outputKinds={software_design: markdown_file, test_design: markdown_file}  ✅
task-completion-checker  outputs=[]                         frontmatter_extra={mode: all}                                                ✅（无 markdown_file 端口）
doc              outputs=[docpath]                        outputKinds={docpath: markdown_file}                                          ✅
long-agent       outputs=[]                              frontmatter_extra={}                                                          ✅（无 markdown_file 端口）
```

本机零 freeloader。生产端需在 PR-B 落地前重新扫，发现遗漏者作者补声明后再合并；不补就会失败。

## 用户故事

- **US1**：我（工作流作者）声明 `outputKinds: { docpath: markdown_file }`，agent 跑完后把路径发对了但**忘了调 Write 落盘**，目前节点直接红。改完后：框架在同 session 追问"port `docpath` 内容验证失败：路径 `report.md` 不存在；请先落盘再发路径"，模型补一发，节点 done。
- **US2**：我的 agent 在 `<port>` 里放了 `../../../etc/passwd` 试图越界。改完后：框架追问"port X 的路径越出 worktree，必须用 worktree-relative 安全路径重发"。模型补正确路径 + 文件，节点 done；恶意 / 误用都被拦在 worktree 内。
- **US3**：节点挂了反问通道，agent 先 emit 了一个含 `markdown_file` 端口的 `<workflow-output>` 但文件没落盘。改完后：框架追问按 M4/M5 矩阵生成——既提醒 "现在按两步协议补 file"，又复述"下一轮你仍可选 clarify 继续反问 / output 收尾"，且 RFC-039 strong-bias 短句在 directive=continue 时正确出现在最末。
- **US4**：我（工作流作者）的 agent 只有 `string` / `markdown` 端口，从来不会触发 port-validation。改完后：行为零变化，所有现有测试零退化，且 followup prompt 不出现任何 markdown_file 提示噪声（M1/M3 不可达分支不会被错误地触发）。
- **US5**：未来有人加 `code_file` kind。改完后：在 `outputKinds/code_file.ts` 加一个 `validate` + `buildRepairBlock`，主干代码零改动；followup 矩阵自然覆盖（kind 系列 prefix 命中即追问）。

## 验收标准

### A1 — port-validation prefix 命中即追问

`decideEnvelopeFollowup`（`packages/backend/src/services/scheduler.ts:337`）识别集合扩展，命中条件**与 RFC-042 既有四前缀同质**：errorMessage 以 `port-validation-` 开头 + RFC-042 既有三前置条件全部满足（exitCode === 0 + opencodeSessionId 非空 + 有 agent text）。任何一条不满足 → 全新 session。

decode 时再从 `port-validation-<kind>-<sub>` 里剥出 `<kind>` 段路由到对应 handler 渲染 repair 文案；`<kind>` 未注册或 handler 不存在 → degraded 模式（仍然追问，但 repair 文案退化为通用提示），不阻塞流程。

### A2 — errorMessage prefix swap + envelope.ts 改用 new codes + 新增两个 subReason

`packages/backend/src/services/envelope.ts`：

- `markdown-file-empty-path` → `port-validation-markdown_file-empty-path`
- `markdown-file-escapes-worktree` → `port-validation-markdown_file-escapes-worktree`
- `markdown-file-read-failed` → `port-validation-markdown_file-missing-file`
- 新增 `port-validation-markdown_file-wrong-extension`（后缀不在 {.md, .markdown}）
- 新增 `port-validation-markdown_file-empty-file`（文件内容 trim 后空）

后半 human-readable 文案保留（`port-validation-markdown_file-missing-file: markdown_file 'foo.md': ENOENT ...`）。runner / scheduler 不改：靠最外层 `port-validation-` prefix 派发，老 swallow 逻辑不动；失败时同步写新列 `node_runs.port_validation_failures_json`（结构化 payload，含 `kind` + 扁平 `subReason`）。

**命名空间编码规则**（handler 侧实现统一）：errCode = `port-validation-${ctx.kind}-${result.subReason}`，handler 内部 `subReasons` 集合只声明 `subReason` 短码（如 `empty-path`），不重复带 kind 前缀；envelope.ts dispatch 处统一拼接。

### A2b — forgiveness path 删除

`envelope.ts:273 tryReadInWorktreeMarkdownPath` 整段移除（含其调用点）。kind 未声明的 port 永远走"raw 字符串透传"，不再尝试当 markdown_file 读。**breaking change**：依赖该路径 freeload 的 agent 必须显式声明 `outputKinds: { port: markdown_file }` 才能继续按文件读取——这正是本 RFC 想锁住的契约。

### A3 — followup prompt 渲染按矩阵生成

`renderEnvelopeFollowupPrompt`（`packages/shared/src/prompt.ts:589`）：

- 新增可选入参 `portValidationFailures?: Array<{ port: string; kind: AgentOutputKind; subReason: 'empty-path' | 'escapes-worktree' | 'missing-file' | string; detail?: string }>`、`agentOutputKinds?: AgentOutputKindsMap`。
- 当 `portValidationFailures` 非空时，主 bullets 之后插入**一段固定结构**：
  - 列出每个失败 port（反引号包裹）+ subReason 中文化短词 + （markdown_file 才追加）`required two-step protocol: write the file to disk first, then place ONLY the worktree-relative path inside the <port> tag`；
  - 不含 RFC-042 已有的 envelope-missing 文案（两套不同失败类型互斥触发）。
- 当 `hasClarifyChannel === true` 时，**先**渲染 bi-modal preamble bullets，**再**渲染 port-validation 段，**最后**才追加 RFC-039 directive=continue 短句（顺序锚定，§G3 表已说明）。
- 当既有 envelope-missing 与 port-validation 同时存在（极少见——通常互斥）时，runner / scheduler 选最近一次失败的失败类型；本 RFC 把"上一次失败的 errorMessage 决定本次 followup 形态"作为简单约束，不做合并文案。

### A4 — 三种 kind 的契约边界（测试守卫）

- string + 任意内容 → 永不产生 `port-validation-*` 错误（passthrough）。
- markdown + 任意内容 → 永不产生 `port-validation-*` 错误。
- markdown_file + (a) 空路径 → `port-validation-markdown_file-empty-path`；(b) 越界路径 → `port-validation-markdown_file-escapes-worktree`；(c) 路径不存在 → `port-validation-markdown_file-missing-file`；(d) 后缀非 .md/.markdown → `port-validation-markdown_file-wrong-extension`；(e) 内容空 → `port-validation-markdown_file-empty-file`。
- **未声明 outputKinds 的端口** → 任意内容直接 raw 透传（forgiveness path 已删除），**不会**触发 port-validation（kind === undefined 在 dispatch 处提前 return）。

### A5 — 重试预算 / 取消 / loop 跨 iter 正交

- port-validation 追问与 envelope-missing 追问共享同一份 retries 预算（默认 3，RFC-042 已设）。
- review reject / clarify-driven rerun / loop 跨 iter 跑的是新 attempt 0、不复用 sessionId，本 RFC 不在此路径生效（按 RFC-042 §A6 同样规则）。
- 用户取消（abort）/ timeout / 进程崩溃 → exitCode !== 0 → 强制全新 session（A1 自动退化）。

### A6 — 持久化追问事件

每次走 port-validation followup 时，`node_run_events` 新增一条 `kind='text'` 行 payload `[rfc049/port-validation-followup] {"port":"docpath","kind":"markdown_file","subReason":"missing-file","retryAttempt":N}`，参照 RFC-042 `[rfc042/envelope-followup]` 风格，前端不消费、仅审计用。payload 里同时带 `kind` + 扁平 `subReason` 让审计端按 kind 维度归类（未来加新 kind 不动事件 schema）。

### A7 — `OutputKindHandler` 静态接口（kind 扩展的唯一注入点）

`packages/backend/src/services/outputKinds/` 新目录，三个 handler 文件 `string.ts` / `markdown.ts` / `markdownFile.ts`，每个 `export default` 一个对象，**完整实现**以下接口：

```ts
interface OutputKindHandler {
  readonly kind: AgentOutputKind
  readonly subReasons: ReadonlySet<string>                          // 该 kind 独占的失败码集合
  buildPromptGuidance(input: { ports: readonly string[] }): string | null   // 首轮 prompt 注入
  validate(rawContent: string, ctx: ValidateCtx): ValidateResult           // parse 校验
  buildRepairBlock(input: { failures: readonly KindFailure[]; ports: readonly string[] }): string | null   // followup repair 段
}
```

`outputKinds/index.ts` 静态 import 三个 handler、组成 `HANDLERS: Record<AgentOutputKind, OutputKindHandler>` const 表；**模块加载期 assert**：把所有 handler 的 `subReasons` 拍平，重名直接 `throw new Error('subReason collision: <code> claimed by both <kindA> and <kindB>')`，CI 红。

主干迭代点（**只此 4 处**）：
1. `buildProtocolBlock(agent)` 遍历 agent 声明的 distinct kinds，调每个 handler 的 `buildPromptGuidance`，拼接非 null 段；
2. envelope.ts `resolvePortContent` 按 kind 拿对应 handler 调 `validate`；
3. scheduler `decideEnvelopeFollowup` 用 `port-validation-` 外层 prefix 命中、剥 `<kind>` 段路由；
4. shared prompt.ts `renderEnvelopeFollowupPrompt` 把 failures 按 kind 分组，分别调对应 handler 的 `buildRepairBlock`，拼成"每 kind 一段"的 repair block，段间空行隔开、首次出现顺序去重。

新增第 4 种 kind = 加一个 handler 文件 + 在 `index.ts` 加 `import + HANDLERS 表加一行`，**主干 4 处自动覆盖**，零改动。**本 RFC 仍不引入运行时 plugin loader / 动态注册 / `register()` API / `package.json` 插件读取**——是"静态可扩展接口"，不是"运行时可插拔注册表"。

### A8 — 测试矩阵

- **shared followup prompt**：`renderEnvelopeFollowupPrompt` 新增 6 case 覆盖 §G3 矩阵 M1-M6（M1/M3 不可达但断言文案不出现 markdown_file 段，防意外触发），既有 6 个 RFC-042 followup 单测全过（顺序锚点 + clarify 短语锚点 + RFC-039 短句位置守卫）。`buildRepairBlock` 单测 8 case（5 个 subReason 各 1 + detail 优先 + 多端口顺序保序 + 空 failures 守卫返 null）。
- **envelope.ts prefix swap + forgiveness 删除**：现有 `envelope-resolve-port-md-path.test.ts` / `envelope-resolve-port-detailed.test.ts` / `envelope-parse-md-edge-cases.test.ts` 三套测试断言改用新**命名空间**前缀（`port-validation-markdown_file-<sub>`）。**`tests/envelope-resolve-port-md-path.test.ts` 涉及 forgiveness 自动读 .md 文件的所有 case 需要重写为"raw 字符串透传"** 或迁移到声明了 outputKinds 的等价 case。新增源码层 grep 守卫：envelope.ts 必出现 5 个新 `port-validation-markdown_file-` errCode；必不再出现 `markdown-file-empty-path` / `markdown-file-escapes-worktree` / `markdown-file-read-failed` 旧 prefix；必不再出现非命名空间的 `port-validation-empty-path` 等"裸 sub"形态；必不再含 `tryReadInWorktreeMarkdownPath` 函数定义 / 任何调用点。
- **outputKinds 接口契约**：新增 `output-kinds-handler-interface.test.ts` 5 case：(a) 三个 handler 都实现完整接口（kind / subReasons / buildPromptGuidance / validate / buildRepairBlock 全字段在场）；(b) `HANDLERS` 表三 key 完整；(c) 模块加载期 subReasons 拍平唯一断言成功；(d) **fake-handler 冒烟**——构造一个 fake `code_file` handler 注入临时表，验证 `buildProtocolBlock` / `renderEnvelopeFollowupPrompt` 主干无需改即可消费它（用 vi.mock 注入，不动 prod HANDLERS）；(e) **subReason 命名空间冲突**——构造两个 handler 声明同名 `subReasons`，模块加载期 throw `subReason collision: <code>` 命中。
- **scheduler decideEnvelopeFollowup**：新增 `scheduler-port-validation-followup-decide.test.ts` 7 case（5 种 sub-reason 各 1 命中 + 缺 sessionId 不命中 1 + `port-validation-<未知 kind>-foo` degraded 命中 1）。
- **scheduler 行为**：新增 `scheduler-port-validation-followup-branch.test.ts` 7 case（5 类失败 → followup × 各 1 + 任一失败 + exitCode=137 → 全新 session × 1 + followup 又失败 + retries 剩余 → 再追问 × 1）。
- **runner per-port repair prompt 一体化**：新增 `runner-port-validation-followup.test.ts` 4 case（promptText 含 port 名 + sub-reason 短语 + 两步协议短句；isolated mode 不会被错误地走进 followup；hasClarifyChannel=true 时同一 prompt 同时含 bi-modal + repair + 适当排序；新列 port_validation_failures_json 行被正确 SELECT 出来）。
- **outputKinds per-handler 单测**：新增 `output-kinds-string.test.ts` / `output-kinds-markdown.test.ts` 各 3 case（validate 任意输入都 ok；buildPromptGuidance 返 null；buildRepairBlock 返 null）+ `output-kinds-markdown-file.test.ts` 11 case（validate happy + 5 类 fail + 大小写不敏感 + dispatch 边界；buildPromptGuidance 含两步协议短句 + 端口列表正确；buildRepairBlock 含 detail + 多端口保序）。
- **migration 0026 + 新列读写**：新增 `migration-0026-port-validation-failures.test.ts` 1 case（列存在 / nullable / 老行恒 NULL）+ `runner-writes-port-validation-failures-column.test.ts` 2 case（失败时写入有效 JSON / 成功时列保持 NULL）。
- **e2e**：本 RFC 不新增 Playwright（后端 / shared 改动；前端零变化）。
- **正交回归**：跑通 RFC-042 既有 8 + 4 + 4 + 2 + 1 + 2 测试零退化；跑通 RFC-005 review / RFC-014 sibling cascade / RFC-023 clarify / RFC-026 inline / RFC-040 wrapper / RFC-047 / RFC-048 既有套件零退化。

### A9 — 三件套 + CI

- 本地 `bun run typecheck && bun run test && bun run format:check` 全绿。
- GitHub Actions 六 jobs 全绿（无新增 jobs）。

## 风险与权衡

- **R1（错误前缀 swap 影响日志归类 / 审计）**：把 `markdown-file-*` 改成 `port-validation-markdown_file-*` 是个跨多文件的字符串改动，且**这一次还顺带切到 kind 命名空间**（从 `port-validation-empty-path` 升级到 `port-validation-markdown_file-empty-path`），grep 锚面比原计划更广。降险：源码层 grep 守卫**三向锚**（envelope.ts 必出现命名空间新前缀、必不出现旧 `markdown-file-*` 前缀、必不出现非命名空间 `port-validation-<sub>` 裸 sub 形态），并把 prefix swap 单列为 §plan.md PR-A 第一步，CI 必须先单独绿才能进 PR-B 引入追问决策。
- **R2（追问 prompt 文案膨胀）**：M4/M5 组合下文案最长（bi-modal + repair + RFC-039 trailer），可能让 followup 这一轮 prompt 长度逼近模型 context 警戒线。降险：每个段落都用 `prompt.ts` 既有函数原子组装、走顺序锚点，长度可被测试断言；如果实际 token 风险显现，下一次 RFC 再压缩文案，不影响协议结构。
- **R3（per-kind repair 段被模型当成"指令噪声"）**：模型在续 session 看到一段"你刚才那个 port 错了"短指令，可能误以为是用户新需求。降险：repair 段顶部加固定标记 `**Port content validation — follow-up.**`，让模型容易识别。
- **R4（forgiveness path 与 port-validation 同时触发）**：理论上不会——forgiveness path 只在 outputKinds 没声明 markdown_file 时进入，本 RFC 只对显式声明负责。降险：测试 A4 显式锁住这条边界。
- **R5（错误码改名破坏 monkey-patching mock）**：现有测试里 mock 出错误是用旧 ValidationError code 名拼字符串的，prefix swap 会让旧锚点 mismatch。降险：测试矩阵 A8 把这些断言一次性更新；不引入兼容期同时支持新旧两套前缀（同时支持反而留两套 grep 锚点污染未来 refactor）。
- **R6（handler 接口稳定前不要再扩第 4 方法）**：现在的 handler 接口刚好覆盖 prompt + parse + repair + subReasons 四个注入点。下一个开发者很容易顺手往里加"sharding strategy" / "aggregator" / "telemetry tag" 等额外字段（多进程节点的 kind-aware 分片是真的可预见的能力点），但这些跨度更大、还需要更多调用方调整，不应该混进 RFC-049。降险：(a) `outputKinds/types.ts` 文件头注释明写"四方法上限，新增能力请走单独 RFC"；(b) 拒绝运行时 plugin loader / 动态 `register()` API / `package.json` 插件加载——handlers 仍然是静态 import 表，未来要加运行时 plugin 也走独立 RFC 评估；(c) `OutputKindHandler` 接口 export 为 `internal`（不放进 `packages/shared` 的公共 API barrel）；(d) handler 文件 header 注释"新增 kind = 新增一个文件 + index.ts 加一行 import；接口本身的方法签名不要私自扩"。
- **R7（forgiveness path 删除是 breaking change）**：本机扫描零 freeloader，但其它部署可能依赖该路径。降险：(a) PR-B 落地前用 `sqlite3 .../db.sqlite "SELECT name, outputs, frontmatter_extra FROM agents WHERE outputs != '[]'"` 复跑一遍生产 agent 表，把 `outputs` 含端口但 `frontmatter_extra.outputKinds` 没声明同名 markdown_file 的 agent 列给作者补 frontmatter；(b) PR-B commit message 显式标 "BREAKING: forgiveness path removed"；(c) 老 task 已生成的 `node_run_outputs` 不重算，仅未来 attempt 走新规则。
- **R8（后缀加严误杀临时文件）**：若 agent 把 `.txt` / 无后缀 / `.draft` 当 .md 用，PR-B 落地后立即追问"必须用 .md / .markdown"。降险：第一次 followup 通常救得回（错就是文件名拼写问题），救不回的本来内容也大概率不合 markdown 协议，retries 烧完红节点和保留旧行为效果相近。可接受。

## 与已落地 RFC 的关系

- **RFC-005**：复用 `outputKinds` 字段与 `AgentOutputKind` 枚举，不扩字段；契约层在 `resolvePortContent` 入口前生效。
- **RFC-023 / RFC-039**：复用 bi-modal preamble + 强偏向短句；本 RFC 只在三段之间插入 markdown_file repair 段，顺序锚定不串行错位。
- **RFC-042**：本 RFC 是 RFC-042 的延伸——共享 `decideEnvelopeFollowup` 决策函数（加 prefix 分支）、共享 `renderEnvelopeFollowupPrompt`（加 portValidationFailures 入参）、共享同一份 retries 预算、复用 `--session <id>` 透传。两 RFC 失败类型互斥触发（envelope-structural vs port-content-validation），合流到同一追问机制。
- **RFC-026 inline-mode clarify**：复用同样的 `--session <id>` 续 session 机制；与本 RFC 在不同 attempt 维度生效，按 RFC-042 §R4 同样规则正交。
- **RFC-040 wrapper awaiting-bubble**：完全正交。
- **RFC-046 / RFC-047**：完全正交（不动 inject 记忆快照路径）。
