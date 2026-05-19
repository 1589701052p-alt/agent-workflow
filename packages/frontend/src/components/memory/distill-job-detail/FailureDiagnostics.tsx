// RFC-043 T5 — failure diagnostics card. Hidden entirely when there
// is nothing to diagnose (status=done, exitCode=0, no lastError, no
// retry history).

import { useTranslation } from 'react-i18next'
import type { MemoryDistillJob } from '@agent-workflow/shared'
import {
  formatExitCode,
  shouldShowFailureDiagnostics,
  truncateStderr,
} from '@/lib/distill-job-detail'

interface Props {
  job: MemoryDistillJob
}

export function FailureDiagnostics({ job }: Props) {
  const { t } = useTranslation()
  if (!shouldShowFailureDiagnostics(job)) return null
  const stderr = truncateStderr(job.stderrExcerpt ?? null)
  return (
    <div className="distill-job-detail__diagnostics" data-testid="distill-failure-diagnostics">
      <dl className="distill-job-detail__diagnostics-list">
        <dt>{t('memory.distillJobs.colAttempts')}</dt>
        <dd>{job.attempts}</dd>
        <dt>Exit code</dt>
        <dd>
          <code>{formatExitCode(job.exitCode ?? null)}</code>
        </dd>
        {job.lastError !== null && job.lastError !== '' && (
          <>
            <dt>{t('memory.distillJobs.colError')}</dt>
            <dd className="distill-job-detail__diagnostics-error">{job.lastError}</dd>
          </>
        )}
      </dl>
      {stderr !== null && (
        <div>
          <h3 className="distill-job-detail__section-subhead">
            {t('memory.distillJobDetail.stderrLabel')}
          </h3>
          <pre className="distill-job-detail__stderr">{stderr}</pre>
        </div>
      )}
    </div>
  )
}
