# RFC-067 — 技术设计

## 范围速览

- shared：`StartTaskSchema` 加 2 个可选字段 + superRefine 双校验；
  `TaskSchema` 加 2 个可空字段映射 DB 列。
- backend：migration `0034_task_git_identity.sql` 加 2 列；`services/task.ts`
  在 `startTask` 持久化 + 在 `git worktree add` 之后写 worktree `.git/config`；
  `services/runner.ts` spawn opencode 时按 task 行注入四个 env。
- frontend：`routes/workflows.launch.tsx` 加折叠区 + 两个 `<TextInput>`；
  `lib/launch-repo-source.ts` 的 `buildLaunchBody` / `buildLaunchFormDataV2`
  扩参带身份。
- i18n：cn/en 各加 5 个 key。
- tests：shared 6 / backend 12 / frontend 6 = 24 个新 case。

零 scheduler / clarify / review / inventory / RFC-064 触及；与正在进行的
RFC-064 / RFC-065 / RFC-066-multi-repo-task-launch 三个 Draft RFC 互相**无
代码冲突**（落在不同函数 / 不同列 / 不同前端组件区段）。

## 1. Shared 层

### 1.1 `StartTaskSchema`（`packages/shared/src/schemas/task.ts`）

在现有 `superRefine` 之上加：

```ts
gitUserName: z.string().min(1).max(255).optional(),
gitUserEmail: z.string().min(1).max(255).optional(),
```

`superRefine` 追加两条 issue：

- 同填或同空（XOR 违反 → 422 `git-identity-incomplete`，path `['gitUserName']`
  或 `['gitUserEmail']` 看哪边空）；
- email 命中正则 `/^[^\s@]+@[^\s@]+$/` 才合法（→ 422
  `git-identity-email-invalid`，path `['gitUserEmail']`）。

注意：`.optional()` 让前端 path 模式 / URL 模式都不强制；只在**两者之一
被填**时才走 XOR + 邮箱校验。trim 不在 schema 做（让 422 message 准确指向
用户实际敲的字符串）；后端 `services/task.ts` 写库时再 `.trim()` 落 DB。

### 1.2 `TaskSchema`（同文件 ~line 42）

加：

```ts
gitUserName: z.string().nullable(),  // null 表示走默认
gitUserEmail: z.string().nullable(),
```

`getTaskById` mapper 对应 select 出来。前端 `Task` 类型自动同步。

## 2. DB / migration

### 2.1 Migration `0034_task_git_identity.sql`

```sql
ALTER TABLE tasks ADD COLUMN git_user_name TEXT;
ALTER TABLE tasks ADD COLUMN git_user_email TEXT;
```

无索引（不用于查询）；无 backfill（NULL = 默认行为，与历史 task 字节级
守恒）。

drizzle schema (`packages/backend/src/db/schema.ts`) `tasks` 表加：

```ts
gitUserName: text('git_user_name'),
gitUserEmail: text('git_user_email'),
```

`upgrade-rolling.test.ts` HEAD journal count 顺手 +1。

### 2.2 `services/task.ts` 持久化

在 `startTask`（~line 298 现有 RFC-037 name 处理之后）：

```ts
const gitUserName = input.gitUserName?.trim() || null
const gitUserEmail = input.gitUserEmail?.trim() || null
```

`db.insert(tasks).values({...})` 加这两个字段。

### 2.3 Worktree `.git/config` 写入（兜底）

`startTask` 现有逻辑里有 `git worktree add ...` 之后立刻执行：

```ts
if (gitUserName && gitUserEmail) {
  await runGit(['config', 'user.name', gitUserName], { cwd: worktreePath })
  await runGit(['config', 'user.email', gitUserEmail], { cwd: worktreePath })
}
```

`runGit` 复用 `services/task.ts` 现有的 git helper（同 `git worktree add`
那条）。NULL 时跳过——绝不写入空字符串，避免把"未设置"覆盖成"空字符串
作者"。

## 3. Runner spawn env 注入

`packages/backend/src/services/runner.ts:669` 现有 env dict 之后追加：

```ts
if (opts.gitUserName && opts.gitUserEmail) {
  env.GIT_AUTHOR_NAME = opts.gitUserName
  env.GIT_AUTHOR_EMAIL = opts.gitUserEmail
  env.GIT_COMMITTER_NAME = opts.gitUserName
  env.GIT_COMMITTER_EMAIL = opts.gitUserEmail
}
```

`RunnerOpts` 类型加 `gitUserName?: string; gitUserEmail?: string`。调用方
（`services/scheduler.ts` 的 `runAgentNode` 等）从已加载的 `task` 行直接透
传——scheduler 已经把 task 行 cache 在调度上下文里，不需要新 query。

