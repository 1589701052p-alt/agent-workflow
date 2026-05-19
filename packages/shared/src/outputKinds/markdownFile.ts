// RFC-049 — `markdown_file` kind handler. The non-trivial kind: a port whose
// `<port>` content is a worktree-relative path; the framework reads that file
// off disk before downstream nodes see the body.
//
// PR-A scope:
//   - subReasons covers 3 codes that PR-A's validate produces (empty-path /
//     escapes-worktree / missing-file). PR-B adds `wrong-extension` +
//     `empty-file` once the stricter validation is wired in.
//   - buildPromptGuidance: moved verbatim from shared/prompt.ts's
//     `buildMarkdownFilePortGuidance` (search-replace search anchor here so
//     future readers find the migration commit).
//   - buildRepairBlock: ships now even though scheduler followup wiring is
//     PR-B work; an unused function in PR-A is harmless and avoids touching
//     this file again in PR-B for shared text.

import type { OutputKindHandler, KindFailure } from './types'

const SUB_REASON_DESCRIPTIONS: Record<string, string> = {
  'empty-path': 'empty path',
  'escapes-worktree': 'path escapes the task worktree',
  'missing-file': 'file at the given path does not exist',
  // Pre-declared for PR-B convenience — handler doesn't emit these subReasons
  // yet, but buildRepairBlock already knows how to describe them so PR-B can
  // wire validators without re-touching this map.
  'wrong-extension': 'path extension is not .md / .markdown',
  'empty-file': 'file exists but its content is empty after trim',
}

const handler: OutputKindHandler<'markdown_file'> = {
  kind: 'markdown_file',
  // PR-A: only the 3 codes the PR-A validate produces. PR-B expands to 5.
  subReasons: new Set<string>(['empty-path', 'escapes-worktree', 'missing-file']),

  buildPromptGuidance({ ports }) {
    if (ports.length === 0) return null
    const list = ports.map((p) => `\`${p}\``).join(', ')
    return (
      '\n' +
      `For ports declared \`markdown_file\` above (${list}) you MUST follow this two-step protocol — emitting only a path without the file behind it will fail the run:\n` +
      '  1. First, USE A FILE-WRITING TOOL (Write / Edit / shell `cat > path` / equivalent) to persist the FULL markdown body to a file inside the current working directory (the task worktree). Pick a stable worktree-relative path such as `report.md` or `docs/findings.md`.\n' +
      '  2. THEN, place ONLY that worktree-relative path inside the matching `<port>` tag — no markdown body, no code fences, no surrounding prose, no leading or trailing whitespace, no placeholder. The framework reads the file at that path; a path that does not point to an existing file causes the run to fail.\n'
    )
  },

  validate(rawContent, _ctx, io) {
    const trimmed = rawContent.trim()
    if (trimmed.length === 0) {
      return {
        ok: false,
        subReason: 'empty-path',
        detail: 'markdown_file port content must be a worktree-relative path, got empty string',
      }
    }

    const resolved = io.resolveWorktreePath(_ctx.worktreePath, trimmed)
    if (!resolved.insideWorktree) {
      return {
        ok: false,
        subReason: 'escapes-worktree',
        detail: `markdown_file port content '${trimmed}' resolves outside the task worktree`,
      }
    }

    try {
      const body = io.readFileUtf8(resolved.targetAbs)
      return { ok: true, body, sourcePath: resolved.relativePath }
    } catch (err) {
      return {
        ok: false,
        subReason: 'missing-file',
        detail: `markdown_file '${trimmed}': ${(err as Error).message}`,
      }
    }
  },

  buildRepairBlock({ failures, ports }) {
    if (failures.length === 0) return null

    // First-occurrence-ordered, deduped list of failed ports for the section
    // header bullets.
    const lines: string[] = []
    for (const f of failures) {
      const description = SUB_REASON_DESCRIPTIONS[f.subReason] ?? f.subReason
      const detailSuffix = f.detail ? ` ${f.detail}` : ''
      lines.push(`- port \`${f.port}\`: ${description}.${detailSuffix}`)
    }

    const reminderPorts = ports.length > 0 ? ports.map((p) => `\`${p}\``).join(', ') : ''
    const reminder = reminderPorts
      ? `\n\nFor ports declared \`markdown_file\` (${reminderPorts}) you MUST follow the two-step protocol — write the file to disk first, then place ONLY the worktree-relative path inside the matching <port> tag. A path without a real file on disk fails the run.`
      : ''

    return `\n\n**Port content validation — markdown_file.**\n${lines.join('\n')}${reminder}`
  },
}

export default handler
