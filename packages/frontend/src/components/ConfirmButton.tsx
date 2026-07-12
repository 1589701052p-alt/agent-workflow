// Two-click delete button. First click swaps to "Confirm" for 4 seconds;
// any other click outside resets. Keeps M1 dialog-free.
//
// RFC-150 PR-1 (D4): the `danger` boolean became `variant?: 'danger' |
// 'default'` to line up with the `.btn--*` enum vocabulary. No
// primary/ghost variants until a callsite actually needs them (YAGNI).

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  onConfirm: () => unknown | Promise<unknown>
  variant?: 'danger' | 'default'
  disabled?: boolean
  size?: 'sm'
}

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant,
  disabled,
  size,
}: ConfirmButtonProps) {
  const { t } = useTranslation()
  const resolvedConfirmLabel = confirmLabel ?? t('common.confirmPrompt')
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  function handle() {
    if (!armed) {
      setArmed(true)
      timer.current = setTimeout(() => setArmed(false), 4000)
      return
    }
    if (timer.current !== null) clearTimeout(timer.current)
    setArmed(false)
    const r = onConfirm()
    if (r instanceof Promise) void r
  }

  return (
    <button
      type="button"
      className={`btn ${size === 'sm' ? 'btn--sm' : ''} ${variant === 'danger' ? 'btn--danger' : ''} ${armed ? 'btn--armed' : ''}`}
      disabled={disabled}
      onClick={handle}
    >
      {armed ? resolvedConfirmLabel : label}
    </button>
  )
}
