# RFC-002 Design — Add Agent 表单从 Runtime 默认值快照

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 总览

实现三件事：

1. **shared/config schema 加两字段** —— `defaultSteps` / `defaultMaxSteps`，optional 正整数；Settings → Runtime 标签页加对应 NumberInput。
2. **AgentForm Model & snapshot 改造** ——
   - Model 字段从 `<TextInput>` 改成复用 `ModelSelect` 组件（已存在，无需新写）。
   - 在 `agents.new.tsx` 路由层做**一次性 snapshot**：mount 时拉 `/api/config`，把 `defaultModel / defaultVariant / defaultTemperature / defaultSteps / defaultMaxSteps` 拷进 `useState<CreateAgent>` 初值。
   - `agents.detail.tsx`（编辑现有 agent）**不动**——已保存值直接渲染。
3. **Skills 字段增加"从已有 skill 选择"下拉** —— 新建 `<SkillsPicker>` 组件：上方一行 `<select>` 列出 `/api/skills` 当前所有 skill，选中即把名字 push 进现有 chips；下方仍是 `<ChipsInput>` 兜底自由输入。`AgentForm` 把当前 `<ChipsInput value={skills}>` 换成这个新组件；对 `agents.new` 和 `agents.detail` 同时生效。

## 2. 改动文件清单

后端：

- `packages/shared/src/schemas/config.ts` — 加 2 字段。
- 无后端代码改动（runner / scheduler / agent.service 已经会读 agent.steps/maxSteps；config 的新默认值字段对运行时透明，仅前端表单消费）。

前端：

- `packages/frontend/src/components/AgentForm.tsx` — Model 字段换 ModelSelect；Skills 字段从裸 `ChipsInput` 换成新的 `SkillsPicker`。
- `packages/frontend/src/components/SkillsPicker.tsx` — **新增**。封装 `<select>` + 既有 `<ChipsInput>`，自带 `useQuery(['skills'])`。
- `packages/frontend/src/routes/agents.new.tsx` — 用 `useQuery(['config'])` 拿当前 config，mount 后一次性把默认值拷进 `useState` 初值。
- `packages/frontend/src/routes/settings.tsx` — RuntimeTab 加 `defaultSteps` / `defaultMaxSteps` 两个 NumberInput；`useTabState` 的 keys 数组加这两项。
- `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts` — 加 `settingsForm.defaultSteps / defaultStepsHint / defaultMaxSteps / defaultMaxStepsHint` 四条 + `agentForm.skillsPickerLabel / skillsPickerLoading / skillsPickerEmpty / skillsPickerLoadFailed` 四条 key。

测试：

- `packages/backend/tests/config.test.ts`（若存在）— 增加 1 case：旧 config（缺 defaultSteps / defaultMaxSteps）能加载并补 `undefined`；新字段往返。如不存在，建 minimal case 在 shared 包测。
- `packages/frontend/tests/agent-form.test.tsx`（新或扩） — case：
  - `AgentForm` 渲染 Model 字段时是 `<select>`（ModelSelect 标志）；
  - 给 prop `value.model = 'foo/bar'` 时下拉 `Custom…` 模式 + TextInput 回填 `foo/bar`（沿用 ModelSelect 既有行为，只需冒烟）。
- `packages/frontend/tests/agents-new-snapshot.test.tsx`（新） — case（详见 §7）：
  - config resolve 后五项 prefill；
  - 用户先动 model → 后到 config 不覆盖；
  - 编辑现有 agent 路由不 prefill；
  - config 失败不阻塞表单。
- `packages/frontend/tests/skills-picker.test.tsx`（新） — case：
  - mock `/api/skills` 返回 ['a','b','c']，下拉项有 3 个 + placeholder；
  - 选 `b` → onChange 收到 `[...existing, 'b']`；
  - 选 `b` 但 `existing` 已含 `b` → onChange 不被调用（或调用值不变）；
  - mock `/api/skills` 列表为空 → 下拉禁用 / 显示空选项 placeholder；
  - mock `/api/skills` 失败 → 下拉降级（只渲染 ChipsInput + muted 错误文字），自由 chip 输入仍可用。

预估增量：

