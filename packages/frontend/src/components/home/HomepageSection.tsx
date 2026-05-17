// RFC-032 PR3: reusable wrapper for the three homepage sections
// (Running / Waiting on you / Recently finished).
//
// Each section pairs a title + count chip with a single right-aligned
// link ("View all →" / "Open inbox →" / "View tasks →"). The variant
// prop colours the count chip — the inbox section uses the warn token
// to telegraph "something needs you" without resorting to the alarm-red
// danger colour reserved for outright errors.

import type { ReactNode } from 'react'

interface HomepageSectionProps {
  title: string
  count: number
  variant?: 'default' | 'warn'
  /** Right-aligned link label + onClick (preferred) or `to` for a Link. */
  link?: {
    label: string
    onClick?: () => void
    to?: string
  }
  children: ReactNode
  /** Optional data-testid for e2e targeting. */
  testId?: string
}

export function HomepageSection({
  title,
  count,
  variant = 'default',
  link,
  children,
  testId,
}: HomepageSectionProps) {
  return (
    <section className="homepage-section" data-testid={testId}>
      <div className="homepage-section__head">
        <h2 className="homepage-section__title">
          {title}
          <span
            className={`homepage-section__count${
              variant === 'warn' ? ' homepage-section__count--warn' : ''
            }`}
          >
            {count}
          </span>
        </h2>
        {link && (link.onClick !== undefined || link.to !== undefined) && (
          <SectionLink link={link} />
        )}
      </div>
      <div className="homepage-section__body">{children}</div>
    </section>
  )
}

function SectionLink({ link }: { link: { label: string; onClick?: () => void; to?: string } }) {
  if (link.onClick !== undefined) {
    return (
      <button type="button" className="homepage-section__link" onClick={link.onClick}>
        {link.label}
      </button>
    )
  }
  // Plain anchor — the homepage stays close to the framework's <Link>
  // semantics by accepting a string `to`. We don't import Link here
  // because two of the three callers want a router-aware link with
  // query params (`?status=running`) which is more flexible via a
  // direct <a> href. The router intercepts same-origin clicks anyway.
  return (
    <a className="homepage-section__link" href={link.to}>
      {link.label}
    </a>
  )
}
