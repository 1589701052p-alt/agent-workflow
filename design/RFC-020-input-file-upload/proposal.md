# RFC-020 Input 节点支持本地文件上传（`upload` kind）

> 状态：Draft
> 关联：RFC-004（Input 节点端口契约统一 — scheduler portName=inputKey）；P-2-10 stage 2 `FilesPicker` 现有 `kind: 'files'`（仅选 worktree 内已有路径）

## 背景

当前 workflow 启动表单里关于"文件"的输入只有 `kind: 'files'`：

- 数据源是 `git ls-files <repoPath>`（`packages/backend/src/routes/repos.ts` `GET /api/repos/files`）
- 前端是 `FilesPicker.tsx` 的多选 checkbox 列表，packed value = 换行 join 的 repo-relative paths
- 语义是"从 worktree 已有文件里挑几条路径喂给下游节点"

这覆盖不了一个高频场景：**用户手里有一份不在 repo 里的本地文件**（PDF 报告、外部 spec、参考截图、CSV 数据等），想把它丢给某个 agent 处理。

目前的绕路：用户得先手工把文件 copy 进 repo → commit 或保留为 untracked → 再回 launcher 走 `files` 选它。这把"用一次性外部素材跑一次 task"的体验拖得很重，并且会污染用户自己仓的 working tree。

我们需要一个一等公民的"本地文件上传"输入类型。

## 目标

- 新增 input kind `upload`：launcher 表单允许用户选**本地任意路径**的文件（OS 文件对话框）
- 上传时同时填一个 **repo-relative 落点目录**（如 `inputs/` 或 `tmp/agent-uploads/`），文件被物理写到 task worktree 内该相对目录下
- packed value 与 `files` kind 一致：换行 join 的 **repo-relative 路径**，下游节点用 `{{port}}` 即可拿到字符串、与 `__repo_path__` 拼起来就是真实路径
- launcher 同步上传：multipart POST 到 `/api/tasks`，后端先建 worktree → 写入文件 → 才创建 task 行；任一步失败回到现有 earlyError 路径
- 文件落进 worktree 后，下游 `wrapper-git` 节点能在 `git_diff` 输出里看到（它们就是 untracked files）
- 限制：单文件大小上限（默认 50MB，可配置）+ MIME / 扩展名白名单（per-input 声明）

## 非目标

- **不做异步 / 断点续传上传**：launcher 同步提交，5xx → 报错重试整次表单，简单优先
- **不做"workflow 级共享上传库"**：每次启动 task 独立上传一份，不跨 task 复用
- **不引入 worktree 外的私有存储**：文件必须落到 worktree 内、走 wrapper-git diff 自然观测，不维护外部 upload 区
- **不替换或修改现有 `kind: 'files'`**：两类 kind 并存，`files`=选 repo 已有，`upload`=传外部进来
- **不做服务端转码 / 缩略图 / OCR**：原样落盘，文件名以服务端二次清洗（去 `..`、路径分隔符、Unicode 规范化）后保留
- **不做认证授权**：单机本地服务，沿用现有"无鉴权"假设
- **不做 import via URL**：用户给一个 https 链接由服务端去拉的能力另起 RFC

## ZIP / 多文件场景

- launcher 允许选多个文件（`<input type="file" multiple>`），但**不解压 zip**：每个 zip 都按"一个文件"原样写入。需要打包结构的输入由 agent 自己解压（worktree 里跑 `unzip` 等命令）。
- 不限制目录上传（Chrome `webkitdirectory`）—— v1 仅支持文件级多选；如需上传整个目录，下个迭代再扩。

## 用户故事

1. 用户在 workflow editor 里把某个 Input 节点的 `definition.inputs[].kind` 设为 `upload`，并填：
   - `label`: "参考材料 PDF"
   - `targetDir`: `inputs/refs`（repo-relative，新字段）
   - `accept`: `['.pdf', '.txt']`（新字段，传给前端 `<input accept>` + 服务端二次校验）
   - `maxFileSize`: `52428800`（可选，默认走 settings 全局值）
   - `minCount` / `maxCount`: 沿用 `files` kind 同名字段