**重要**：四个 env 必须**同时**注入。XOR 在 schema 已经保证，runner 层多
一层防御性 if（只在 `name && email` 都真值时才注入），避免某天 schema 被
误改导致半身份注入。

env 优先级：

- daemon `process.env` → spread 进 env dict（line 670 现有）；
- 然后 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 显式覆盖。

即便 daemon 的父 shell 设了 `GIT_AUTHOR_*`，task 身份仍然胜出（spawn env
里后写赢）。

## 4. Frontend

### 4.1 `routes/workflows.launch.tsx`

在"任务名"`<Field>` 之后、`RepoSourceTabs` 之前，加一段：

```tsx
<details className="launch-collapsible" data-testid="launch-git-identity">
  <summary>{t('launch.gitIdentity.toggle')}</summary>
  <div className="launch-collapsible__body">
    <Field label={t('launch.gitIdentity.name')} hint={t('launch.gitIdentity.hint')}>
      <TextInput value={gitUserName} onChange={setGitUserName} maxLength={255}
                 data-testid="launch-git-user-name" />
    </Field>
    <Field label={t('launch.gitIdentity.email')} error={emailError}>
      <TextInput value={gitUserEmail} onChange={setGitUserEmail} maxLength={255}
                 data-testid="launch-git-user-email" />
    </Field>
    {pairingError && <div className="error-text" role="alert">
      {t('launch.gitIdentity.pairingError')}
    </div>}
  </div>
</details>
```

`launch-collapsible` class 复用现有 `<details>` 风格（如无，加 1 段
~15 行 CSS：`details > summary { cursor: pointer; ... }` 跟 `.page__section`
间距对齐）。

校验状态派生：

```ts
const both = gitUserName.trim() && gitUserEmail.trim()
const neither = !gitUserName.trim() && !gitUserEmail.trim()
const pairingError = !both && !neither
const emailError = gitUserEmail.trim() && !/^[^\s@]+@[^\s@]+$/.test(gitUserEmail.trim())
  ? t('launch.gitIdentity.emailInvalid') : null
const gitIdentityOk = neither || (both && !emailError)
```

`canStart` 现有 derive 增加 `gitIdentityOk` 一项。

### 4.2 `lib/launch-repo-source.ts`

`LaunchCommonPayload` 加：

```ts
gitUserName?: string  // already trimmed; empty / undefined → omit from body
gitUserEmail?: string
```

`buildLaunchBody` 末尾：

```ts
if (common.gitUserName && common.gitUserEmail) {
  out.gitUserName = common.gitUserName
  out.gitUserEmail = common.gitUserEmail
}
```

multipart 版本同步。空时不写字段 → 后端 schema `optional` 接住、DB 落
NULL。

### 4.3 i18n（5 key cn/en）

```
launch.gitIdentity.toggle          'Git 提交身份（可选）'           'Git commit identity (optional)'
launch.gitIdentity.name            'Git 用户名'                      'Git user name'
launch.gitIdentity.email           'Git 邮箱'                        'Git user email'
launch.gitIdentity.hint            '留空则使用系统默认身份'           'Leave blank to use the system default identity'
launch.gitIdentity.pairingError    '用户名和邮箱必须同时填或同时留空' 'Name and email must both be set or both be blank'
launch.gitIdentity.emailInvalid    '请输入合法的邮箱（含 @）'         'Enter a valid email address (must include @)'
```

（6 个 key，proposal §AC-9 写"5 个"是粗算，实际是 toggle/name/email/hint/
pair/emailInvalid 共 6 个。）

## 5. 测试策略

### 5.1 Shared（6 case，新文件 `tests/start-task-schema-git-identity.test.ts`）

- 都空 → ok，object 不含字段。
- 都填 + 邮箱合法 → ok，字段透传。
- 只填 name → reject，issue path `['gitUserEmail']` message 含 `git-identity-incomplete`。
- 只填 email → reject，issue path `['gitUserName']`。
- 邮箱 `not-an-email` → reject，issue path `['gitUserEmail']` message
  含 `git-identity-email-invalid`。
- 邮箱 `bot@local`（伪邮箱）→ ok（宽松规则）。

### 5.2 Backend（12 case）

新文件 `tests/task-start-git-identity.test.ts`：

- 8 行为 case：
  - 都空 task：DB 行两列 NULL；spawn 后 child env **不**含 `GIT_AUTHOR_*`；
    worktree `.git/config` 不含 `[user]`。
  - 都填 task：DB 两列存 trim 值；child env 四件套全有且=输入；worktree
    config 包含 `user.name` / `user.email`。
  - daemon 自己设了 `GIT_AUTHOR_NAME=daemonbot` → child env `GIT_AUTHOR_NAME`
    =task 身份（task 胜过 daemon env）。
  - 并行两 task 不同身份：A 的 env 不泄漏到 B 的 spawn（env 隔离断言）。
  - migration 0034 应用后历史行 NULL（fixture 一行 pre-migration row）。
  - PATCH task（如已暴露）不能改 `gitUserName` / `gitUserEmail`（API
    层不暴露字段 → request 里写也无效；测试断言 response 不含 / DB 不变）。
