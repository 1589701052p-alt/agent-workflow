# RFC-067 — 任务级 Git 提交身份（user.name / user.email）

## 背景

任务运行时 agent (opencode) 在 worktree 里执行的 `git commit` 现在落的
author / committer 取决于宿主环境：

- daemon 进程继承的 `~/.gitconfig` 全局 `user.name` / `user.email`；
- 仓库自身 `.git/config` 里 fork 的覆盖；
- 完全没配时 git 会直接报 `Author identity unknown`，整个 agent run 在
  尝试 commit 时退出非 0 把 node_run 拍成 failed。

这套行为对单人本机 dev 没问题，但暴露两个产品问题：

1. **多身份场景**：同一个用户在不同 task 里希望以不同身份提交——比如同
   时给两家客户的代码库做事、用工作邮箱 vs 开源邮箱、模拟"AI bot 账号"
   提交方便审计。当前必须手动改全局 / 仓库 config，**改完还会污染当前
   shell 后续手工操作**。
2. **AI agent 提交可追溯**：希望 task 里 AI 跑的 commit 一眼能从 author /
   committer 看出来是哪个 task / 哪个 bot 身份，而不是混在用户日常 commit
   里。

技术侧已经确认（见会话历史 + `opencode/packages/opencode/src/tool/
shell.ts:419`）：daemon spawn opencode 时透传的 env，opencode shell tool 会
原样透传到子进程；所以 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 四件套从 daemon
落地到最终 `git commit` 全链路只要 daemon 知道身份就行。

## 目标

- **任务创建表单**新增可选输入 `Git 用户名` / `Git 邮箱` 两个字段（位于
  任务名之后、Repo 来源 tab 之前；下拉折叠区，默认收起，避免遮挡主流程）。
- **两个字段都可空**：
  - 都空 → task 不持久化身份；运行时不注入任何 `GIT_*` env，agent 的
    `git commit` 按 git 原生规则解析（仓库 config → 全局 `~/.gitconfig` →
    报错）。这是当前默认行为，**字节级守恒**。
  - 任一填了 → **两个都必填**（提交时校验，校验失败前端红框提示，不
    POST）。理由：缺一会让 author/committer 拆分成两个不同身份（一个走
    env、一个走 git config 回退），调试极其混乱，没必要支持这种半身份
    状态。
- 填了的身份**只对该 task 生效**：
  - 持久化到 `tasks` 表新增的 `git_user_name` / `git_user_email` 列；
  - daemon spawn opencode 时把 `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` /
    `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` 四个 env 都注进去；
  - **不写** worktree 的 `.git/config`（实施期决策——见 design.md §7
    第二点）：默认 `git config` 在 worktree 内会写到父仓共享的 `.git/
    config`，并发同仓 task 互相覆盖；用 `extensions.worktreeConfig=true`
    解决又会污染用户的父仓全局开关。Env 注入已经覆盖 99% 路径，没必要
    为剩下 1% 引入并发 bug 风险。
  - 不影响 daemon 进程自身、不影响其它 task、不污染用户全局 / 仓库
    config。
- **不**做 push 凭证管理（push 走的是 SSH key / HTTPS token / credential
  helper，跟 commit identity 没关系；本 RFC 严格 scope 在 commit
  author / committer 元数据）。
- **不**做"记住上次输入"或 settings 全局默认（v1 极简；如有需要后续 RFC
  扩展）。

## 非目标

- 不支持 **per-agent** / per-node 身份覆盖。所有 node 在同一个 task 里走
  同一个身份。理由：(1) RFC-064 正在收口 clarify 运行时，这是 worst time
  动 scheduler / runner；(2) per-node 价值小，AI 跑的 commit 已经能从 task
  ID 反查到具体 node_run；(3) 简单。
- 不支持任务**启动后修改**已绑定的身份。理由：commit 已经写出去就改不
  回，事后再改 task 元数据只会让 DB 与 git 历史不一致。任务一旦启动，
  `git_user_name` / `git_user_email` 列**只读**（API 层 PATCH 不暴露）。
