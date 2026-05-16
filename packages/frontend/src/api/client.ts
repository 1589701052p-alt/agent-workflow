// Thin fetch wrapper for the daemon REST API.
//
// - Reads token + baseUrl from the auth store on every call so token changes
//   take effect without re-creating the client.
// - Surfaces backend DomainError responses (`{ error: { code, message } }`)
//   as ApiError so callers can branch on code without re-parsing.

import { clearToken, getBaseUrl, getToken } from '@/stores/auth'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = getBaseUrl()
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: opts.signal,
  })

  if (res.status === 401) {
    // Token rejected; force re-auth flow.
    clearToken()
  }

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
  const payload: unknown = isJson ? await res.json().catch(() => null) : null

  if (!res.ok) {
    const err = isErrorPayload(payload)
      ? payload.error
      : { code: `http-${res.status}`, message: res.statusText || 'request failed' }
    throw new ApiError(
      res.status,
      err.code,
      err.message,
      isErrorPayload(payload) ? payload.error.details : undefined,
    )
  }
  return payload as T
}

function isErrorPayload(
  v: unknown,
): v is { error: { code: string; message: string; details?: unknown } } {
  if (typeof v !== 'object' || v === null) return false
  const e = (v as { error?: unknown }).error
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  )
}

/**
 * RFC-020: POST a multipart/form-data body without the JSON Content-Type
 * default. The browser fills in the boundary header automatically when we
 * leave Content-Type unset; manually setting it would strip the boundary.
 */
export async function apiPostMultipart<T>(
  path: string,
  body: FormData,
  signal?: AbortSignal,
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token !== null) headers.Authorization = `Bearer ${token}`

  const res = await fetch(buildUrl(path), {
    method: 'POST',
    headers,
    body,
    signal,
  })

  if (res.status === 401) clearToken()

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
  const payload: unknown = isJson ? await res.json().catch(() => null) : null

  if (!res.ok) {
    const err = isErrorPayload(payload)
      ? payload.error
      : { code: `http-${res.status}`, message: res.statusText || 'request failed' }
    throw new ApiError(
      res.status,
      err.code,
      err.message,
      isErrorPayload(payload) ? payload.error.details : undefined,
    )
  }
  return payload as T
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'POST', body, signal }),
  postMultipart: apiPostMultipart,
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'PUT', body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'PATCH', body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'DELETE', signal }),
}
