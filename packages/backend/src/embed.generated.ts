// P-5-05 single-binary embed table.
//
// In dev this file is a stub — the backend reads frontend dist and migrations
// from the filesystem (paths.migrationsDir + the vite dev server). The
// `scripts/build-binary.ts` script rewrites this file with `import … with
// { type: 'file' }` statements for every embedded asset before running
// `bun build --compile`, so the compiled binary ships all of them inside its
// executable. Keep the stub committed so dev/typecheck/lint never fail
// because the file is missing.

export const IS_EMBEDDED = false

/** url-path -> embedded file path (resolves to a /$bunfs/... path at runtime). */
export const FRONTEND_FILES: Record<string, string> = {}

/** migrations-rel-path -> embedded file path. */
export const MIGRATION_FILES: Record<string, string> = {}
