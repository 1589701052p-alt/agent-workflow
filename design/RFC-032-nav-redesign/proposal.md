# RFC-032 — 导航重构：顶栏 Tab + 子导航 + 全局收件箱

> **Mockup 参考**：
>
> - [`mockups/layout-a.html`](./mockups/layout-a.html) —— 备选方案 A：分组侧栏（**未采用**，保留作为后续可比较的对照参考）。
> - [`mockups/layout-b.html`](./mockups/layout-b.html) —— **本 RFC 采纳方案**：顶栏 Tab + 子导航 + 浮窗收件箱 + 右上齿轮 settings。
>
> 两份 mockup 自带主题切换按钮，本地浏览器直接 open 可查看 light/dark 两态。

## 背景

当前侧栏是**10 项平铺**的扁平结构：

```
代理 · 技能 · MCP · 插件 · 工作流 · 任务 · 评审 · 反问 · 远端仓 · 设置
```

新用户看到这十项无法立刻分辨"哪些是同类、谁服务谁、什么时候该用谁"：

1. **技能 / MCP / 插件本质上是代理的能力包**（dependsOn 闭包后注入到 opencode 子进程），但侧栏把它们摆成并列业务对象，让新人误以为是三个独立的产品。
2. **评审 / 反问都是"工作流卡住等人介入"**，是同一类心智事件（GitHub Notifications 风格），却拆成两个独立入口、两个独立 badge，新人看不出它们的共性。
3. **远端仓是任务运行的环境**（task worktree 的源），但作为顶级条目和"任务"并列，让人以为是某个一级业务。
4. **运行时（opencode 二进制 + 版本）是代理跑起来的算力提供方**，目前藏在 Settings → Runtime 卡片里，新人不知道它存在；也无法一眼看到 daemon 是不是健康、是不是用错版本。
5. 侧栏顶部空间被 10 行占满，工作流编辑器场景下视觉重量过大；画布旁本来左侧已有 palette，再压一条平铺侧栏让视觉层级压不下来。

## 目标

让新用户**第一眼就看出心智结构**：

- 一级心智组：**代理 · 工作流 · 任务**（3 个主流程；设置不算业务一级，挪到右上 chip 区做齿轮入口）。
- 每个一级组下面的二级条目讲清"谁服务谁"：代理组下面是"代理 / 它的能力 / 它的算力"；任务组下面是"任务 / 任务的执行环境"。
- 评审 + 反问 合并成一个**全局收件箱**入口，单一红点 = 单一行动信号，符合 GitHub / Linear / Vercel 用户的肌肉记忆。
- 运行时（opencode）状态以**全局 chip** 形式常驻顶栏右上，daemon down / 版本不匹配时一眼可见。
- 不引入新的后端 / DB 改动；URL 路由保留（书签和 e2e 不破）。

## 非目标

- 不重构页面内部布局（agents 列表 / workflow editor / task detail / review detail 等保持现状）；本 RFC 只动 **app shell（外壳）**。
- 不合并 reviews 与 clarify 的 DB 表 / API；只在前端把它们组合成一个"收件箱"视图。
- 不引入移动端响应式布局；目标分辨率仍是 ≥1280px 桌面。
- 不做用户偏好（"折叠侧栏 / 收起 chip"）持久化；v1 用默认布局。
- 不动现有侧栏 brand SVG / 主题切换 / 语言切换的功能逻辑（只换位置）。

## 用户故事

- **作为一个刚装完 daemon 的新用户**，我希望打开页面就能从顶栏看出"代理→工作流→任务"是主流程，"设置"只是辅助入口放在右上角，而不是面对 10 个看上去同级的入口陷入选择困难。
- **作为一个正在排查代理跑不起来的用户**，我希望抬头就能看到 opencode runtime 是不是 ready、版本是多少，而不是要绕到 Settings 才能确认。
- **作为一个被 workflow 反问 / 评审卡住的用户**，我希望左下角红点告诉我有多少件事在等我，点一下能直接进收件箱处理，而不是分别去看 reviews 列表和 clarify 列表。
- **作为一个绑定能力的用户**，我希望知道"技能 / MCP / 插件"都是挂到代理身上的，去"代理"组下面找它们，而不是把它们当成顶级产品来理解。
- **作为一个老用户**，我打的旧书签（`/skills`, `/reviews/{id}` 等）仍能直接跳到对应页，不被改版破坏。

