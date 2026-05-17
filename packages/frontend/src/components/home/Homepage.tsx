// RFC-032 PR3: the task-driven dashboard rendered at `/` for non-first-run
// environments.
//
// Layout:
//   - Hero ("Good morning" + runtime status + Start task button).
//   - Section 1: Running — tasks currently in flight or awaiting human.
//   - Section 2: Waiting on you — merged reviews + clarify pending.
//   - Section 3: Recently finished — terminal-status tasks, most recent first.
//
// Each section keeps its own count, surfaced as a chip next to the title.
// We lift the count to local state so the section header label can show
// the chip without each list re-rendering its parent.

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HomepageGreeting } from './HomepageGreeting'
import { HomepageSection } from './HomepageSection'
import { InboxPreviewList } from './InboxPreviewList'
import { RecentlyDoneList } from './RecentlyDoneList'
import { RunningTaskList } from './RunningTaskList'

export function Homepage() {
  const { t } = useTranslation()
  const [runningCount, setRunningCount] = useState(0)
  const [inboxCount, setInboxCount] = useState(0)
  const [recentCount, setRecentCount] = useState(0)

  const onRunningCount = useCallback((n: number) => setRunningCount(n), [])
  const onInboxCount = useCallback((n: number) => setInboxCount(n), [])
  const onRecentCount = useCallback((n: number) => setRecentCount(n), [])

  return (
    <div className="page homepage" data-testid="homepage">
      <HomepageGreeting />

      <HomepageSection
        title={t('home.section.running')}
        count={runningCount}
        link={{ label: t('home.section.viewAll'), to: '/tasks?status=running' }}
        testId="homepage-section-running"
      >
        <RunningTaskList onCount={onRunningCount} />
      </HomepageSection>

      <HomepageSection
        title={t('home.section.inbox')}
        count={inboxCount}
        variant="warn"
        link={{ label: t('home.section.openInbox'), to: '/reviews' }}
        testId="homepage-section-inbox"
      >
        <InboxPreviewList onCount={onInboxCount} />
      </HomepageSection>

      <HomepageSection
        title={t('home.section.recent')}
        count={recentCount}
        link={{ label: t('home.section.viewTasks'), to: '/tasks' }}
        testId="homepage-section-recent"
      >
        <RecentlyDoneList onCount={onRecentCount} />
      </HomepageSection>
    </div>
  )
}
