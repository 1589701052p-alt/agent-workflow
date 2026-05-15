// P-5-03 stage 1: zh-CN resource bundle.
//
// Source of truth for the Chinese UI. Keep keys flat under top-level sections
// (nav / auth / settings / errors). Newer routes can add their own section as
// we migrate them to t() — there is no migration script, but the key tree
// matches en-US 1:1.

export interface Resources {
  nav: {
    agents: string
    skills: string
    workflows: string
    tasks: string
    settings: string
    brand: string
  }
  auth: {
    title: string
    hint: string
    hintCmd: string
    hintAfter: string
    daemonUrl: string
    token: string
    tokenPlaceholder: string
    verifying: string
    connect: string
  }
  settings: {
    title: string
    hintBacked: string
    hintPatched: string
    hintRestart: string
    tabRuntime: string
    tabLimits: string
    tabGc: string
    tabNetwork: string
    tabConnection: string
    tabAppearance: string
    loading: string
    saving: string
    saved: string
    save: string
    backupTitle: string
    backupHint: string
    backupCreate: string
    backupRunning: string
    backupSavedAs: string
    themeLabel: string
    themeHint: string
    themeSystem: string
    themeLight: string
    themeDark: string
    restartRequiredTitle: string
    restartRequiredHint: string
  }
  onboarding: {
    title: string
    intro: string
    step1Title: string
    step1Body: string
    step1Cta: string
    step2Title: string
    step2Body: string
    step2Cta: string
    step3Title: string
    step3Body: string
    step3Import: string
    step3ImportRunning: string
    step3Manual: string
    step4Title: string
    step4Body: string
    step4Cta: string
    importedHint: string
    skipLink: string
  }
  common: {
    loading: string
    open: string
    delete: string
    save: string
    saved: string
    saving: string
    creating: string
    unknownError: string
    yes: string
    no: string
    details: string
    emDash: string
  }
  agents: {
    title: string
    hint: string
    newButton: string
    emptyList: string
    colName: string
    colDescription: string
    colOutputs: string
    colReadonly: string
    loadingAgent: string
    detailHint: string
    saveButton: string
    newTitle: string
    newHint: string
    createButton: string
  }
  skills: {
    title: string
    hintBefore: string
    hintManaged: string
    hintMid: string
    hintManagedPath: string
    hintBetween: string
    hintExternal: string
    hintAfter: string
    newButton: string
    emptyList: string
    colName: string
    colSource: string
    colDescription: string
    colPath: string
    newTitle: string
    newHintBefore: string
    newHintManaged: string
    newHintMid: string
    newHintExternal: string
    newHintAfter: string
    tabManaged: string
    tabExternal: string
    fieldName: string
    fieldNameHint: string
    fieldDescription: string
    fieldBody: string
    fieldExternalPath: string
    fieldExternalPathHint: string
    externalPathPlaceholder: string
    createButton: string
    deleteButton: string
    saveDescription: string
    saveBody: string
    emptyBody: string
    bodySection: string
    filesSection: string
    descHintManaged: string
    descHintExternal: string
  }
  workflows: {
    title: string
    hint: string
    newButton: string
    importButton: string
    emptyList: string
    importedAsNew: string
    workflowOverwritten: string
    importCanceled: string
    conflictPrompt: string
    colName: string
    colVersion: string
    colId: string
  }
  tasks: {
    title: string
    hint: string
    filterAll: string
    emptyList: string
    colId: string
    colStatus: string
    colStarted: string
    colRepo: string
    colError: string
    loadingTask: string
    metaWorkflow: string
    metaRepo: string
    metaWorktree: string
    metaBranch: string
    metaStarted: string
    metaFinished: string
    metaError: string
    cancelButton: string
    failedBanner: string
    jumpToFailed: string
    worktreePreserved: string
    sectionWorkflowStatus: string
    sectionNodeRuns: string
    sectionWorktreeDiff: string
    noWorkflowSnapshot: string
    noBaseCommit: string
    loadingDiff: string
    noNodeRuns: string
    colNode: string
    colIteration: string
    colRetry: string
    colDuration: string
    secondsAgo: string
    minutesAgo: string
    hoursAgo: string
  }
  errors: Record<string, string>
}

