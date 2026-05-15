// Auth token storage. Token lives in localStorage; UI prompts for it on first
// load via /auth. The daemon prints the token at start; user pastes it in.
//
// Exposed as a tiny event-target so React components can subscribe via
// useSyncExternalStore without pulling in a state-management lib.

const TOKEN_KEY = 'agent-workflow.token'
const BASE_URL_KEY = 'agent-workflow.baseUrl'

// Default to the page's own origin so:
//   - Production (user opens the daemon URL directly): API calls hit the daemon.
//   - Dev (`bun dev` opens Vite at :5174): API calls go through Vite's proxy,
//     which forwards to the daemon's actual port (read from .daemon.info).
// Stored override (BASE_URL_KEY) still wins for remote-daemon setups.
function defaultBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:7456'
  return window.location.origin
}

type Listener = () => void
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l()
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export function getToken(): string | null {
  return safeStorage()?.getItem(TOKEN_KEY) ?? null
}

export function setToken(token: string): void {
  const trimmed = token.trim()
  if (trimmed === '') {
    clearToken()
    return
  }
  safeStorage()?.setItem(TOKEN_KEY, trimmed)
  emit()
}

export function clearToken(): void {
  safeStorage()?.removeItem(TOKEN_KEY)
  emit()
}

export function getBaseUrl(): string {
  return safeStorage()?.getItem(BASE_URL_KEY) ?? defaultBaseUrl()
}

export function setBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/$/, '')
  if (trimmed === '' || trimmed === defaultBaseUrl()) {
    safeStorage()?.removeItem(BASE_URL_KEY)
  } else {
    safeStorage()?.setItem(BASE_URL_KEY, trimmed)
  }
  emit()
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const AUTH_DEFAULT_BASE_URL = defaultBaseUrl()
