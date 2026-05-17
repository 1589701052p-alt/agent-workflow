// RFC-024: Git URL parsing, redaction, and cache-key derivation.
// Pure, dependency-free (Bun + browser-safe). Used by both frontend (input
// validation, redacted rendering) and backend (cache lookup, log redaction).

export type GitUrl =
  | { kind: 'ssh-uri'; user: string; host: string; port: number | null; path: string; raw: string }
  | { kind: 'ssh-scp'; user: string; host: string; path: string; raw: string }
  | {
      kind: 'http' | 'https'
      userInfo: string | null
      host: string
      port: number | null
      path: string
      raw: string
    }
  | { kind: 'file'; path: string; raw: string }

const SSH_SCP_RE = /^([A-Za-z0-9_.+-]+)@([A-Za-z0-9.-]+):(.+)$/
const HOST_RE = /^[A-Za-z0-9.-]+$/
const SCHEME_SSH_RE = /^ssh:\/\//i
const SCHEME_HTTP_RE = /^http:\/\//i
const SCHEME_HTTPS_RE = /^https:\/\//i
const SCHEME_FILE_RE = /^file:\/\//i

function isLikelyHost(s: string): boolean {
  return HOST_RE.test(s) && s.length >= 1 && s.length <= 255 && !s.startsWith('.')
}

function normalizePath(p: string): string {
  let r = p.trim()
  if (r.startsWith('/')) r = r.slice(1)
  return r
}

/**
 * Parse one of the three accepted Git URL shapes. Returns `null` for anything
 * we don't accept (no scheme + no `@`, file://, unknown scheme, embedded
 * whitespace, empty host/path, etc.). The caller renders `null` as a 400
 * `repo-url-invalid`.
 */
export function parseGitUrl(input: string): GitUrl | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (/\s/.test(trimmed)) return null

  // file:// — accepted for local mirror / test fixtures. No host, no creds.
  if (SCHEME_FILE_RE.test(trimmed)) {
    const after = trimmed.slice(7) // strip 'file://'
    // file:///abs/path → after starts with '/'; file://host/path is technically
    // valid but `git` ignores the host. We accept either and treat the path
    // as the rest. Empty path is rejected.
    if (after.length === 0) return null
    const path = after.startsWith('/') ? after.slice(1) : after.replace(/^[^/]+\//, '')
    if (path.length === 0) return null
    return { kind: 'file', path, raw: trimmed }
  }

  // ssh:// URI form
  if (SCHEME_SSH_RE.test(trimmed)) {
    const body = trimmed.slice(6) // strip 'ssh://'
    const atIdx = body.indexOf('@')
    if (atIdx <= 0) return null
    const user = body.slice(0, atIdx)
    const rest = body.slice(atIdx + 1)
    const slashIdx = rest.indexOf('/')
    if (slashIdx <= 0) return null
    const hostport = rest.slice(0, slashIdx)
    const path = rest.slice(slashIdx + 1)
    if (path.length === 0) return null
    let host = hostport
    let port: number | null = null
    if (hostport.includes(':')) {
      const colonIdx = hostport.indexOf(':')
      const h = hostport.slice(0, colonIdx)
      const pRaw = hostport.slice(colonIdx + 1)
      const pn = Number(pRaw)
      if (!Number.isInteger(pn) || pn <= 0 || pn > 65535) return null
      host = h
      port = pn
    }
    if (!isLikelyHost(host)) return null
    if (user.length === 0) return null
    return { kind: 'ssh-uri', user, host, port, path, raw: trimmed }
  }

  // http(s):// URI form
  if (SCHEME_HTTP_RE.test(trimmed) || SCHEME_HTTPS_RE.test(trimmed)) {
    const isHttps = SCHEME_HTTPS_RE.test(trimmed)
    const body = trimmed.slice(isHttps ? 8 : 7)
    const slashIdx = body.indexOf('/')
    if (slashIdx <= 0) return null
    const authority = body.slice(0, slashIdx)
    const path = body.slice(slashIdx + 1)
    if (path.length === 0) return null
    let userInfo: string | null = null
    let hostport = authority
    const atIdx = authority.lastIndexOf('@')
    if (atIdx >= 0) {
      userInfo = authority.slice(0, atIdx)
      hostport = authority.slice(atIdx + 1)
      if (userInfo.length === 0) return null
    }
    let host = hostport
    let port: number | null = null
    if (hostport.includes(':')) {
      const colonIdx = hostport.indexOf(':')
      const h = hostport.slice(0, colonIdx)
      const pRaw = hostport.slice(colonIdx + 1)
      const pn = Number(pRaw)
      if (!Number.isInteger(pn) || pn <= 0 || pn > 65535) return null
      host = h
      port = pn
    }
    if (!isLikelyHost(host)) return null
    return {
      kind: isHttps ? 'https' : 'http',
      userInfo,
      host,
      port,
      path,
      raw: trimmed,
    }
  }

  // SCP-like ssh form: user@host:path
  const m = SSH_SCP_RE.exec(trimmed)
  if (m) {
    const user = m[1] ?? ''
    const host = m[2] ?? ''
    const path = m[3] ?? ''
    if (!isLikelyHost(host)) return null
    if (path.length === 0) return null
    if (user.length === 0) return null
    // Rule out windows absolute paths like `C:/Users/x` which match SSH_SCP_RE
    // when the drive letter is single-char and host matches an alnum string.
    // Heuristic: hosts in real life always contain a `.`. Reject single-token
    // hosts unless the path itself doesn't look like a windows absolute path.
    if (!host.includes('.') && /^[\\/]/.test(path)) return null
    return { kind: 'ssh-scp', user, host, path, raw: trimmed }
  }

  return null
}

