# RFC-157 — 技术设计

对照锚点：RFC-050（记忆提炼输出语言）是本 RFC 的**逐点镜像来源**。凡「与记忆提炼一致」处，
下文给出对应 RFC-050 的具体实现位点，实现时照抄形态、只换 commit-push 语境。

## 1. 配置契约（shared）

`packages/shared/src/schemas/config.ts`：在 RFC-075 commit-push 字段区（`commitPushDiffMaxBytes`
之后）新增：

```ts
/**
 * RFC-157: language the built-in commit agent writes the commit-message
 * summary + body in (initial message AND push-repair message). Mirrors
 * `memoryDistillLang`: `undefined` is treated as 'en-US' at runtime, i.e.
 * unset and explicit 'en-US' are equivalent (English). The Conventional-Commits
 * `<type>(<scope>):` prefix ALWAYS stays lowercase ASCII (only the human
 * summary/body flips). Independent from the frontend UI `language`.
 */
commitPushLang: LanguageSchema.optional(),
```

- `LanguageSchema = z.enum(['zh-CN', 'en-US'])`、`type Language`——已存在，直接复用（`memoryDistillLang`
  同款）。
- **`ConfigPatchSchema` 需扩 nullable**（Codex 设计门 P2-1 修正）：`ConfigPatchSchema =
  ConfigSchema.partial().omit(...).extend(...)`。`.partial()` 只把 `commitPushLang` 变 `optional`（可省，
  **不接受 null**）；但后端 `mergePatch`（`config/index.ts:103`）对 **absent/undefined 视为「不改」、
  仅 `null` 才 `delete`**。前端「Default」若发 `undefined` 会被 `JSON.stringify` 丢弃 ⇒ 已存 `zh-CN`
  永远清不掉（=假保存）。故把 lang 字段加进 `.extend()` 的 nullable 列表，与 runtime/model「继承」同款：
  ```ts
  commitPushLang: LanguageSchema.nullable().optional(),
  memoryDistillLang: LanguageSchema.nullable().optional(), // 随行修：记忆卡同款隐患一并修
  ```
  基础 `ConfigSchema` 仍是 `LanguageSchema.optional()`（不接受 null——null 是 patch-only=delete，
  与 runtime 字段一致；落盘配置永不存 null）。
- **随行修 `memoryDistillLang`**：它现有下拉框 `onChange` 发 `undefined`，有与上同款「选 Default 清不掉
  已存值」隐患（现有 `settings-memory-distill-lang.test.tsx` 只验请求体、未验 merge 结果，故未暴露）。
  本 RFC 把它一并改为发 `null`（详见 §4），保持两个语言下拉框行为一致——否则违背用户「配置项一致」诉求。
- `DEFAULT_CONFIG` 不含该字段（保持 undefined，与 `memoryDistillLang` 一致）。

## 2. Prompt 指令（backend, `services/commitPush.ts`）

镜像 `memoryDistiller.ts` 的 `DistillerOutputLang` + `DISTILLER_OUTPUT_LANG_DIRECTIVE`
（该文件 180–186 行）。新增：

```ts
import type { Agent, Language, NodeRunStatus } from '@agent-workflow/shared'

/**
 * RFC-157: short trailer appended at the END of the commit-message / repair
 * prompt (never a system prompt — commit-push has none persisted). Only the
 * human summary/body language flips; the Conventional-Commits `<type>(<scope>):`
 * prefix stays lowercase ASCII (locked by test). en-US string is appended even
 * by default so the ASCII-prefix rule is stated explicitly in both modes.
 */
export const COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE: Readonly<Record<Language, string>> = {
  'en-US':
    'Write the commit message summary and body in English. Keep the Conventional-Commits `<type>(<scope>):` prefix in lowercase ASCII (e.g. feat(auth):).',
  'zh-CN':
    '提交信息的摘要与正文用简体中文书写。Conventional-Commits 的 `<type>(<scope>):` 前缀保持小写 ASCII（如 feat(auth):），不要翻译类型词与范围词。',
} as const
```

`buildCommitMessagePrompt` / `buildRepairPrompt` 各加一个**可选** `lang?: Language` 入参
（默认 `'en-US'`，使既有无 `lang` 调用方——如 `commit-push-core.test.ts`——零改动仍编译），
在 `.join('\n')` 前把 `['', COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE[lang ?? 'en-US']]` 追加到 lines 末尾
（信封示例之后）。镜像 `memoryDistiller.ts` 711–717 行 `lines.push('', DIRECTIVE[outputLang])`。

**「未设置也追加 en-US 指令」是有意的**（Codex 设计门 P2-2 澄清）：镜像记忆提炼——distiller
`lines.push('', DIRECTIVE[input.outputLang ?? 'en-US'])` 对 en-US 默认路径同样追加。故本 RFC
**不承诺**与升级前 commit prompt 逐字节一致（那与「配置项一致」相冲）；只承诺 unset ≡ 显式 en-US
（二者逐字节相等）。en-US 指令只强化「摘要/正文英文、`<type>(scope):` 前缀 ASCII」，commit
message 仍为英文、语义不变。commit-push **无** system-prompt hash 锁（不同于 distiller），现有两段
prompt 测试用 `toContain`（`commit-push-core.test.ts` 158–190），末尾新增一行不破坏它们；新增测试
锁定「无 `lang` 调用 ≡ 显式 en-US」逐字节相等。

