// RFC-036 — `code → tokens` exchange + id_token verification via jose.
// Verification covers signature (JWKS), iss / aud / exp / nbf (handled by
// jose's jwtVerify), and nonce (explicit). Failures throw a typed error so
// the callback handler can render a friendly 400.

import { jwtVerify, type createRemoteJWKSet, type JWTPayload } from 'jose'

export interface TokenResponse {
  access_token: string
  id_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

export interface ExchangeInput {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  code: string
  codeVerifier: string
  redirectUri: string
  fetcher?: typeof fetch
}

export class OidcTokenError extends Error {
  constructor(
    message: string,
    public readonly code: 'token-exchange-failed' | 'id-token-verify-failed',
  ) {
    super(message)
    this.name = 'OidcTokenError'
  }
}

export async function exchangeCodeForTokens(input: ExchangeInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  })
  const fetcher = input.fetcher ?? globalThis.fetch
  const res = await fetcher(input.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new OidcTokenError(`token-exchange-failed status=${res.status}`, 'token-exchange-failed')
  }
  const json = (await res.json()) as Partial<TokenResponse>
  if (typeof json.access_token !== 'string' || typeof json.id_token !== 'string') {
    throw new OidcTokenError('token-exchange-shape-invalid', 'token-exchange-failed')
  }
  return json as TokenResponse
}

export interface VerifyIdTokenInput {
  idToken: string
  /** Either the remote JWKS or a static key resolver. */
  jwks: ReturnType<typeof createRemoteJWKSet> | Parameters<typeof jwtVerify>[1]
  issuer: string
  audience: string
  nonce: string
}

export async function verifyIdToken(input: VerifyIdTokenInput): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(input.idToken, input.jwks as never, {
      issuer: input.issuer,
      audience: input.audience,
    })
    if (typeof payload.nonce === 'string') {
      if (payload.nonce !== input.nonce) {
        throw new OidcTokenError('nonce-mismatch', 'id-token-verify-failed')
      }
    } else {
      throw new OidcTokenError('nonce-missing', 'id-token-verify-failed')
    }
    return payload
  } catch (err) {
    if (err instanceof OidcTokenError) throw err
    throw new OidcTokenError(
      err instanceof Error ? err.message : String(err),
      'id-token-verify-failed',
    )
  }
}