/**
 * Mask credentials in a URL so it's safe to log / display. We only mask
 * `http(s)://user[:pass]@` segments — the SSH `user@` component is the login
 * name (typically `git`), not a secret, and stripping it would distort the URL
 * past recognition. Pure string substitution: preserves trailing whitespace,
 * fragments, and other surrounding context so this can run over arbitrary log
 * lines or stderr output.
 */
export function redactGitUrl(input: string): string {
  if (typeof input !== 'string') return ''
  return input.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
}

/**
 * Canonicalize URL to a stable hash key. Different surface forms of the same
 * repo (with/without `.git`, trailing slash, ssh-scp vs ssh-uri, with or
 * without HTTPS user:pass) collapse to the same canonical string so the cache
 * is shared.
 */
function canonicalForHash(parsed: GitUrl): string {
  const stripPath = (p: string) => {
    let r = normalizePath(p)
    if (r.endsWith('/')) r = r.slice(0, -1)
    if (r.endsWith('.git')) r = r.slice(0, -4)
    return r.toLowerCase()
  }
  if (parsed.kind === 'file') {
    return `file:///${stripPath(parsed.path)}`
  }
  const host = parsed.host.toLowerCase()
  if (parsed.kind === 'http' || parsed.kind === 'https') {
    // Force https scheme + drop userInfo + drop port (rarely meaningful for
    // identity; differing ports for the same repo would be very unusual and
    // can be added later if needed).
    return `https://${host}/${stripPath(parsed.path)}`
  }
  // SSH (either scp or uri form): normalize to ssh://<user>@<host>/<path>
  const sshUser = parsed.kind === 'ssh-uri' || parsed.kind === 'ssh-scp' ? parsed.user : 'git'
  return `ssh://${sshUser.toLowerCase()}@${host}/${stripPath(parsed.path)}`
}

function lastPathSegment(p: string): string {
  let r = normalizePath(p)
  if (r.endsWith('/')) r = r.slice(0, -1)
  if (r.endsWith('.git')) r = r.slice(0, -4)
  const idx = r.lastIndexOf('/')
  const seg = idx >= 0 ? r.slice(idx + 1) : r
  // Strip filesystem-unsafe chars; keep alnum, dash, dot, underscore.
  const slug = seg.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'repo'
}

/**
 * Stable per-URL cache directory key: `sha1(canonical).slice(0,8) + '-' + slug`.
 * Used both as the row's `urlHash` and as the cache directory's basename.
 *
 * NOTE: sha1 is computed without a runtime dep by leveraging the Web Crypto
 * API which both Bun and modern browsers expose. Callers must `await` the
 * result. For tests / synchronous code paths, see `gitUrlCacheKeyHex` for an
 * injectable hasher.
 */
export async function gitUrlCacheKey(
  parsed: GitUrl,
): Promise<{ hash: string; slug: string; canonical: string }> {
  const canonical = canonicalForHash(parsed)
  // shared/tsconfig has lib:["ES2022"] which doesn't include the WHATWG
  // TextEncoder; we wall off the global lookup so both Bun and modern
  // browsers can satisfy it at runtime without a DOM lib pull.
  const TextEncoderCtor = (
    globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
  ).TextEncoder
  const data = new TextEncoderCtor().encode(canonical)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle = (globalThis as any).crypto?.subtle as
    | { digest: (algo: string, data: Uint8Array) => Promise<ArrayBuffer> }
    | undefined
  if (!subtle) {
    throw new Error('crypto.subtle not available — call gitUrlCacheKeyWith() and inject a hasher')
  }
  const buf = await subtle.digest('SHA-1', data)
  const hash = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8)
  const slug = lastPathSegment(parsed.path)
  return { hash, slug, canonical }
}

/**
 * Sync variant for callers that already have a sha1 implementation (backend
 * uses node:crypto). The hasher receives the canonical string and must
 * return its sha1 hex digest.
 */
export function gitUrlCacheKeyWith(
  parsed: GitUrl,
  sha1Hex: (s: string) => string,
): { hash: string; slug: string; canonical: string } {
  const canonical = canonicalForHash(parsed)
  const hash = sha1Hex(canonical).slice(0, 8)
  const slug = lastPathSegment(parsed.path)
  return { hash, slug, canonical }
}