- 后端：~10 LoC（schema 2 字段）
- 前端：~210 LoC（agents.new 改造 + settings.tsx 两 Field + AgentForm 两字段切换 + SkillsPicker 新组件 ~70 LoC + i18n 16 行）
- 测试：~220 LoC

## 3. Shared/Config schema 变更

`packages/shared/src/schemas/config.ts`：

```ts
export const ConfigSchema = z.object({
  // ... existing fields ...
  defaultModel: z.string().min(1).optional(),
  defaultVariant: z.string().min(1).optional(),
  defaultTemperature: z.number().min(0).max(2).optional(),
+ defaultSteps: z.number().int().positive().optional(),
+ defaultMaxSteps: z.number().int().positive().optional(),
  // ... rest unchanged ...
})
```

`DEFAULT_CONFIG` **不**给这两项填值（保持与 `defaultModel/Variant/Temperature` 一致——都是 optional 缺省）。`ConfigPatchSchema` 自动获得这两字段（`.partial()`）。

`/api/config` 路由与 services/config 都基于 zod schema 工作，无需额外改动；老的 config.json 缺字段时 zod optional 会 fallback 到 `undefined`。

## 4. Settings → Runtime UI 变更

`packages/frontend/src/routes/settings.tsx` 的 `RuntimeTab`：

```ts
const { state, setState, ... } = useTabState(config, [
  'opencodePath',
  'defaultModel',
  'defaultVariant',
  'defaultTemperature',
+ 'defaultSteps',
+ 'defaultMaxSteps',
  'maxConcurrentNodes',
  'multiProcessSubprocessConcurrency',
  'logLevel',
])
```

在 `defaultTemperature` Field 下方追加：

```tsx
<Field label={t('settingsForm.defaultSteps')} hint={t('settingsForm.defaultStepsHint')}>
  <NumberInput value={state.defaultSteps} onChange={(v) => setState({ ...state, defaultSteps: v })} min={1} />
</Field>
<Field label={t('settingsForm.defaultMaxSteps')} hint={t('settingsForm.defaultMaxStepsHint')}>
  <NumberInput value={state.defaultMaxSteps} onChange={(v) => setState({ ...state, defaultMaxSteps: v })} min={1} />
</Field>
```

i18n（zh-CN / en-US 双语对齐）：

| key | zh-CN | en-US |
| --- | --- | --- |
| `settingsForm.defaultSteps` | `默认 steps` | `Default steps` |
| `settingsForm.defaultStepsHint` | `新建代理时默认填入此值；留空走 opencode 内置默认。` | `Pre-filled when creating a new agent; leave blank to fall back to opencode's built-in default.` |
| `settingsForm.defaultMaxSteps` | `默认 max steps` | `Default max steps` |
| `settingsForm.defaultMaxStepsHint` | 同上（`max steps`） | 同上 |

## 5. AgentForm Model 字段切换

`packages/frontend/src/components/AgentForm.tsx`：

```diff
- <Field label={t('agentForm.fieldModel')}>
-   <TextInput
-     value={value.model ?? ''}
-     onChange={(v) => patch('model', v === '' ? undefined : v)}
-     placeholder={t('agentForm.modelPlaceholder')}
-   />
- </Field>
+ <Field label={t('agentForm.fieldModel')}>
+   <ModelSelect value={value.model} onChange={(v) => patch('model', v)} />
+ </Field>
```

ModelSelect 的 onChange 已经吐 `string | undefined`，与 `patch('model', v)` 签名直接吻合。无需任何 ModelSelect 内部改动。

Variant / Temperature / Steps / MaxSteps 控件保持现状（TextInput / NumberInput），仅靠初值 snapshot 起作用。

## 6. Snapshot 逻辑（关键）

放在 `agents.new.tsx` 路由组件而非 `AgentForm`，原因：

- AgentForm 是 controlled 组件，初值来自父级。把 snapshot 放父级避免在 `agents.detail.tsx`（同样消费 AgentForm）也意外触发。
- `useQuery(['config'])` 在 react-query cache 里命中 Settings 已有的同 key 查询，**零额外网络请求**（staleTime 默认走 settings 路由已存在的 0 / Infinity 配置；这里只读 `data` 即可）。