## 3. 数据流 / 透传链

沿用 commit-push 其它旋钮（`commitPushDiffMaxBytes` / `commitPushMaxRepairRetries`）**同一条 launch
配置链**——`resolveLaunchRuntimeConfig` 在**每次 scheduler 启动 / resume / retry / parked clarify-review
resume 时**从 live config 解析、在单次 `runTask` 运行内固定（`state.opts`）。

> **解析时机（Codex 设计门 P2 澄清）**：这**不是** distiller 那种「enqueue 冻进 `memory_distill_jobs.output_lang`
> 列、跨 resume 不变」的持久化冻结——distiller 冻结是 batch 去重的特定需求（合并同 `debounce_key` 的兄弟
> job，须 enqueue 值确定性获胜），commit-push 无 job 行、也不引入。因此一个任务若中途暂停、管理员改了
> config，其 resume/retry 的后续提交会用新语言——**与 `diffMaxBytes` / `maxRepairRetries` 等所有 commit-push
> 旋钮行为一致**（它们本就每次 kick 重读 live config）。不单独为语言引入 per-task 冻结，以免 commit-push
> 内部旋钮语义分裂——这是「面向代码最合理」的选择。链路：

1. `services/launchRuntimeConfig.ts`：
   - `resolveCommitPushConfig` 返回类型 + body 加 `lang?: Language`：`if (cfg.commitPushLang !== undefined) out.lang = cfg.commitPushLang`。
   - `resolveLaunchRuntimeConfig` 的 `commitPush` 形状（类型注解 + `out` 对象两处）加 `lang?: Language`。
2. `services/task.ts`：
   - `StartTaskDeps.commitPush` 类型（137 行）加 `lang?: Language`。
   - `runtimeConfigOpts`（509 行起，start/resume/retry 三处 `...runtimeConfigOpts(deps)` 共用的真funnel）
     加一行：`...(deps.commitPush?.lang !== undefined ? { commitPushLang: deps.commitPush.lang } : {})`。
3. `services/scheduler.ts`：
   - `RunTaskOptions` 加 `commitPushLang?: Language`（挨着 `commitPushDiffMaxBytes`，~234 行）。
   - `runCommitPush` 调用点（~1143）：在两个闭包外解析一次
     `const commitPushLang = state.opts.commitPushLang ?? 'en-US'`，把 `lang: commitPushLang`
     传进 `buildCommitMessagePrompt({...})` 与 `buildRepairPrompt({...})` 两处。

`Language` 类型：`commitPush.ts`/`task.ts`/`scheduler.ts`/`launchRuntimeConfig.ts` 从
`@agent-workflow/shared` 导入（`launchRuntimeConfig` 经 `loadConfig` 已有 config 类型，直接引 `Language`）。

## 4. 前端（`routes/settings.tsx` + i18n）

镜像记忆卡输出语言下拉框（settings.tsx 769–784 行 `memoryDistillLang` 那段）：

- `SYSTEM_AGENT_CONFIG_KEYS`（588 行）加 `'commitPushLang'` ⇒ slice 由 9→10 键；`configDirty` 自动纳入。
- 提交推送 `AgentCard`（713–751）在 diff/retries 那个 `form-grid` 之后加一个 `<Field>` + `<Select>`：
  ```tsx
  <Field label={t('settings.commitPushLangLabel')} hint={t('settings.commitPushLangHint')}>
    <Select<'' | NonNullable<Config['commitPushLang']>>
      data-testid="settings-commit-push-lang-select"
      ariaLabel={t('settings.commitPushLangLabel')}
      value={state.commitPushLang ?? ''}
      // Default 发 null（非 undefined）→ mergePatch 真正 delete 已存值（Codex P2-1）。
      onChange={(v) => setState({ ...state, commitPushLang: v === '' ? null : v })}
      options={[
        { value: '', label: t('settings.commitPushLangDefault') },
        { value: 'en-US', label: t('settings.commitPushLangEnUS') },
        { value: 'zh-CN', label: t('settings.commitPushLangZhCN') },
      ]}
    />
  </Field>
  ```
  复用既有公共 `<Select>`（RFC-036）与 `<Field>` 原语，零新增 CSS——满足前端统一风格强制原则。
  `state.commitPushLang` 现类型为 `Language | null | undefined`（patch nullable），`?? ''` 把 null/undefined
  都渲染成「Default」。
- **随行修记忆卡下拉框**（同文件 777 行）：`memoryDistillLang` 的 `onChange` 从 `v === '' ? undefined : v`
  改为 `v === '' ? null : v`——同款清除修复，保持两个语言下拉框一致。
