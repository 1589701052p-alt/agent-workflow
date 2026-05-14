// Auth store: localStorage persistence + subscriber notification.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  AUTH_DEFAULT_BASE_URL,
  clearToken,
  getBaseUrl,
  getToken,
  setBaseUrl,
  setToken,
  subscribeAuth,
} from '../src/stores/auth'

describe('auth store', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    window.localStorage.clear()
  })

  test('getToken returns null when no token stored', () => {
    expect(getToken()).toBeNull()
  })

  test('setToken persists and getToken reads back', () => {
    setToken('abc123')
    expect(getToken()).toBe('abc123')
  })

  test('setToken trims whitespace', () => {
    setToken('  xyz  ')
    expect(getToken()).toBe('xyz')
  })

  test('setToken with empty string clears the token', () => {
    setToken('abc')
    setToken('   ')
    expect(getToken()).toBeNull()
  })

  test('clearToken removes the token', () => {
    setToken('abc')
    clearToken()
    expect(getToken()).toBeNull()
  })

  test('getBaseUrl returns default when unset', () => {
    expect(getBaseUrl()).toBe(AUTH_DEFAULT_BASE_URL)
  })

  test('setBaseUrl strips trailing slash and persists', () => {
    setBaseUrl('http://localhost:8080/')
    expect(getBaseUrl()).toBe('http://localhost:8080')
  })

  test('setBaseUrl resetting to default clears storage', () => {
    setBaseUrl('http://other:9000')
    setBaseUrl(AUTH_DEFAULT_BASE_URL)
    expect(window.localStorage.getItem('agent-workflow.baseUrl')).toBeNull()
  })

  test('subscribeAuth notifies on setToken / clearToken / setBaseUrl', () => {
    const listener = vi.fn()
    const unsub = subscribeAuth(listener)
    setToken('one')
    setBaseUrl('http://x:1')
    clearToken()
    expect(listener).toHaveBeenCalledTimes(3)
    unsub()
    setToken('two')
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
