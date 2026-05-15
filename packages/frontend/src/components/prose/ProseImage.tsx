// RFC-008 T2 — image override with medium-zoom click-to-zoom.
//
// Relative paths get rewritten via resolveImageHref(taskId) so workspace
// images load through the worktree-files proxy. medium-zoom is lazy-loaded
// on mount so the prose bundle stays small for non-image-heavy pages.
import { useEffect, useMemo, useRef } from 'react'
import { resolveImageHref } from './imageHref'

interface ImgProps {
  src?: string
  alt?: string
  title?: string
}

export interface MakeProseImageOptions {
  taskId?: string
}

export function makeProseImage({ taskId }: MakeProseImageOptions = {}): (
  props: ImgProps,
) => React.ReactNode {
  return function ProseImage({ src, alt, title }: ImgProps) {
    const resolved = useMemo(() => resolveImageHref(src ?? '', taskId), [src])
    const ref = useRef<HTMLImageElement>(null)

    useEffect(() => {
      if (ref.current === null) return
      const el = ref.current
      let zoom: { detach: () => void } | undefined
      let cancelled = false
      void import('medium-zoom').then((mod) => {
        if (cancelled) return
        const mediumZoom = mod.default ?? mod
        zoom = mediumZoom(el, { background: 'rgba(0,0,0,0.85)', margin: 24 }) as {
          detach: () => void
        }
      })
      return () => {
        cancelled = true
        zoom?.detach()
      }
    }, [resolved])

    return (
      <img
        ref={ref}
        src={resolved}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        className="prose__image"
        data-prose-image=""
      />
    )
  }
}