`agents.new.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query'
import type { Config } from '@agent-workflow/shared'
import { useEffect, useRef, useState } from 'react'
// ...

export function NewAgent() {
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
    staleTime: 30_000, // cheap snapshot; ok to refetch occasionally
  })
  const [draft, setDraft] = useState<CreateAgent>(() => emptyAgent())
  const snapshottedRef = useRef(false)

  useEffect(() => {
    if (snapshottedRef.current) return
    if (!config.data) return
    snapshottedRef.current = true
    setDraft((prev) => applyDefaults(prev, config.data))
  }, [config.data])

  // ... rest of route unchanged ...
}

/** Apply Runtime defaults to a draft only for fields the user hasn't touched. */
export function applyDefaults(draft: CreateAgent, cfg: Config): CreateAgent {
  const next: CreateAgent = { ...draft }
  if (draft.model === undefined && cfg.defaultModel) next.model = cfg.defaultModel
  if (draft.variant === undefined && cfg.defaultVariant) next.variant = cfg.defaultVariant
  if (draft.temperature === undefined && cfg.defaultTemperature !== undefined)
    next.temperature = cfg.defaultTemperature
  if (draft.steps === undefined && cfg.defaultSteps !== undefined) next.steps = cfg.defaultSteps
  if (draft.maxSteps === undefined && cfg.defaultMaxSteps !== undefined)
    next.maxSteps = cfg.defaultMaxSteps
  return next
}
```

**关键不变量**：

- `snapshottedRef.current` 一旦置 true 永不回 false → snapshot 严格一次性。
- `applyDefaults` 只填**当前为 undefined** 的字段 → 用户已经手敲的输入不会被覆盖（哪怕 ref 守卫失败也兜底）。
- 用户后续清空字段（输 → 删空）→ patch 把字段置回 `undefined` → snapshot 已经发生过、`snapshottedRef.current = true`，不会再回填。这就是用户故事 U3 想要的语义（清空意味着确实想清空）。
- 编辑现有 agent（`agents.detail.tsx`）不挂这段 effect，draft 由 `agentToDraft(loadedAgent)` 初始化，纯粹来自后端。

`applyDefaults` 单独 export 让单测能不挂 react-query 直接跑。

## 6.5 SkillsPicker 组件

`packages/frontend/src/components/SkillsPicker.tsx`（新）：

```tsx
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ChipsInput } from './ChipsInput'

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function SkillsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  const list = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const available = useMemo(() => {
    const existing = new Set(value)
    return (list.data ?? []).filter((s) => !existing.has(s.name))
  }, [list.data, value])

  const failed = list.error !== null && list.error !== undefined

  return (
    <div>
      {!failed && (
        <select
          className="form-input"
          value=""
          disabled={list.isLoading || available.length === 0}
          onChange={(e) => {
            const name = e.target.value
            if (!name) return
            if (value.includes(name)) return
            onChange([...value, name])
            // reset select to placeholder
            e.target.value = ''
          }}
          style={{ marginBottom: 6 }}
        >
          <option value="">
            {list.isLoading
              ? t('agentForm.skillsPickerLoading')
              : available.length === 0
                ? t('agentForm.skillsPickerEmpty')
                : t('agentForm.skillsPickerLabel')}
          </option>
          {available.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
              {s.description ? ` — ${s.description}` : ''}
            </option>
          ))}
        </select>
      )}
      <ChipsInput value={value} onChange={onChange} placeholder={placeholder} />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {t('agentForm.skillsPickerLoadFailed')}
        </p>
      )}
    </div>
  )
}
```

**关键不变量**：

- 下拉永远停在 placeholder（`value=""`）：选中触发 onChange 后立即手动重置 `e.target.value = ''`，让用户能连续选多个；React 受控值在下次渲染由 `value=""` 钉死。
- `available` 实时过滤掉已经在 chips 里的 skill —— 用户不会看到重复项；额外加 `value.includes(name)` 兜底防止 race。
- 列表加载失败 → 整个 `<select>` 不渲染，回退到纯 `ChipsInput`（保持自由输入这条路），下方 muted 错误文字提示。
- 空 skill 仓库 → `<select>` 仍渲染但 disabled，placeholder 改成"暂无 skill"。

**AgentForm 调用**：

