// P-5-04: Resolve config.theme (`system | light | dark`) to a concrete
// `data-theme` attribute on <html>. The CSS in styles.css keys all palette
// variables off that attribute, so flipping it switches the whole UI.
//
// "system" tracks `prefers-color-scheme` in real time via matchMedia, so the
// user does not need to refresh when their OS toggles between light/dark.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import type { Config } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { getToken, subscribeAuth } from '@/stores/auth'

export type Theme = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(theme: Theme, system: ResolvedTheme): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme
  return system
}

function subscribeSystemTheme(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mql = window.matchMedia(DARK_QUERY)
  mql.addEventListener('change', listener)
  return () => mql.removeEventListener('change', listener)
}

function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeSystemTheme, getSystemTheme, () => 'light')
}

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

/** Apply <html data-theme=…> as a side effect for the lifetime of the caller. */
export function useApplyTheme(): void {
  const token = useAuthToken()
  const system = useSystemTheme()
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
    enabled: token !== null,
    staleTime: 60_000,
  })

  const theme: Theme = config.data?.theme ?? 'system'
  const resolved: ResolvedTheme = resolveTheme(theme, system)

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (theme === 'system') {
      // Let the CSS @media fallback take over so /auth (no config) still
      // tracks the OS preference even before the React tree mounts.
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', resolved)
    }
  }, [theme, resolved])
}