- 不做 GPG / SSH 签名（`commit.gpgsign`、`-S`）。签名涉及密钥管理，与本
  RFC 不相关，另立 RFC。
- 不做"任务列表 / 详情页展示身份"。v1 数据存了但 UI 不展示——这俩字段
  对运行结果没有影响，不进核心信息流；如未来 audit 面板要看，再扩。
- 不做历史 task 的回填 / 迁移；存量行 `git_user_name` / `git_user_email`
  保持 NULL（行为与"不填"一致，零行为变更）。

## 用户故事

1. **多客户场景**：用户给客户 A 跑 task 时填 `Bot A <bot@a.example>`，
   给客户 B 跑 task 时填 `Bot B <bot@b.example>`。两个 task 并行跑，
   `git log` 里 author 一目了然，互不串。
2. **AI bot 身份审计**：组里规定"AI 跑出来的 commit author 必须是
   `Agent Workflow <agent@workflow.local>`"，用户每次创建 task 都填这两
   个字段；后续 review PR 时一眼看出哪些 commit 是 AI 跑的。
3. **默认行为不变**：不在乎身份的用户继续什么都不填，跟现在体验完全一
   致——表单字段默认折叠收起、空、提交时不传，DB 列 NULL，运行时不注
   env。

## 验收标准

- AC-1 表单两个字段都空 → 提交成功；DB 行 `git_user_name` /
  `git_user_email` 都是 NULL；runner spawn opencode 时不出现 `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` env；worktree `.git/config` 不被写入 `[user]` 段。
- AC-2 两个字段都填了 → 提交成功；DB 行两列都按 trim 后的输入存；runner
  注入四个 env（GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL）。**不**
  写 worktree `.git/config`（实施期改动，避免并发 task 同仓互相覆盖）。
- AC-3 只填一个 → 前端校验红框提示"用户名和邮箱必须同时填或同时留
  空"，Start 按钮 disabled；即便绕过前端直接 POST，后端 `StartTaskSchema`
  superRefine 拒收并返回 422 `git-identity-incomplete`。
- AC-4 邮箱字段输入 `not-an-email`（无 `@`）→ 前端校验红框 + Start
  disabled；POST 后端拒 422 `git-identity-email-invalid`。校验规则宽松：
  `/^[^\s@]+@[^\s@]+$/`——不强校验 TLD / DNS，让用户可以用 `bot@local`
  之类的伪邮箱（git 允许）。
- AC-5 任务启动后，AI 在 agent 里运行 `git commit -m "..."` → 落到
  worktree 的提交 author 与 committer 都是 task 配置的身份；同时验证
  `git -C <worktree> log -1 --pretty=fuller` 输出含 `Author: Name <email>`
  和 `Commit: Name <email>` 两行一致。
- AC-6 同一 worker pool 同时跑 task X (身份 A) + task Y (身份 B) → 两边
  commit author 不串；env 不会泄漏到对方进程（每次 spawn 单独构造 env
  字典，process.env 不被改）。
- AC-7 升级路径：跑 migration 0034 → 历史 task 行 `git_user_name` /
  `git_user_email` 全 NULL，旧任务"恢复运行"（RFC-042 retry）时仍按
  NULL 走，行为字节级守恒。
- AC-8 仓库自带 `.git/config` 已有 `[user]` 段时：
  - task 填了身份 → runner 注入的 env 胜过仓库 `[user]`；author / committer
    走 task 身份。
  - task 没填 → 不注入 env；agent commit 走仓库自己的 `[user]` 段（与现
    在一致）。
- AC-9 表单 i18n cn/en 对称：cn `Git 用户名（可选）` / `Git 邮箱（可选）`
  + hint `留空则使用系统默认身份`；en `Git user name (optional)` /
  `Git user email (optional)` + hint `Leave blank to use the system default
  identity`。