- i18n：`en-US.ts` / `zh-CN.ts` 的 `settings` 命名空间加五个 key，措辞照 `memoryDistillLang*` 平移：
  - `commitPushLangLabel` = 「提交信息输出语言」 / "Commit message output language"
  - `commitPushLangHint`（说明：只影响摘要/正文语言，`<type>(scope):` 前缀保持 ASCII；独立于 UI 语言；
    默认英文；仅对新提交生效）
  - `commitPushLangDefault` = 「跟随默认（English）」 / "Default (English)"
  - `commitPushLangZhCN` = 「简体中文」 / "简体中文"；`commitPushLangEnUS` = "English"
  - `zh-CN.ts` 的类型声明块（587–591 附近，`memoryDistillLang*: string`）同步加五行。

## 5. 与现有模块的耦合点

- **RFC-156 SystemAgentsTab 的四卡单一 Save**：新下拉是 config 卡字段，走既有 `save`(config PUT)；
  `configDirty` 因 slice 加键自动感知。不触碰融合 PATCH 路径（P2a/b/c 逻辑不变）。
- **RFC-050 记忆语言**：零耦合，纯对称新增；两者共用 `LanguageSchema`。
- **fallback 模板**：`buildFallbackMessage` 不接语言开关（英文兜底，见 proposal 非目标）。

## 6. 失败模式

- 非法 `commitPushLang` 落盘：被 `ConfigSchema` 挡（zod enum），PUT 返回 422，不会污染运行期。
- config 读取失败：`resolveCommitPushConfig` 既有 `try/catch` 返回 undefined ⇒ 调度器
  `?? 'en-US'` 兜底英文，等同升级前。
- 模型忽略语言指令（产出英文/混杂）：与记忆提炼同风险，不是硬失败——commit message 仍可用；
  指令是「best-effort 引导」，非机器协议。fallback/结构不受影响。

## 7. 测试策略（Test-with-every-change 必写清单）

1. **shared** `config-rfc157-commit-push-lang.test.ts`（镜像 `config-rfc050.test.ts`）：
   `commitPushLang` 基础 schema 接受 `zh-CN`/`en-US`、省略 undefined、拒空串/非法/非字符串；
   **`ConfigPatchSchema` 接受 `null`（清除）与 `zh-CN`，基础 `ConfigSchema` 拒 null**（P2-1 锁）；
   `DEFAULT_CONFIG.commitPushLang` 为 undefined。`memoryDistillLang` 的 patch nullable 同锁一条
   （可并入 `config-rfc156.test.ts` 的 nullable 键列表，或本文件补测）。
2. **backend** `commit-push-output-lang-directive.test.ts`（镜像 `memory-distiller-output-lang-directive.test.ts`）：
   - D1：`buildCommitMessagePrompt` 无 `lang` / `lang:'en-US'` 两次产出**逐字节相等**，且末尾含英文指令。
   - D2：`lang:'zh-CN'` 末尾为中文指令。
   - `buildRepairPrompt` 同上两 case。
   - 指令是 prompt 的**最后一段**（`endsWith` 断言）；两版指令都含 ``«`<type>(<scope>):` … ASCII»`` 文案。
3. **backend** 透传锁：`launchRuntimeConfig` 层——断言 `resolveCommitPushConfig({commitPushLang})`
   surface 出 `lang`（若已有 launchRuntimeConfig 测试文件则加 case，否则新建轻量单测）；
   `toRunTaskOptions` 把 `deps.commitPush.lang` 映射为 `commitPushLang`。（runTask 全链 e2e 过重不建，
   源码层 + 单元层双锁足够——参照 RFC-141 e2e 文件头「三层覆盖依据」判断。）
4. **frontend** `settings-commit-push-lang.test.tsx`（镜像 `settings-memory-distill-lang.test.tsx`）：
   渲染三选项 + testid、反映 config、选 zh-CN 保存 PUT body 带 `commitPushLang:'zh-CN'`、
   **选 Default 保存 PUT body 带 `commitPushLang === null`（严格断言，锁 P2-1 清除；不接受「null 或缺省」二择一）**、
   i18n key 双语可达。**顺带把现有 `settings-memory-distill-lang.test.tsx` 的「选 Default」case 收紧为
   断言 `=== null`**（原为二择一、掩盖了清不掉的隐患）并更正其「backend stores NULL」注释。
5. **frontend grep 锁**：`settings-system-agents.test.ts` 的 slice-key 列表加 `'commitPushLang'`
   （「9 键」措辞更新为 10）。`settings-commit-push.test.ts` 若断言卡片字段集，补一条 lang 断言。
6. 视觉基线：提交卡多一行下拉，属 settings.png 变化——按 RFC-155/156 流程 darwin 本机
   `--update-snapshots=all` 强刷 + linux 走 visual-regression dispatch 取 CI 实渲（若像素差触发）。

## 8. 迁移

无 DB migration（纯 config.json 字段，`loadConfig` 对未知/缺失 key 已容忍）。无 journal 变动。
