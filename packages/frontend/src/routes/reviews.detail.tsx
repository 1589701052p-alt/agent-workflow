// /reviews/:nodeRunId — RFC-005 PR-D T27.
//
// The review detail page. Renders the current doc_version's markdown body,
// shows existing review comments in a right sidebar, lets the user select
// text + drop a comment via a popover, and surfaces the three decision
// buttons (approve / reject / iterate) along with the optimistic-lock
// review_iteration the backend will check.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Config,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewDetail,
} from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { MarkdownView } from '@/components/review/MarkdownView'
import { anchorKey, computeAnchorFromSelection } from '@/lib/review/anchor'
import { deleteDraft, getDraft, listDrafts, setDraft } from '@/lib/review/draftStore'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/reviews/$nodeRunId',
  component: ReviewDetailPage,
})

function ReviewDetailPage() {
  const { nodeRunId } = Route.useParams()
  const { t } = useTranslation()
  const qc = useQueryClient()

  const detail = useQuery<ReviewDetail>({
    queryKey: ['reviews', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}`, undefined, signal),
    refetchInterval: 8000,
  })

  // Config needed for plantuml endpoint passthrough.
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
  })

  const markdownRef = useRef<HTMLDivElement>(null)
  const [popover, setPopover] = useState<{
    anchor: ReviewCommentAnchor
    draft: string
    rect: { left: number; top: number }
  } | null>(null)

  // Sidebar scroll-spy: highlight the comment whose anchor element is
  // currently the topmost in view.
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)

  const commentsByOccurrence = useMemo(() => {
    if (detail.data === undefined) return new Map<string, ReviewComment>()
    const m = new Map<string, ReviewComment>()
    for (const c of detail.data.comments) m.set(anchorKey(c.anchor), c)
    return m
  }, [detail.data])

  // Mouse-up handler on the markdown area: capture selection → build anchor → open popover.
  const onMouseUpInDoc = useCallback(async () => {
    if (markdownRef.current === null) return
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed) return
    if (detail.data === undefined) return
    const anchor = computeAnchorFromSelection(markdownRef.current, sel, detail.data.currentBody)
    if (anchor === null) return
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const draft =
      (await getDraft({
        taskId: detail.data.summary.taskId,
        nodeRunId,
        docVersionId: detail.data.currentVersion.id,
        anchorHash: anchorKey(anchor),
      })) ?? ''
    setPopover({
      anchor,
      draft,
      rect: { left: rect.left + window.scrollX, top: rect.bottom + window.scrollY },
    })
  }, [detail.data, nodeRunId])

  // Persist draft on every keystroke + cleanup on submit/cancel.
  useEffect(() => {
    if (popover === null || detail.data === undefined) return
    const k = {
      taskId: detail.data.summary.taskId,
      nodeRunId,
      docVersionId: detail.data.currentVersion.id,
      anchorHash: anchorKey(popover.anchor),
    }
    void setDraft(k, popover.draft)
  }, [popover, detail.data, nodeRunId])

  const submitComment = useMutation({
    mutationFn: async (input: { anchor: ReviewCommentAnchor; commentText: string }) => {
      await api.post(`/api/reviews/${nodeRunId}/comments`, input)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
    },
  })

  const deleteComment = useMutation({
    mutationFn: async (commentId: string) => {
      await api.delete(`/api/reviews/${nodeRunId}/comments/${commentId}`)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
    },
  })

  const submitDecision = useMutation({
    mutationFn: async (input: {
      decision: 'approved' | 'rejected' | 'iterated'
      rejectReason?: string
      reviewIteration: number
    }) => {
      await api.post(`/api/reviews/${nodeRunId}/decision`, input)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'list'] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'pending-count'] })
    },
  })

  const onApprove = useCallback(async () => {
    if (detail.data === undefined) return
    const draftCount = (
      await listDrafts({
        taskId: detail.data.summary.taskId,
        nodeRunId,
        docVersionId: detail.data.currentVersion.id,
      })
    ).filter((d) => d.text.trim().length > 0).length
    if (draftCount > 0) {
      const ok = window.confirm(
        t('reviews.approveDraftWarning', { count: draftCount }) +
          '\n\n' +
          t('reviews.approveDraftConfirm'),
      )
      if (!ok) return
    }
    await submitDecision.mutateAsync({
      decision: 'approved',
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [detail.data, nodeRunId, submitDecision, t])

  const onReject = useCallback(async () => {
    if (detail.data === undefined) return
    const willRerun = detail.data.rerunnableOnReject.join(', ') || '(none)'
    const reason = window.prompt(t('reviews.rejectPrompt', { willRerun }), '')
    if (reason === null) return
    const trimmed = reason.trim()
    if (trimmed.length === 0) {
      window.alert(t('reviews.rejectReasonRequired'))
      return
    }
    await submitDecision.mutateAsync({
      decision: 'rejected',
      rejectReason: trimmed,
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [detail.data, submitDecision, t])

  const onIterate = useCallback(async () => {
    if (detail.data === undefined) return
    if (detail.data.comments.length === 0) {
      const ok = window.confirm(t('reviews.iterateNoCommentsWarning'))
      if (!ok) return
    }
    const willRerun = detail.data.rerunnableOnIterate.join(', ') || '(direct upstream)'
    const ok = window.confirm(t('reviews.iterateConfirm', { willRerun }))
    if (!ok) return
    await submitDecision.mutateAsync({
      decision: 'iterated',
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [detail.data, submitDecision, t])

  // Scroll-spy: hook IntersectionObserver to the rendered DOM after each
  // markdown rerender. Currently a simple "top visible anchor in viewport"
  // heuristic — keeps the sidebar tracking the user's reading position.
  useEffect(() => {
    if (markdownRef.current === null || detail.data === undefined) return
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top !== undefined) {
          const id = (top.target as HTMLElement).dataset.commentId ?? null
          if (id !== null) setActiveCommentId(id)
        }
      },
      { rootMargin: '-20% 0px -60% 0px' },
    )
    const anchors = markdownRef.current.querySelectorAll('[data-comment-id]')
    anchors.forEach((a) => observer.observe(a))
    return () => observer.disconnect()
  }, [detail.data])

  // Keyboard shortcuts: A/R/I + Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (popover !== null) {
        if (e.key === 'Escape') {
          setPopover(null)
        }
        return
      }
      // Don't hijack typing inside form fields.
      if (
        document.activeElement !== null &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      ) {
        return
      }
      if (e.key.toLowerCase() === 'a') void onApprove()
      else if (e.key.toLowerCase() === 'r') void onReject()
      else if (e.key.toLowerCase() === 'i') void onIterate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover, onApprove, onReject, onIterate])

  if (detail.isLoading) return <div className="muted">{t('common.loading')}</div>
  if (detail.error !== null && detail.error !== undefined) {
    const err = detail.error as ApiError
    return <div className="error-box">{err.message}</div>
  }
  if (detail.data === undefined) return null

  const data = detail.data
  const isAwaiting = data.summary.awaitingReview

  return (
    <div className="page review-detail">
      <header className="page__header">
        <h1>
          {data.summary.workflowName} / <code>{data.summary.reviewNodeId}</code>
          <span className="muted"> · v{data.currentVersion.versionIndex}</span>
        </h1>
        <p className="page__hint">
          {t('reviews.detailHint', {
            iteration: data.summary.reviewIteration,
            decision: data.currentVersion.decision,
          })}
        </p>
      </header>

      <div className="review-detail__layout">
        <div
          className="review-detail__body"
          ref={markdownRef}
          onMouseUp={() => void onMouseUpInDoc()}
        >
          <MarkdownView
            body={data.currentBody}
            taskId={data.summary.taskId}
            plantumlEndpoint={config.data?.plantumlEndpoint}
            plantumlAuthHeader={config.data?.plantumlAuthHeader}
          />
        </div>
        <aside className="review-detail__sidebar">
          <h3>{t('reviews.sidebarTitle')}</h3>
          {data.comments.length === 0 ? (
            <div className="muted">{t('reviews.sidebarEmpty')}</div>
          ) : (
            <ul className="comment-list">
              {data.comments.map((c) => (
                <li
                  key={c.id}
                  className={
                    'comment-list__item' +
                    (activeCommentId === c.id ? ' comment-list__item--active' : '')
                  }
                >
                  <div className="comment-list__section">{c.anchor.sectionPath}</div>
                  <blockquote className="comment-list__selection">
                    {c.anchor.selectedText}
                  </blockquote>
                  <div className="comment-list__body">{c.commentText}</div>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => deleteComment.mutate(c.id)}
                    disabled={!isAwaiting}
                  >
                    {t('common.delete')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <footer className="review-detail__footer">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!isAwaiting || submitDecision.isPending}
          onClick={() => void onApprove()}
        >
          {t('reviews.approveButton')} <kbd>A</kbd>
        </button>
        <button
          type="button"
          className="btn"
          disabled={!isAwaiting || submitDecision.isPending}
          onClick={() => void onIterate()}
        >
          {t('reviews.iterateButton')} <kbd>I</kbd>
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={!isAwaiting || submitDecision.isPending}
          onClick={() => void onReject()}
        >
          {t('reviews.rejectButton')} <kbd>R</kbd>
        </button>
        {submitDecision.error !== null && submitDecision.error !== undefined && (
          <div className="error-box">{(submitDecision.error as Error).message}</div>
        )}
      </footer>

      {popover !== null && (
        <div
          className="comment-popover"
          style={{ position: 'absolute', left: popover.rect.left, top: popover.rect.top }}
          role="dialog"
        >
          <div className="muted">{popover.anchor.sectionPath}</div>
          <textarea
            className="form-input"
            autoFocus
            rows={3}
            value={popover.draft}
            placeholder={t('reviews.popoverPlaceholder')}
            onChange={(e) => setPopover({ ...popover, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submitPopover()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setPopover(null)
              }
            }}
          />
          <div className="comment-popover__actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={popover.draft.trim().length === 0 || submitComment.isPending}
              onClick={() => void submitPopover()}
            >
              {t('reviews.popoverSubmit')}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                if (detail.data === undefined) return
                void deleteDraft({
                  taskId: detail.data.summary.taskId,
                  nodeRunId,
                  docVersionId: detail.data.currentVersion.id,
                  anchorHash: anchorKey(popover.anchor),
                })
                setPopover(null)
              }}
            >
              {t('reviews.popoverCancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )

  async function submitPopover() {
    if (popover === null || detail.data === undefined) return
    const text = popover.draft.trim()
    if (text.length === 0) return
    await submitComment.mutateAsync({ anchor: popover.anchor, commentText: text })
    await deleteDraft({
      taskId: detail.data.summary.taskId,
      nodeRunId,
      docVersionId: detail.data.currentVersion.id,
      anchorHash: anchorKey(popover.anchor),
    })
    void commentsByOccurrence // silence unused-var lint if commentsByOccurrence never gets a reader
    setPopover(null)
  }
}
