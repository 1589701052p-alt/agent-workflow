# RFC-044 — Distiller 输入上下文加强：clarify 源对话 + review 文档原文

## 1. 背景

RFC-041 落地的 distiller 把 clarify_session / docVersions / task_feedback 三类 source event
喂给一个 opencode 子进程，让模型生成候选记忆。具体喂进 prompt 的字段在
`packages/backend/src/services/memoryDistiller.ts:354-388`：

| 源类型 | 当前喂进 prompt 的内容 | 缺失 |
|---|---|---|
| clarify | `questions_json` + `answers_json` 两个 blob（按 4000 char 截断） | 触发 clarify 的那个 **source agent node_run** 整段对话 |
| review | `decision` 字符串 + `bodyPath` **字符串本身**（"reviewed body lives at /Users/.../v3.md"）+ comments anchor 摘要 | 被评审的 markdown 文档**正文**（distiller 是 pure-prompt agent，没 tool 读不开文件） |
| feedback | `bodyMd` 全文 | （已完整，OK） |

实测后果：

- **clarify 路径**：distiller 看到的是「Q: 这里要不要 backward-compatible？ A: 是」这种问答对，
  但完全不知道 agent 是在跑 prisma migrate / review PR / 写 RFC 哪种语境下问的。
  推断出来的候选记忆 scope 经常拍偏（一句通用规则被锁到 `agent:senior-engineer`），
  或者把过分情境化的 Q&A 提炼成不该当 long-term memory 的条目。
- **review 路径**：distiller 看到 `"(¶3) on 'we use Drizzle': should we keep this?"`
  这种 80 字符的截选 anchor + comment body，没有文档正文做语义锚点，
  几乎只能照搬 comment body 当记忆。candidate 里频繁出现 `"keep this"` / `"don't do that"`
  这种缺主语的句子，admin approve 时全靠脑补。

distiller 模型本身没问题——是上下文喂得不够。

## 2. 目标

让 distiller 看到与"做出决策的那一刻"相同信息密度的上下文，且不破坏 RFC-041 既有的
debounce / scope / dedup / inject 全部链路。

### 2.1 必须做到

- **clarify 上下文加强**：
  - 拉 `clarify_sessions.sourceAgentNodeRunId` 对应那一个 node_run 的 `node_run_events`，
    走 `parseSessionTree`（与 RFC-027 SessionTab / RFC-043 distill 详情页同一段代码）
    解成 SessionTree，渲染成 markdown 对话 block 嵌入 distiller user prompt。
  - 渲染范围：从 source agent spawn 到发出 `<workflow-clarify>` 为止——也即"问出这一轮
    clarify 问题的 agent 完整运行轨迹"。同一 source agent 节点的更早 clarify 轮次（如
    iter 1 已问过、答了、iter 2 又问）**不**累计——只看本轮这一个 node_run。
  - 缺失防御：source node_run 不存在（legacy 数据 / FK 已 cascade 删）或 events 为空
    （pre-RFC-027 path），prompt 里写一行 `(source-agent transcript unavailable: <reason>)`
    占位，distiller 仍能跑、退化到现行只看 Q&A 的语义。
- **review 上下文加强**：
  - 读 `docVersions.bodyPath` 指向的 markdown 文件，把全文嵌入 prompt
    （在原 `bodyPath` 行后面紧跟一个 fenced `markdown` block）。
  - 文件读失败（被 GC / 路径漂移）→ 同样写占位行 `(reviewed body unavailable: <reason>)`。
  - 仅当前被决策的版本——iterate 链上更早的 v1..v(N-1) 不拉。
- **可配置 budget**：
  - 在 `Config` schema 加 `memoryDistillSourceContext`：`{ clarifyTranscriptMaxBytes,
    reviewBodyMaxBytes }`。默认 16384 / 16384（≈ 4K token 上限），允许 0 关闭（关闭则
    退化到 RFC-041 原行为）、上限 65536（防止单 source 单条 256K，拉爆 prompt cache）。
  - 截断策略：超长时保留前 50% + 末尾 50%，中间插 `\n... [truncated <N> bytes] ...\n`
    marker。模型对 head + tail 的可解释性优于纯 head clip——开场和结尾通常含语义核心。
- **prompt 结构稳定**：
  - clarify 块加一个 `Source agent transcript:` 子段，紧跟现有 `Questions:` / `Answers:`。
  - review 块加一个 `Reviewed document body:` 子段，紧跟现有 `(reviewed body lives at ...)` 行
    并把那行从字符串改成 metadata。
  - 既有 dedup context block（`# Currently-approved memories`）和 instruction block
    完全不变。
- **审计可观察**：
  - distill job 详情页（RFC-043）能照常显示完整 user prompt——也就是上下文加强后的
    prompt——admin 排查时能直接看到 distiller 当时看到了什么。
- **测试覆盖**：
  - loader 单元：`loadSourceEvents` 三组（clarify with/without events、review body
    found / missing / oversize、feedback 不变）。
  - prompt builder 单元：head+tail clip 边界、占位 marker、各 source kind 渲染顺序。
  - 端到端：跑一个 mock distill job，断言生成的 user prompt 包含 source transcript +
    document body 段。
  - grep 守卫：`memoryDistiller.ts` 必须含 `Source agent transcript:` / `Reviewed
    document body:` 两条 literal，防止后续重构静默回退到 RFC-041 形态。

