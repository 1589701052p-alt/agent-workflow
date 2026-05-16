# RFC-019 Skill ZIP 批量导入

> 状态：Draft  
> 关联：RFC-017（Skill 父目录批量纳管 / `skill_sources` 表与 lazy 扫描）；RFC-018（agent.md 导入复用 frontmatter parser 与冲突处理 UI 范式）

## 背景

当前 `/skills/new` 只能：

1. **Form**：手动填字段 → 落到 `~/.agent-workflow/skills/{name}/files/SKILL.md`
2. **Folder**：登记一个父目录，由 `skill_sources` lazy 扫描其下的子 skill（external 形式，DB 不写文件）
3. **External**：直接登记一个已有 skill 目录（external 形式）

社区里 skill 经常以 zip 形式分发（一份压缩包内可能装一个 skill，也可能装一整套）。
现在用户拿到 zip 必须先手动解压、找到 skill 目录、再决定 Folder/External/Form 哪条路径，且每个 skill 都要重复一次。
没有"上传一个 zip，平台自己拆开、按 managed 形式落盘"的入口。

## 目标

- 支持在 `/skills/new` 选择 **Upload ZIP** 入口，单次操作导入 zip 内所有 skill
- 所有导入的 skill 落 **managed**（拷贝到 `~/.agent-workflow/skills/{name}/files/`），不依赖原 zip 或外部路径
- 与 DB 已有同名 skill 冲突时弹对话框逐项决策（与 workflow YAML 导入风格一致）
- 解析失败 / 安全风险（zip slip 等）显式报错，不静默吞

## 非目标

- **不支持顶层就是 skill 本身的 zip**（即顶层直接是 `SKILL.md` + 资源文件）。  
  根据用户决策：skill 是一个目录，不是单个 SKILL.md 文件。zip 必须打成"目录套目录"结构，每个 skill 是其自己的目录。
- 不支持导入为 external 类型（external 形式让用户走现有 Folder/External 路径）
- 不支持导出 skill 为 zip（独立需求，按需另起 RFC）
- 不更新 `skill_sources`（zip 导入是一次性快照，不持续跟随）

## ZIP 结构契约

解压后必须呈现两层目录中之一：

**形式 A —— 顶层即 skill 目录们（推荐）**

```
my-skills.zip
├── skill-foo/
│   ├── SKILL.md
│   └── reference/...
└── skill-bar/
    ├── SKILL.md
    └── ...
```

**形式 B —— 顶层有一个 wrapper 目录（兼容 macOS Finder / 部分压缩工具的"打包整个文件夹"行为）**

```
my-skills.zip
└── my-skills/                  ← wrapper（非 skill）
    ├── skill-foo/
    │   └── SKILL.md
    └── skill-bar/
        └── SKILL.md
```

判定规则（详见 design.md §3）：解压顶层若**只有一个目录条目**且**该目录内不含 SKILL.md**，按形式 B 处理（剥掉 wrapper）；否则按形式 A 处理。

不接受的 zip：

- 顶层散落文件（`SKILL.md` 直接在根）→ 报错"skill 必须是目录"
- 候选 skill 目录里没有 `SKILL.md` → 该项报错并在 UI 列出
- 路径含 `..` 或绝对路径 → 整包拒绝（zip slip 防御）
- 单文件 / 总解压大小 / 条目数超过限额 → 整包拒绝
- 含 symlink entry → 整包拒绝

## 用户故事

1. 用户在 `/skills/new` 切到 **Upload ZIP** tab，选 `pack.zip`，点 **Parse**。
2. 后端解析后返回候选 skill 列表：`[ {name, description, fileCount, conflict?}, ... ]` + 整包级 errors（如有）。
3. 前端显示表格：每行一个候选 skill；右侧字段在冲突时显示 select：**Skip / Overwrite / Rename**，Rename 选中后展开 input 校验新名。
4. 用户审完，点 **Import N skills**：浏览器把 zip + 决策表一起 POST 到 commit 端点。
5. 后端按决策落盘 + 写 DB；返回 `{ created, updated, skipped, failed }` 摘要。前端跳回 `/skills` 列表并 toast。

## 验收标准

- 形式 A / B 两类 zip 都能正确识别并导入
- 只含一个 skill 的 zip 也能走通（目录里有 SKILL.md，无 wrapper 也行）
- 导入后 skill 是 managed 形式，磁盘上位于 `~/.agent-workflow/skills/{name}/files/SKILL.md` 与原资源文件
- DB 同名 skill 命中：Skip 不动 / Overwrite 重写文件 + DB description / Rename 改名后落盘
- DB 同名但是 external 形式：UI 强制 Skip（不允许 overwrite，显式 disabled + 解释文案）
- ZIP 内重名（两个目录都叫 `foo/`）→ parse 阶段报错，整包不可导入
- frontmatter 解析失败的 SKILL.md：候选项进 errors 列表，其它正常 skill 不受影响
- zip slip / symlink / 超限：parse 阶段整包拒绝，commit 不可达
- 部分 skill 落盘失败：该 skill 进 `failed`，其它 skill 已落的不回滚（最终一致的语义在摘要里说明）
- 导入完成后 `/skills` 列表立即看到新增 skill；现有 `runner.ts` / `runtime.ts` skill 注入流程零改动可用

## 与 RFC-017 / RFC-018 的关系

- **RFC-017** 提供了 external skill `sourceKind` + `skill_sources` lazy 扫描；本 RFC 的 zip 导入只走 `sourceKind = managed`，不写 `skill_sources`，互不影响。
- **RFC-018** 已经引入"上传/粘贴 + 字段对照表预览 + 冲突提示"的 UI 范式（`AgentImportDialog`）；本 RFC 的前端冲突决策表沿用同一视觉语言但不复用组件（数据维度不同：单条 agent vs N 条 skill）。
- frontmatter 解析复用 `packages/shared/src/agent-md.ts` 同款做法（YAML + body 拆解 + graceful fallback），新建 `packages/shared/src/skill-md.ts` 与 `parseSkillZip` 纯函数。