2. 用户进 `/workflows/$id/launch`，看到此输入显示为 Upload widget：
   - 一个"选择文件"按钮 + 已选文件列表 + 每条显示 `name / size / mime`
   - 一行只读说明：`将写入 worktree 的 inputs/refs/ 目录`
3. 用户点 Start。前端构造 `FormData`：JSON body 走 `payload` 字段，二进制走 `files[<inputKey>][]` 字段。
4. 后端 `POST /api/tasks`（multipart 分支）：
   - 校验文件数 / 大小 / 扩展名 / MIME
   - 跑现有 `createWorktree`
   - 把每个文件写到 `worktreePath/<targetDir>/<sanitized-filename>`
   - 写入失败 → task 行进 `failed` + earlyError（与 worktree 失败同处理）
   - 成功 → task 的 `inputs` 字段记录最终 repo-relative paths（与 `files` 一致的 packed string）
5. task 启动后，下游 agent 通过 prompt template `{{port_name}}` 拿到换行分隔的 paths；`wrapper-git` 节点的 `git_diff` 输出自然包含这批 untracked files。

## 验收标准

- WorkflowInput schema 新增 `kind: 'upload'` 且承载 `targetDir` / `accept` / `maxFileSize` / `minCount` / `maxCount` 字段；shared zod 守住、loose passthrough 不变其它 kind 行为
- editor 的 NodeInspector / WorkflowInput 编辑表单能新建 / 编辑 `upload` 类型，并在 `targetDir` 缺失时报红
- launcher 同一个 input 节点：勾选了文件 → Start 按钮按现有逻辑（必填 / minCount / maxCount）启用
- 后端 `POST /api/tasks` 支持 multipart：JSON body 必须在 `payload` 字段里，文件必须在 `files[<inputKey>][]` 字段里，否则 400
- 文件写盘失败（磁盘满 / 权限 / 路径冲突）→ task 进 `failed` + earlyError + 不留 partial 文件（同名旧文件不覆盖，已写新文件回滚删除）
- 文件名安全：
  - 服务端把 `\\` `/` `..` 全部剥离；空字符串名 → 自动改名 `upload-<idx>.bin`
  - 同 `targetDir` 已有同名文件 → 在 stem 后加 ` (1)` ` (2)` …递增直到不冲突，packed value 中给真正写入后的最终名
- `accept` 白名单：扩展名 lower-case 匹配；MIME 同时校验（服务端用 `file-type` 嗅探，不信任 client `mime`）
- 默认 `maxFileSize=50MiB`、`maxTotalSize=200MiB`、`maxFileCount=20`；用户 settings.json 可全局覆盖（追加 `uploadLimits.{perFile,perRequest,perCount}`）
- 上传文件最终位于 `worktreePath/<targetDir>/<finalName>`，且 `wrapper-git` 节点跑完后 `git_diff` 输出能看到这些文件（grep 校验测试）
- 整个 launcher 上传流程在 e2e 测试里有覆盖：上传 1 个小 .txt → 启动 task → 校验 worktree 实际有这个文件

## 与 RFC-004 / 现有 `files` 的关系

- **沿用 RFC-004 的 scheduler 端口约定**：`portName == inputKey`，runner 通过 `{{inputKey}}` 取换行字符串
- packed value 与 `kind: 'files'` 完全同构（换行 join 的 repo-relative paths），下游 agent / wrapper / multi-process 节点零感知
- 现有 `FilesPicker` 不动，只新增 `UploadPicker` 组件并在 `DynamicInput` 里多一个 `kind === 'upload'` 分支
- editor `NodeInspector` 的 input-form 加 `upload` 选项 + 新字段表单

## 失败模式回顾

| 场景                   | 处理                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| 总大小超 `maxTotalSize` | 400，task 不创建                                                  |
| 单文件超 `maxFileSize`  | 400，task 不创建                                                  |
| 扩展名 / MIME 不匹配   | 400，task 不创建                                                  |
| `targetDir` 含 `..`    | 400（editor 也阻止保存），task 不创建                             |
| createWorktree 失败    | 沿用现有 earlyError 路径，已上传文件原地丢弃                      |
| 写盘部分失败           | 滚回已写入的新文件，task 进 failed + earlyError 说明哪一步炸了    |
| 浏览器中断上传         | Hono / Bun multipart 读取异常 → 500，task 不创建                  |
