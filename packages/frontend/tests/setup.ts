// vitest setup — runs once before the suite.
//
// Node 22+ ships a native `localStorage` global, but vitest invokes Node with
// `--localstorage-file` lacking a path, so the resulting Storage is a no-op
// `{}` shim with none of the Storage methods. Happy-dom doesn't shadow it
// either. Install a minimal in-memory shim so component code that uses
// `localStorage.getItem/setItem/clear` works under test.

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
}

const shim = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true })
if (typeof globalThis.window !== 'undefined') {
  Object.defineProperty(globalThis.window, 'localStorage', { value: shim, configurable: true })
}

export {}
