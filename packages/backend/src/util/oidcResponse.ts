// RFC-036 — tiny HTML renderer for OIDC callback failure pages. Centralises
// the i18n-free friendly text so the callback route can `return c.html(...)`
// from one location without leaking internal details.

const REASON_TO_TEXT: Record<string, string> = {
  'oidc-not-configured': 'OIDC is not configured on this server.',
  'invalid-callback': 'OIDC callback is missing required parameters.',
  'state-expired': 'Your login session expired. Please try again.',
  'provider-disabled': 'The selected provider is currently disabled.',
  'discovery-failed': 'The identity provider is unreachable. Please try again later.',
  'client-secret-missing': 'Server configuration error. Contact your administrator.',
  'verify-failed': 'Could not verify the identity provider response.',
  'token-exchange-failed': 'Failed to exchange the authorization code.',
  'id-token-verify-failed': 'The id_token signature or claims could not be verified.',
  'nonce-mismatch': 'OIDC nonce check failed (possible replay).',
  'identity-already-linked':
    'That identity is already linked to a different user. Sign in with the other account first.',
  'email-domain-not-allowed':
    'Your email domain is not on the allowlist. Please contact your administrator.',
  'email-not-verified': 'Your identity provider has not verified your email.',
  'not-invited':
    'No invitation found for this email. Please ask your administrator to invite you first.',
}

export function friendly(code: string): string {
  const text = REASON_TO_TEXT[code] ?? 'OIDC login failed.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title></head><body><h1>Login failed</h1><p>${escape(text)}</p><p><a href="/auth">Back to sign in</a></p></body></html>`
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  )
}

/** Custom error subclass for the callback handler to coalesce verify-failed paths. */
export class BadRequestErrorOrFriendlyHtml extends Error {
  constructor(public readonly code: string) {
    super(code)
  }
}
