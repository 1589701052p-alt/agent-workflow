// RFC-054 W1-7 — dependency-cruiser configuration.
//
// LOCKS: cross-package import direction. The three forbidden rules guard
// the architectural seams between `packages/frontend`, `packages/backend`,
// and `packages/shared`. Any future PR that accidentally imports across
// the wrong seam fails `bun run depcheck` immediately.
//
// Run locally:  bun run depcheck
// Run a specific package:  bun run depcheck -- packages/backend/src
//
// All three rules are zero-violation today (W1-7 commit) — no allowlist /
// no `comment` regex hacks. If a future PR legitimately needs to cross
// a seam (e.g. a shared utility moved to the wrong package), prefer
// relocating the file over loosening these rules.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-frontend-to-backend',
      severity: 'error',
      comment:
        'Frontend code must not import from the backend package directly. ' +
        'Share types / runtime helpers via @agent-workflow/shared instead.',
      from: { path: '^packages/frontend/src/' },
      to: { path: '^packages/backend/' },
    },
    {
      name: 'no-services-to-routes',
      severity: 'error',
      comment:
        'Service code is the deeper layer and must not import from routes ' +
        '(which are HTTP transport adapters). Inverting this would create ' +
        'a cycle and tightly couple business logic to Hono.',
      from: { path: '^packages/backend/src/services/' },
      to: { path: '^packages/backend/src/routes/' },
    },
    {
      name: 'no-shared-to-app',
      severity: 'error',
      comment:
        '`packages/shared` is the bottom of the dep graph. It must not ' +
        'import from `packages/backend` or `packages/frontend` (which ' +
        'depend ON it).',
      from: { path: '^packages/shared/src/' },
      to: { path: '^packages/(backend|frontend)/' },
    },
  ],
  options: {
    // Tree-shake the dep graph so we don't analyze test scaffolding or
    // node_modules.
    doNotFollow: {
      path: ['node_modules', '\\.opencode'],
    },
    exclude: {
      path: [
        'node_modules',
        'dist',
        '\\.opencode',
        'packages/.*/tests/',
        'packages/.*/dist/',
        '\\.test\\.tsx?$',
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
    progress: { type: 'none' },
  },
}
