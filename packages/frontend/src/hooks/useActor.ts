// RFC-036 — current actor + permission set from /api/auth/me.
// Returns null while loading or when unauthenticated.

import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

export interface MeResponse {
  user: {
    id: string
    username: string
    displayName: string
    role: 'admin' | 'user'
    status: 'active' | 'disabled' | 'invited'
  }
  source: 'session' | 'pat' | 'daemon'
  permissions: string[]
  linkedIdentities: unknown[]
  pats: unknown[]
}

export const ACTOR_QUERY_KEY = ['auth', 'me']

export function useActor() {
  const q = useQuery<MeResponse | null>({
    queryKey: ACTOR_QUERY_KEY,
    queryFn: async () => {
      try {
        return await api.get<MeResponse>('/api/auth/me')
      } catch {
        return null
      }
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  return q
}

export function usePermission(perm: string): boolean {
  const { data } = useActor()
  if (!data) return false
  return data.permissions.includes(perm)
}
