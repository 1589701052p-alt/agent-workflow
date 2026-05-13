# Agent Workflow

> 本地编排平台：用确定性引擎驱动多个独立的 opencode 子进程协同工作（编码 → 审计 → 修复 流水线），避免单 session subagent 上下文膨胀。

详细产品规格与技术设计：

- [`design/proposal.md`](./design/proposal.md) — 产品规格（中文）
- [`design/design.md`](./design/design.md) — 技术设计（中文）
- [`design/plan.md`](./design/plan.md) — 实施计划（81 个 issue）

> 当前阶段：**M0（项目准备）**。还没到能跑应用的阶段；目前只有 monorepo 脚手架。

---

## 前置工具

| 工具 | 最低版本 | 备注 |
| --- | --- | --- |
| **Bun** | 1.1.0+ | 构建 / 运行后端 / 包管理 |
| **opencode** | 1.14.0+（已在 1.14.25 验证） | 由平台 spawn 子进程调用，需在 PATH |
| **git** | 2.5+ | worktree 子命令必备 |

平台仅支持 macOS + Linux（Windows v1 不支持）。

安装 bun：

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## 仓结构

```
agent-workflow/
├── packages/
│   ├── backend/    # Bun + Hono + Drizzle daemon
│   ├── frontend/   # Vite + React 19 + xyflow v12 SPA
│   └── shared/     # 前后端共享 zod schemas + types
├── design/         # 设计文档
├── proposal/       # 历史原始提案
├── scripts/        # 构建/分发脚本（M5 落地）
└── .github/workflows/  # CI（P-0-03 落地）
```

---

## 开发起步（M0 阶段）

```bash
# 1) 安装 bun（见上）
# 2) 仓根
bun install

# 3) 跑测试（M0 仅一个 smoke test）
bun test

# 4) 类型检查
bun run typecheck

# 5) 跑 dev（前后端并起）
bun dev
```

> M0 阶段后端 `start` 子命令仅打印一行 hello；前端 dev server 默认监听 `http://127.0.0.1:5174`。

---

## 路线图

详见 [`design/plan.md`](./design/plan.md)：M0 准备 → M1 骨架 → M2 编辑器 → M3 编排核心 → M4 高级编排 → M5 打磨。

单人全职约 13 周。

---

## License

待定。