## 验收标准

布局：

1. 顶栏一行（高 56px）：左侧 brand → 一级 tab 组（代理 / 工作流 / 任务）→ 右侧 chip 区（runtime · 收件箱 · 语言 · 主题 · ⚙ 设置）。
2. 一级 tab 选中时下方出现子导航条（高 44px）。子导航条只显示**当前一级**对应的二级项；切一级 tab 时整条子导航替换。
3. 子导航分组规则（v1 固定）：
   - **代理**：代理 / 技能 / MCP / 插件 / · / 运行时
   - **工作流**：工作流
   - **任务**：任务 / 远端仓
4. 一级 tab "工作流" 下子导航只有一项时仍渲染子导航条（占位保持页面位置稳定），但视觉上单项不强调高亮。
5. 右上 ⚙ 齿轮按钮点击直跳 `/settings`；落在 `/settings` 路由下时齿轮按钮加 active 视觉（描边色变 accent），三个一级 tab 均不高亮、不渲染子导航条（子导航条整体消失，**让出垂直空间**，因为 settings 页本身有内部 tab）。

收件箱：

6. 顶栏右上 chip 显示 `收件箱 [N]`，N = `reviews/pending-count` + `clarify/pending-count` 之和；N=0 时不显示 badge（保留 chip 本体）。
7. 点击 chip 弹出**右上角浮窗 drawer**（≤360px 宽），不影响主内容；drawer 内含三个 segmented：全部 / 评审 / 反问；列表项点击跳转到对应 `/reviews/{id}` 或 `/clarify/{id}` 详情页。
8. drawer 用 ESC 键 / 点空白处关闭；浏览路由变化时不自动关闭（用户可一边浏览一边对照清单）。

运行时：

9. 顶栏右上常驻 runtime chip：`● opencode v{X}`。● 颜色映射 daemon 探测状态（绿=ready / 黄=未探测过 / 红=connect-failed / 灰=版本低于最低门槛）。点击跳转 `/settings#runtime`（v1 不做独立 `/runtime` 路由）。

路由 / i18n：

10. 现有所有路由 URL 保留（`/agents`, `/skills`, `/mcps`, `/plugins`, `/workflows`, `/tasks`, `/reviews`, `/clarify`, `/repos`, `/settings`），书签不破。
11. i18n 新增的键有清晰命名空间 `nav.group.*` / `nav.inbox.*` / `nav.runtime.*` / `nav.settingsGear`；现有 `nav.{agents,skills,...}` 文案保留作为子导航 label。

收尾：

12. 旧 `.sidebar` / `.sidebar__*` CSS 整段移除；不留 dead code、不留兼容样式（一次性切换）。
13. 一级 tab、子导航与右上齿轮 active 状态由**纯函数 `resolveActiveNav(pathname)`** 决定（不依赖 router 内部 state），便于单测覆盖每条路由的归属。
14. Playwright e2e：依次验证「点代理一级 tab → 出现技能/MCP/插件/运行时 子导航」「点收件箱 chip → drawer 弹出并显示合并 count」「点 runtime chip → 跳 /settings#runtime」「点齿轮 → 跳 /settings 且子导航条消失」四条核心 happy path。

回归防护：

14. 给 `app-shell` 主题、键盘 Tab 顺序、404 / 未登录态（`/auth` 仍走 `.app-shell--bare` 路径）写源码层断言或集成断言，确保改版不破坏既有 auth-gate 行为。

## 与其他 RFC 的关系

- 不依赖任何进行中的 RFC（RFC-029 / RFC-030 都是 task runner / inventory 路径，与外壳无关）。
- 与已落地的 RFC-005（reviews badge）、RFC-023（clarify badge）兼容：本 RFC **复用**它们的 `/api/reviews/pending-count` 与 `/api/clarify/pending-count` 端点，不删不改。
- 不影响 RFC-025（language switch）：language switch 从 sidebar 底部搬到顶栏右上 chip 区，复用同一个 `useApplyLanguage` 和后端 `config.language` 端点。