- 4 grep / source-text 守门：
  - `services/runner.ts` 必须出现四件套全名（防部分注入）。
  - `services/task.ts` 写 worktree config 的两行 git command 存在。
  - `db/schema.ts` `tasks` 表确实有 `gitUserName` / `gitUserEmail`。
  - migration journal idx 与 0034 文件名匹配。

### 5.3 Frontend（6 case，扩 `tests/workflows-launch.test.tsx` + 新
`tests/launch-git-identity.test.tsx`）

- 默认表单：折叠区 closed；两 input 不在 a11y tree（详见 `<details>`
  默认行为）。
- 展开后两 input 都空：Start enabled（合法）；body 不含 `gitUserName` /
  `gitUserEmail` 字段（`buildLaunchBody` 输出快照）。
- 只填一个：`role="alert"` 节点出现 pairing error 文案；Start disabled。
- 两个都填 + 邮箱缺 `@`：emailInvalid 节点出现；Start disabled。
- 两个都填 + 邮箱合法：Start enabled；POST body 含两个字段（trim 后）。
- i18n 锁：cn 文案"留空则使用系统默认身份"出现在 hint；en 同位锁
  "Leave blank to use..."。

## 6. 与其它正在进行 RFC 的耦合分析

- **RFC-064（Unified Clarify Runtime）**：动 `services/scheduler.ts` 4 处
  cci 派生 + `services/crossClarify.ts` 整体搬迁。本 RFC 只动
  `services/runner.ts` spawn env 段 + `services/task.ts` startTask 段，
  零交叉。RFC-064 PR-B 落地后本 RFC 的 `runAgentNode` 调用点路径可能从
  `services/scheduler.ts:1065` 变到 `services/scheduler.ts:??`——但调用
  site **新增 2 个透传参数**与 RFC-064 重构方向正交，rebase 时 git 几乎
  不会冲突。
- **RFC-065（Task Worktree Files Tab）**：纯前端 + 新增 2 个后端 GET 路由，
  与本 RFC 任何文件无重叠。
- **RFC-066（Multi-Repo Task Launch）**：动 launch 表单 + `StartTaskSchema`
  + tasks 表结构。**可能与本 RFC 在两个 schema / 表 / 表单上抢同一段
  代码**。规避：(a) 本 RFC 字段名 `gitUserName` / `gitUserEmail` 不与多
  仓 RFC 字段冲突；(b) migration 编号需要在落 PR 之前再查一次，本 RFC 用
  0034 是基于当前 HEAD（journal 末位 0033）+ 1 — 如果 RFC-066 先落 0034，
  本 RFC bump 到 0035；(c) 启动表单 collapsible 加在任务名之后、Repo
  tabs 之前，与多仓 RFC 改的"Repo 来源 tab 多 entry"段独立。

## 7. 失败模式 / 取舍

- **半身份注入**（只填 name 或只填 email）：schema XOR + runner if 双重
  防御；不允许"半身份"持久化。代价：用户偶尔需要"只设 author 不设
  committer"等罕见场景被阻断。判断：这种需求 v1 不值得撑，需要再开 RFC。
- **worktree config 与 env 并存**：env 优先级高于 config，所以"双写"
  在 99% 情况下是冗余的；保留是为了非 opencode 路径（如未来某个 agent
  类型不经过 runner，或用户手工进 worktree 做事时）能用。代价：worktree
  目录被写进两行 config，commit 用户不易察觉；但任务结束后 worktree 是
  框架管理的产物，不应该被当作长期共享对象。
- **不签名**：commit 拿到 author/committer 但**不带 GPG/SSH 签名**。如
  果某些上游分支启用了 protected branch + 强制签名，agent 的 commit 还是
  会被服务器拒。Out of scope；要 GPG / SSH 签名另立 RFC。
- **email 校验宽松**：只查 `[^\s@]+@[^\s@]+`，不查 TLD / DNS。理由：git
  本身只要求格式 `Name <email>`，本就不验证邮箱可达性；framework 不应
  比 git 更严。
- **运行后修改**：tasks 表两列在 schema 层非只读，但 API 层 PATCH 不
  暴露——若有需求暴露，应该 (a) 限制只在 status=pending 时允许、(b) 重写
  worktree `.git/config`、(c) 通知 runner 重新 spawn 时拿新身份。这些复杂
  度都不在 v1。
