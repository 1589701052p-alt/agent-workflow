# Skill reference

A **skill** is a directory the platform copies / symlinks into a node's
`OPENCODE_CONFIG_DIR/skills/<name>/` before `opencode` starts, so the agent
can read it like any other `~/.opencode/skills/<name>/`. Unlike agents,
**the filesystem is the source of truth**: the DB only indexes
`name → path`.

## Two source kinds

| Source kind  | Stored at                                | Behavior                                            |
| ------------ | ---------------------------------------- | --------------------------------------------------- |
| `managed`    | `~/.agent-workflow/skills/<name>/files/` | Daemon writes / edits the files via the API        |
| `external`   | wherever the user said                    | Symlinked into the run dir; daemon never mutates it |

Use `managed` for skills you author in the UI; use `external` for skills
that already live in another repo (your dotfiles, a shared team library,
etc.).

## Layout

```
~/.agent-workflow/skills/<name>/
└── files/
    ├── SKILL.md            # frontmatter + body (required)
    ├── examples/
    │   ├── good.ts
    │   └── bad.ts
    └── README.md           # optional, ignored by opencode but visible
```

`SKILL.md` is the only required file. Everything else under `files/` is
copied verbatim into the agent's `OPENCODE_CONFIG_DIR/skills/<name>/`.

## SKILL.md frontmatter

```yaml
---
name: lint                      # ^[a-z0-9][a-z0-9_-]*$, must match dir name
description: TypeScript lint rules…
# anything else round-trips through frontmatterExtra
---

# Body markdown — what opencode reads as the skill.
```

| Field         | Type     | Required | Notes                          |
| ------------- | -------- | -------- | ------------------------------ |
| `name`        | string   | yes      | URL-safe slug                   |
| `description` | string   | yes      | Shown in pickers; not in prompt |

## CRUD

Managed skills:

| Method | Path                                  | Body                                                    |
| ------ | ------------------------------------- | ------------------------------------------------------- |
| GET    | `/api/skills`                         | —                                                       |
| GET    | `/api/skills/:name`                   | —                                                       |
| POST   | `/api/skills`                         | `CreateManagedSkill` — creates the dir + SKILL.md       |
| PUT    | `/api/skills/:name`                   | `UpdateSkill` — DB-only metadata                        |
| PUT    | `/api/skills/:name/body`              | `{ bodyMd }`                                            |
| GET    | `/api/skills/:name/files`             | recursive listing                                       |
| GET    | `/api/skills/:name/files/*`           | read a file                                             |
| PUT    | `/api/skills/:name/files/*`           | write a file                                            |
| DELETE | `/api/skills/:name/files/*`           | delete a file                                           |
| DELETE | `/api/skills/:name`                   | unregister (409 if any agent references)                |

External skills:

| Method | Path                                  | Body                                                    |
| ------ | ------------------------------------- | ------------------------------------------------------- |
| POST   | `/api/skills/import-external`         | `{ name, externalPath, description? }`                  |
| DELETE | `/api/skills/:name`                   | unregister; the underlying directory is never touched   |

## Per-run staging

Each node run gets its own `OPENCODE_CONFIG_DIR` under
`~/.agent-workflow/runs/<task-id>/<node-run-id>/`. For every skill the
agent declares, the runner either:

- **copies** the managed `files/` tree into that dir, or
- **symlinks** the external skill path into that dir.

The repo-local `.opencode/skills/` and `~/.opencode/skills/` are **not**
disabled — opencode loads them too, so business-specific or
auth-baseline skills keep working alongside platform skills.