### 2.2 非目标（v1 不做）

- 不拉同一 source agent 节点的历史 iteration（clarify iter 1 / iter 2 各只看本轮 node_run）。
- 不拉 iterate 链上更早的 docVersion（v3 被决策只看 v3，不拼 v1 / v2）。
- 不为 distiller 注入文件读 tool 让它自己去 grep 文档——distiller 仍是 pure-prompt agent
  （RFC-043 §5 已约定），所有上下文在 prompt 静态注入。
- 不改 distiller system prompt 文案——上下文加强后模型对 Q&A 的解释自然变深，不需要
  改 instruction。
- 不动 dedup / scope resolved / debounce / 5s 频控 / exp backoff / inject / approval UI 任一
  环节。
- 不改 RFC-043 distill 详情页的字段集合——它已经会展示 `user_prompt_md`，加强后的 prompt
  天然落进去，无新建列。

## 3. 用户故事

### S1：admin 在 Approval Queue 不再"猜上下文"
admin 看到一条候选 "agents should write tests in the same file as the implementation when
working in this repo"，scope=repo/agent-workflow。她不确定是不是模型过拟合了一次 review。
她点详情页（RFC-043），看到 distiller 当时的 user prompt 里：

- `## Review decisions` 区有 review:dv_xxx 的 decision=`iterated`、comments 列了 6 条，
  并且新增 `Reviewed document body:` 把整篇 review 文档（`RFC-XXX-T2 plan.md`）正文摆出来。
- 文档正文里明确说"测试与实现共存于同文件 — 与现有 Convention 一致"。
- comment ¶7 引用了 "tests in the same file" 那段并打勾。

admin 确认推理来源充分（基于文档约定 + 评审同意 + 6 条评论支撑），按 Approve。

### S2：clarify 触发的候选不再被 scope 拍偏
agent `code-writer` 跑到一半反问"这个 migration 要不要 backward-compatible？"，admin 答
"是"。distill 跑完出一条候选 "always confirm backward-compatibility on schema migration
before generating SQL"，scope=agent/code-writer。

但实际跑下来 admin 在详情页看到 source agent transcript 全摆出来：原 agent 是在
跑 `RFC-X-T5 migration plan generator`，这是一类专门干 migration 的工作流的节点。distiller
本应该把 scope 推成 `workflow:migration-plan-generator` 而不是 agent。她回 Approval Queue 用
RFC-045（即将落地的 manual edit）改 scope，approve。

如果 RFC-044 没落地（看不到 source transcript），admin 根本无法判断 scope 是否拍偏，
只能凭候选 title/body 的字面理解 approve 或 reject。

### S3：缺失上下文优雅退化
某条 clarify_session 是 RFC-027 之前的 legacy 行，对应 node_run 已经被 cascade 删除。
distiller 不报错，prompt 里出现：

```
Source agent transcript:
(source-agent transcript unavailable: node_run not found)
```

distiller 继续按 RFC-041 原方式只读 Q&A 提炼，candidate 照常产生，只是质量回落到本 RFC
之前的水平。

## 4. 验收标准

- 修改后 `buildDistillerUserPrompt` 对每个 clarify event 输出 `Source agent transcript:`
  段（含 markdown 渲染的 SessionTree 或占位行）。
- 修改后 `buildDistillerUserPrompt` 对每个 review event 输出 `Reviewed document body:`
  段（含文档正文 fenced block 或占位行）。
- 新增配置 `memoryDistillSourceContext.{clarifyTranscriptMaxBytes, reviewBodyMaxBytes}`：
  - 默认 16384 / 16384。
  - 设为 0 → 退化到 RFC-041 行为（不拉 transcript / body）。
  - 设为上限值（65536）→ 单 source 单条上限不超过此值。
- 截断 marker `... [truncated N bytes] ...` 在超长 transcript / body 时出现且 byte 数准确。
- distill job 详情页（RFC-043 已有）展示加强后的完整 user prompt（`user_prompt_md`）。
- 失败 source（node_run 缺失 / file 读不开）写 `(source-agent transcript unavailable: ...)`
  / `(reviewed body unavailable: ...)` 占位，distiller 仍正常跑。
- distiller subprocess 总 prompt 字节数在最坏情况（10 events × 64KB cap × 2 + dedup
  context）仍 < 2MB——OS env / pipe 容量内。
- 不退化：RFC-041 既有 4 PR + RFC-043 距详情页全部测试 100% 绿。

## 5. 与既有 RFC 关系

- **RFC-041**：本 RFC 只动 `loadSourceEvents` + `buildDistillerUserPrompt` 两处函数 + 1 个
  config 字段；distiller spawn / dedup / scope / inject / approval 全部不动。RFC-041
  proposal §G7 / §P143 immutable 约束**不**受影响。
- **RFC-027 / RFC-043**：复用 `parseSessionTree` + `transcodeOpencodeRowsToEvents` 已落地
  的解析链路。`memory_distill_events` 表与本 RFC 正交（那个记录的是 distiller 自己的对话；
  本 RFC 加的是 distiller 的**输入**）。
- **RFC-045 (manual memory authoring)**：上游修复——distiller 上下文更全，candidate 推
  准确度更高，下游 manual edit 的需求会减小，但不替代——人工修正仍有刚需场景。
- **RFC-042**：完全正交。envelope follow-up 是 runner 层重试，与 distiller 上下文无关。
