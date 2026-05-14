// `agent-workflow backup` — produce a tarball of agent-workflow state.

import { openDb } from '@/db/client'
import { createBackup } from '@/services/backup'
import { Paths } from '@/util/paths'

export interface BackupCommandResult {
  output: string
  status: 'ok' | 'error'
}

export async function backupCommand(): Promise<BackupCommandResult> {
  const db = openDb({ path: Paths.db, migrationsFolder: Paths.migrationsDir })
  try {
    const r = await createBackup({ db })
    const sizeMb = (r.sizeBytes / 1024 / 1024).toFixed(2)
    const lines = [
      `backup written: ${r.path}`,
      `  size:      ${sizeMb} MB`,
      `  workflows: ${r.contents.workflows}`,
      `  skills:    ${r.contents.skills} files`,
      `  db:        ${r.contents.db ? 'included' : 'missing'}`,
      `  config:    ${r.contents.config ? 'included' : 'missing'}`,
    ]
    return { output: lines.join('\n') + '\n', status: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `backup failed: ${msg}\n`, status: 'error' }
  }
}