export const zhCN: Resources = {
  nav: {
    agents: '代理',
    skills: '技能',
    workflows: '工作流',
    tasks: '任务',
    settings: '设置',
    brand: 'Agent Workflow',
  },
  auth: {
    title: '连接到守护进程',
    hint: '运行 ',
    hintCmd: 'agent-workflow start',
    hintAfter: '，复制启动时打印的 token 粘贴到下方。',
    daemonUrl: '守护进程 URL',
    token: 'Token',
    tokenPlaceholder: '64 位十六进制',
    verifying: '验证中…',
    connect: '连接',
  },
  settings: {
    title: '设置',
    hintBacked: '基于 ',
    hintPatched: '。补丁通过 ',
    hintRestart: '。标注 restart 的字段需重启守护进程才生效。',
    tabRuntime: '运行时',
    tabLimits: '限额',
    tabGc: 'GC',
    tabNetwork: '网络',
    tabConnection: '连接',
    tabAppearance: '外观',
    loading: '加载中…',
    saving: '保存中…',
    saved: '已保存',
    save: '保存',
    backupTitle: '导出备份',
    backupHint:
      '将 db.sqlite + config.json + skills/ + workflows YAML 打包为 tarball，存放到 ~/.agent-workflow/backups/。不含 worktrees / runs / logs / token。',
    backupCreate: '创建备份',
    backupRunning: '正在创建备份…',
    backupSavedAs: '已保存 ',
    themeLabel: '主题',
    themeHint: '系统：跟随操作系统的浅色 / 深色偏好。',
    themeSystem: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    restartRequiredTitle: '需要重启守护进程',
    restartRequiredHint:
      '新值已写入 config.json，但 bind host / bind port 仅在下次 agent-workflow start 时生效。请在终端先 agent-workflow stop，再 agent-workflow start。',
  },
  onboarding: {
    title: '欢迎使用 Agent Workflow',
    intro: '看起来这是新仓 — 还没有任何 agent 或 workflow。跟着下面四步建一条最小流水线。',
    step1Title: '1. 创建第一个 agent',
    step1Body:
      '取名为 coder，把 outputs 设为 [code]，readonly 关闭，把 prompt body 留空或粘一段简单的指令即可。',
    step1Cta: '创建 agent →',
    step2Title: '2. （可选）添加 skill',
    step2Body:
      'Skill 是按需注入的 .md 文件 / 目录，常用于注入 prompt 模板或参考文档；本步骤不是必需的。',
    step2Cta: '管理 skill →',
    step3Title: '3. 创建 workflow',
    step3Body:
      '点下面按钮一键导入 demo（input → coder agent → output 的三节点流水线），或从空白开始自己拼。',
    step3Import: '导入 demo workflow',
    step3ImportRunning: '正在导入…',
    step3Manual: '或者新建空白 workflow →',
    step4Title: '4. 启动任务',
    step4Body:
      '到 workflows 列表点 Launch，选一个本地 git 仓 + 分支，填好 inputs，提交。任务详情页会显示节点状态、prompt、产物和 diff。',
    step4Cta: '前往 workflow 列表 →',
    importedHint: '已导入；继续前往 workflow 列表去 Launch。',
    skipLink: '跳过引导，直接打开 agent 列表 →',
  },
  common: {
    loading: '加载中…',
    open: '打开',
    delete: '删除',
    save: '保存',
    saved: '已保存',
    saving: '保存中…',
    creating: '创建中…',
    unknownError: '未知错误',
    yes: '是',
    no: '否',
    details: '详情',
    emDash: '—',
  },
  agents: {
    title: '代理',
    hint: '虚拟代理；通过 OPENCODE_CONFIG_CONTENT 在 per-run 注入。',
    newButton: '+ 新建代理',
    emptyList: '还没有代理。创建一个开始吧。',
    colName: '名称',
    colDescription: '描述',
    colOutputs: '输出端口',
    colReadonly: '只读',
    loadingAgent: '加载代理中…',
    detailHint: '代理定义；保存会写入数据库。',
    saveButton: '保存修改',
    newTitle: '新建代理',
    newHint: '数据库是唯一真值源；这不是文件路径。',
    createButton: '创建代理',
  },
  skills: {
    title: '技能',
    hintBefore: '文件系统是真值源。',
    hintManaged: 'managed',
    hintMid: ' 类型存放于 ',
    hintManagedPath: '~/.agent-workflow/skills/',
    hintBetween: '；',
    hintExternal: 'external',
    hintAfter: ' 类型按 task 运行时 symlink 进来。',
    newButton: '+ 新建技能',
    emptyList: '还没有技能。',
    colName: '名称',
    colSource: '来源',
    colDescription: '描述',
    colPath: '路径',
    newTitle: '新建技能',
    newHintBefore: '选 ',
    newHintManaged: 'managed',
    newHintMid: ' 让框架完整托管，或选 ',
    newHintExternal: 'external',
    newHintAfter: ' 注册一个已存在的技能目录。',
    tabManaged: '托管',
    tabExternal: '外部',
    fieldName: '名称',
    fieldNameHint: 'kebab-case；用于 /skills/:name URL。',
    fieldDescription: '描述',
    fieldBody: 'SKILL.md 正文 (Markdown)',
    fieldExternalPath: '外部路径',
    fieldExternalPathHint: '指向一个已存在的技能目录的绝对路径。',
    externalPathPlaceholder: '/abs/path/to/skill-dir',
    createButton: '创建技能',
    deleteButton: '删除技能',
    saveDescription: '保存描述',
    saveBody: '保存正文',
    emptyBody: '（空）',
    bodySection: 'SKILL.md 正文',
    filesSection: '文件',
    descHintManaged: '可编辑；写入 SKILL.md frontmatter。',
    descHintExternal: '外部技能描述（仅写库）。',
  },
  workflows: {
    title: '工作流',
    hint: '由 agents 与 wrapper 构成的 DAG。每次启动 task 会快照当前 definition。',
    newButton: '+ 新建工作流',
    importButton: '导入 YAML',
    emptyList: '还没有工作流。',
    importedAsNew: '已作为新工作流导入。',
    workflowOverwritten: '工作流已覆盖。',
    importCanceled: '导入已取消。',
    conflictPrompt: 'Workflow id 冲突。输入 "overwrite" 覆盖，或 "new" 作为新工作流导入。',
    colName: '名称',
    colVersion: '版本',
    colId: 'ID',
  },
  tasks: {
    title: '任务',
    hint: '任务在隔离的 git worktree 中运行。点击行查看节点状态与 worktree diff。',
    filterAll: '全部',
    emptyList: '没有匹配当前过滤的任务。',
    colId: 'ID',
    colStatus: '状态',
    colStarted: '开始',
    colRepo: '仓库',
    colError: '错误',
    loadingTask: '加载任务中…',
    metaWorkflow: '工作流',
    metaRepo: '仓库',
    metaWorktree: 'Worktree',
    metaBranch: '分支',
    metaStarted: '开始',
    metaFinished: '完成',
    metaError: '错误',
    cancelButton: '取消任务',
    failedBanner: '任务失败。',
    jumpToFailed: '跳到失败节点 ({{nodeId}})',
    worktreePreserved:
      'Worktree 仍保留在 {{path}}。可手动检查；结束后执行 git worktree remove 清理。',
    sectionWorkflowStatus: '工作流状态',
    sectionNodeRuns: '节点运行',
    sectionWorktreeDiff: 'Worktree diff',
    noWorkflowSnapshot: '没有工作流快照。',
    noBaseCommit: '未记录 base commit；diff 不可用。',
    loadingDiff: '加载 diff 中…',
    noNodeRuns: '还没有节点运行；调度器还未触达任何节点。',
    colNode: '节点',
    colIteration: '轮次',
    colRetry: '重试',
    colDuration: '耗时',
    secondsAgo: '{{n}} 秒前',
    minutesAgo: '{{n}} 分钟前',
    hoursAgo: '{{n}} 小时前',
  },
  // Error codes thrown by the backend (DomainError family + transport).
  errors: {
    'http-401': '未授权 — 请重新登录并粘贴 token。',
    'http-404': '资源不存在。',
    'http-409': '存在冲突，请刷新后重试。',
    'route-not-found': '路由不存在。',
    'task-not-cancelable': '该任务已结束，无法取消。',
    'task-not-resumable': '该任务还在运行或未失败，无法 resume。',
    'task-still-running': '任务还在运行，请先取消。',
    'workflow-import-conflict': '导入冲突：已存在同 id 的工作流。',
    'config-invalid': '配置不合法。',
    'task-invalid': '任务输入不合法。',
    fallback: '请求失败',
  },
}
