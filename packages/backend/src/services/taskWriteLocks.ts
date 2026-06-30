// RFC-098 B1 (audit S-9 / WP-5) — the per-task WORKTREE WRITE LOCK registry.
//
// Before this module the scheduler's writer serialization lived in a
// per-runTask local `new Semaphore(1)` (SchedulerState.writeSem) that HTTP
// entry points could never reach — submitClarifyAnswers / review iterate /
// cross-clarify answers all ran `rollbackToSnapshot` (reset --hard + clean
// -fd) straight against the worktree while an in-flight writer node might be
// mid-write (S-9: three ready-made backdoors through the "writers serialize"
// guarantee). The registry gives every code path that mutates a task's
// worktree THE SAME lock instance.
//
// Lifecycle (adversarial-review revision #1 — do NOT add other delete paths):
// `gcTaskWriteSem` may be called ONLY from runTask's finally. An HTTP-side gc
// would race the scheduler's cached reference (SchedulerState.writeSem holds
// the instance for the whole run): delete + recreate while the scheduler
// still holds the old instance silently splits the mutex back into two — the
// exact S-9 pathology this module removes. A task that parked, got rolled
// back over HTTP and never resumes leaks at most one idle Semaphore object;
// accepted and documented.

import { Semaphore } from '@/util/semaphore'

const locks = new Map<string, Semaphore>()

/** The one write lock for a task's worktree(s). getOrCreate — never replaced
 *  while anyone may hold a reference (see module doc). */
export function getTaskWriteSem(taskId: string): Semaphore {
  let sem = locks.get(taskId)
  if (sem === undefined) {
    sem = new Semaphore(1)
    locks.set(taskId, sem)
  }
  return sem
}

// RFC-128 P5-BC §5.2.14 (final-gate, user-authorized) — the per-task QUESTION-WRITE lock.
//
// A SECOND, SHORT-LIVED per-task mutex, DISTINCT from getTaskWriteSem above. It serializes the
// task's clarify-answer / cross-clarify-answer SUBMIT critical sections against dispatchTaskQuestions
// so a deferred dispatch can never commit (stamp + mint a pending rerun) in the window between a
// submit's stale dispatch-mode precheck and its destructive worktree rollback (which would clobber
// the dispatched rerun) — nor double-mint a same-home rerun. EVERY holder does only fast DB ops (+ a
// bounded git reset for the self rollback) and NEVER runs an opencode agent, so the lock is held
// briefly and never blocks behind a multi-minute agent run.
//
// Why NOT reuse getTaskWriteSem: that lock is held by scheduler writer nodes for the ENTIRE agent
// run (scheduler.ts:1962 → :2872). Making dispatch acquire it would hang the "下发" HTTP request
// behind a running writer. The question-write lock is its own registry so dispatch never waits on an
// agent run.
//
// LOCK ORDER (deadlock-free): the ONLY nesting is in submitClarifyAnswers, which holds the long
// worktree sem (A = getTaskWriteSem, for the rollback's writer-protection, RFC-098 B1) OUTER and the
// question-write lock (B = this) INNER → order A ≻ B. Every other holder takes exactly ONE: dispatch
// + submitCrossClarifyAnswers take B only; scheduler writer nodes take A only. No path acquires A
// while holding B, so there is no A→B / B→A cycle. A is acquired BEFORE B in the submit, so B is
// never held while waiting for A → a B-waiter (dispatch) never blocks behind A's (agent-run) wait.
const questionWriteLocks = new Map<string, Semaphore>()

/** RFC-128 §5.2.14 — the per-task short-lived question-write lock (see module doc; lock order A ≻ B,
 *  separate registry from getTaskWriteSem). */
export function getTaskQuestionWriteSem(taskId: string): Semaphore {
  let sem = questionWriteLocks.get(taskId)
  if (sem === undefined) {
    sem = new Semaphore(1)
    questionWriteLocks.set(taskId, sem)
  }
  return sem
}

/**
 * Drop the registry entry when idle. ONLY runTask's finally may call this
 * (adversarial-review revision #1): if an HTTP rollback still holds/queues
 * the lock at that moment the entry survives and is reused by the next
 * getOrCreate — self-healing, never split-brain.
 */
export function gcTaskWriteSem(taskId: string): void {
  const sem = locks.get(taskId)
  if (sem !== undefined && sem.available === sem.capacity && sem.queueLength === 0) {
    locks.delete(taskId)
  }
  // RFC-128 §5.2.14 (3rd-gate finding P3): reclaim the question-write lock too, same idle guard +
  // self-healing semantics (if an HTTP submit/dispatch still holds/queues it, the entry survives and
  // is reused by the next getOrCreate — never split-brain). Without this the questionWriteLocks map
  // would grow without bound in a long-lived daemon (one idle Semaphore per distinct task id).
  const qSem = questionWriteLocks.get(taskId)
  if (qSem !== undefined && qSem.available === qSem.capacity && qSem.queueLength === 0) {
    questionWriteLocks.delete(taskId)
  }
}

/** Test-only visibility. */
export function taskWriteLockCount(): number {
  return locks.size
}