```diff
- <Field label={t('agentForm.fieldSkills')} hint={t('agentForm.fieldSkillsHint')}>
-   <ChipsInput
-     value={value.skills ?? []}
-     onChange={(v) => patch('skills', v)}
-     placeholder={t('agentForm.fieldSkillsPlaceholder')}
-   />
- </Field>
+ <Field label={t('agentForm.fieldSkills')} hint={t('agentForm.fieldSkillsHint')}>
+   <SkillsPicker
+     value={value.skills ?? []}
+     onChange={(v) => patch('skills', v)}
+     placeholder={t('agentForm.fieldSkillsPlaceholder')}
+   />
+ </Field>
```

i18n（zh-CN / en-US 双语对齐）：

| key | zh-CN | en-US |
| --- | --- | --- |
| `agentForm.skillsPickerLabel` | `从已有技能中选择…` | `Pick from existing skills…` |
| `agentForm.skillsPickerLoading` | `加载中…` | `Loading…` |
| `agentForm.skillsPickerEmpty` | `暂无可选技能（已全部添加 / 仓库为空）` | `No skills available (all added or repo empty)` |
| `agentForm.skillsPickerLoadFailed` | `加载技能列表失败；仍可在下方手动输入。` | `Failed to load skill list; you can still type names below.` |

## 7. 测试策略

### 7.1 shared schema

`packages/shared/tests/config.test.ts`（或就近现有 config 测试文件）：

- case 1：`ConfigSchema.parse({ ...DEFAULT_CONFIG, defaultSteps: 10, defaultMaxSteps: 50 })` 成功，回出对应值。
- case 2：旧 config（无两项）→ `parse` 成功，两字段为 `undefined`。
- case 3：负数 / 0 / 非整数被拒。

### 7.2 backend（如已有 config 路由测试）

如果 `tests/config-routes.test.ts` 存在：

- case：PUT `/api/config` 带 `defaultSteps: 8` → 200，GET 回读 `defaultSteps === 8`。
- case：PUT 带 `defaultSteps: -1` → 422 / validation error。

### 7.3 frontend 单测

`tests/agents-new-snapshot.test.tsx` 新文件：

| case | 期望 |
| --- | --- |
| `applyDefaults` — 所有 draft 字段 undefined + config 五项全填 | 返回所有五项被填的 next |
| `applyDefaults` — draft.model 已经被用户改过 | next.model 等于 draft.model，不被 cfg.defaultModel 覆盖 |
| `applyDefaults` — config 没填 defaultSteps | next.steps 保持 undefined |
| Route render — mock useQuery returns config with defaults → mount → 表单 input 显示 prefilled 值 | RTL `getByLabelText('Temperature')` 显示 `0.2` |
| Route render — config 报错 → snapshot 不发生 | 表单字段全空、Submit 仍可用 |
| Route render — mount 时用户先 type 'X' 进 Model → 之后 config resolve | Model 字段仍是用户的 'X'（用 `act` + 异步 query mock 模拟时序）|
| `agents.detail` route — load 一个 agent.model=undefined + config 有 defaultModel → Model 仍空 | 验证 snapshot 路径未进入 detail（最简单做法：detail 路由内不引用 applyDefaults，单测断言 model 仍 undefined）|

`tests/agent-form.test.tsx` 扩或建：

| case | 期望 |
| --- | --- |
| AgentForm 渲染时 Model 控件是 `<select>` 而非 `<input type="text">` | `getByRole('combobox')` 存在 |
| 提供 value.model='foo/bar' + mock /api/runtime/models 返回不含 foo/bar → 控件回到 Custom… 模式 + TextInput 显示 foo/bar | RTL 断言 |
| AgentForm Skills 区上方渲染 SkillsPicker 的 `<select>`（mock /api/skills 有 2 项）| `getAllByRole('combobox')` 包含 skills 下拉 |

`tests/skills-picker.test.tsx`（新）：见 §2 测试清单。覆盖：选择追加、已有项过滤、空列表 disabled、加载失败降级、连续多选不卡住。

### 7.4 手工验证 checklist

1. 启动 daemon + 前端 dev：
   - Settings → Runtime 看到新两个字段，可保存。
2. 在 Settings 里把 defaultModel / defaultVariant / defaultTemperature / defaultSteps / defaultMaxSteps 五项填满，保存。
3. 打开 `/agents/new`：五项全部预填。
4. 改 Temperature 为 0.9，保存 → 跳转 detail，看到 0.9 保存生效。
5. 回 Settings 把 defaultTemperature 改成 0.1。重新打开刚才那个 agent 的 detail：依然显示 0.9（snapshot 不跟随）。
6. 打开一个全新 `/agents/new`：Temperature 字段自动是 0.1（snapshot from 当前 Settings）。
7. 在 `/agents/new` 上立刻在 Model 输入框先选 `Custom…` 输入 `foo/bar`；然后等待 / 触发 config 刷新（不应该把 Model 覆盖）—— 这条主要测 ref 守卫，理论上无回填可见现象。
8. 在 `/agents/new` 与 `/agents/$existing` 两个页面上，确认 Skills 区上方有"从已有技能中选择"下拉，选项含当前所有 skill 名；选一项 → chip 列表追加；再选同一项 → 不追加；下拉自动回到 placeholder。删一些 chip 后下拉项重新出现该 skill。`/api/skills` 返回空数组时下拉灰禁。手动停 `/api/skills` 路由（或断网）→ 刷新页面后下拉消失、纯 ChipsInput + muted 错误文字。

### 7.5 e2e

不新增 Playwright 用例（现有 e2e harness 覆盖 happy-path，足够暴露破坏性 regression）。如需补 e2e 留到本 RFC 验收后另起 issue。

## 8. 兼容性 / 迁移

- `~/.agent-workflow/config.json` 缺 `defaultSteps / defaultMaxSteps` 不报错，按 `undefined` 处理，行为完全等同当前。
- `ConfigPatchSchema` `.partial()` 自动包含新字段，PUT 端无需改造。
- 已有 agent 行不动。新 agent 行因为 snapshot 多填了几个非 NULL 列 —— 与"手动填了再保存"无任何区别。
- SkillsPicker 是纯 UX 包装，不改 `agent.skills` 持久化格式（仍是字符串数组），编辑老 agent 在新 UI 上看到的 chips 与今天完全一致。
- 回滚：删 schema 两行 + AgentForm 改回 TextInput + 删 SkillsPicker 文件 + AgentForm Skills 字段改回裸 ChipsInput + 删 i18n key → 完全回到本 RFC 之前。

## 9. 已考虑、被否决的替代方案

- **方案 A：lazy default at runtime**。让 agent.model=NULL 时，runner 在 spawn 前从 config 读 defaultModel。**否决**：违反用户明确要求"以后修改了运行时中默认值后，代理的配置不跟随改变"；且与现有 NodeInspector / runtime 行为不一致。
- **方案 B：把 snapshot 放在 AgentForm 内部**。简单，但会让 `agents.detail.tsx` 也意外触发 snapshot（违反用户问答 Q2 的选择）。除非加一个 prop 来控制——引入 prop drilling 反而更复杂。把 snapshot 放路由层更干净。
- **方案 C：snapshot 时机绑在 Submit 之前**。理论上能减少 1 次 prefill；但用户故事 U2 要求看到默认值后才决定要不要改，必须 prefill 进 UI。
- **方案 D：把 ModelSelect 内置进 AgentForm 而非依赖 prop**。本质相同；目前 ModelSelect 已经 self-contained（自己拉 `/api/runtime/models`、不依赖外部状态），直接用即可。

## 10. 参考

- RFC-001 落地的 ModelSelect：`packages/frontend/src/components/ModelSelect.tsx`
- AgentForm：`packages/frontend/src/components/AgentForm.tsx`
- agents.new 路由：`packages/frontend/src/routes/agents.new.tsx`
- Settings RuntimeTab：`packages/frontend/src/routes/settings.tsx:98-172`
- Config schema：`packages/shared/src/schemas/config.ts`
- Agent schema：`packages/shared/src/schemas/agent.ts`
- Skills 列表查询：`packages/frontend/src/routes/skills.tsx`（queryKey `['skills']`，GET `/api/skills`）
- Skill schema：`packages/shared/src/schemas/skill.ts`
- 既有 ChipsInput：`packages/frontend/src/components/ChipsInput.tsx`
