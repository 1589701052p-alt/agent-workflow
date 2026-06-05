// RFC-083 PR-B — dependency manifest parsers (the static "new external package"
// signal). Each parser maps a manifest's text to declared {packageName →
// version|null}. Parsing is deliberately best-effort and tolerant: a manifest
// the agent left half-edited (non-compiling) must still yield whatever deps it
// can, never throw. The diff layer (deps/diff.ts) set-diffs old vs new maps.
//
// Coverage: npm/cargo/go/pip/poetry/maven/gradle/sbt/vcpkg/cmake/conan. Lockfiles
// are out of scope for v1 (manifests are the human-authored intent; lockfile
// resolution is a follow-up).

import type { Ecosystem } from '@agent-workflow/shared'

/** Map a manifest filename (basename) to its ecosystem, or null. */
export function ecosystemForManifest(filePath: string): Ecosystem | null {
  const base = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'package.json') return 'npm'
  if (base === 'cargo.toml') return 'cargo'
  if (base === 'go.mod') return 'go'
  if (base === 'pyproject.toml') return 'pip' // poetry detected at parse time
  if (base === 'requirements.txt' || /^requirements.*\.txt$/.test(base)) return 'pip'
  if (base === 'pom.xml') return 'maven'
  if (base === 'build.gradle' || base === 'build.gradle.kts') return 'gradle'
  if (base === 'build.sbt') return 'sbt'
  if (base === 'vcpkg.json') return 'vcpkg'
  if (base === 'cmakelists.txt') return 'cmake'
  if (base === 'conanfile.txt') return 'conan'
  return null
}

export type DepMap = Map<string, string | null>

/** Parse a manifest's declared dependencies. Never throws. */
export function parseManifest(ecosystem: Ecosystem, content: string): DepMap {
  try {
    switch (ecosystem) {
      case 'npm':
        return parseNpm(content)
      case 'cargo':
        return parseCargo(content)
      case 'go':
        return parseGoMod(content)
      case 'pip':
      case 'poetry':
        return parsePython(content)
      case 'maven':
        return parseMaven(content)
      case 'gradle':
        return parseGradle(content)
      case 'sbt':
        return parseSbt(content)
      case 'vcpkg':
        return parseVcpkg(content)
      case 'cmake':
        return parseCmake(content)
      case 'conan':
        return parseConan(content)
    }
  } catch {
    return new Map()
  }
}

function parseNpm(content: string): DepMap {
  const out: DepMap = new Map()
  const json = JSON.parse(content) as Record<string, unknown>
  for (const key of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const block = json[key]
    if (block !== null && typeof block === 'object') {
      for (const [name, ver] of Object.entries(block as Record<string, unknown>)) {
        out.set(name, typeof ver === 'string' ? ver : null)
      }
    }
  }
  return out
}

// Minimal TOML reader for Cargo's [dependencies]-style tables. Handles both
// `name = "1.0"` and `name = { version = "1.0", ... }`. Good enough for dep
// extraction without a full TOML dependency.
function parseCargo(content: string): DepMap {
  const out: DepMap = new Map()
  const depTable = /^\[(?:dev-|build-)?dependencies(?:\.[\w-]+)?\]/
  let inDeps = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inDeps = depTable.test(line)
      // `[dependencies.foo]` table → the dep is `foo`
      const sub = line.match(/^\[(?:dev-|build-)?dependencies\.([\w-]+)\]/)
      if (sub?.[1] !== undefined) out.set(sub[1], null)
      continue
    }
    if (!inDeps || line === '' || line.startsWith('#')) continue
    const m = line.match(/^([\w-]+)\s*=\s*(.+)$/)
    if (m?.[1] === undefined) continue
    const name = m[1]
    const rhs = m[2] ?? ''
    const verStr = rhs.match(/^"([^"]*)"/)
    const verInline = rhs.match(/version\s*=\s*"([^"]*)"/)
    out.set(name, verStr?.[1] ?? verInline?.[1] ?? null)
  }
  return out
}

function parseGoMod(content: string): DepMap {
  const out: DepMap = new Map()
  let inBlock = false
  for (const raw of content.split('\n')) {
    let line = raw.trim()
    if (line.startsWith('//')) continue
    if (line.startsWith('require (')) {
      inBlock = true
      continue
    }
    if (inBlock && line === ')') {
      inBlock = false
      continue
    }
    if (line.startsWith('require ')) line = line.slice('require '.length).trim()
    else if (!inBlock) continue
    // `module/path v1.2.3` (optionally `// indirect`)
    const m = line.match(/^([^\s]+)\s+(v[^\s]+)/)
    if (m?.[1] !== undefined) out.set(m[1], m[2] ?? null)
  }
  return out
}

function parsePython(content: string): DepMap {
  const out: DepMap = new Map()
  // requirements.txt lines OR pyproject [project].dependencies / poetry table.
  // Lightweight: scan for `name (==|>=|~=|<=|>|<) ver` and quoted PEP 508 specs.
  const specRe =
    /^["']?([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:==|>=|~=|!=|<=|<|>)?\s*([0-9][\w.*-]*)?/
  let inDeps = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^\[(tool\.poetry\.dependencies|project)\]/.test(line)) {
      inDeps = true
      continue
    }
    if (line.startsWith('[')) inDeps = false
    if (line.startsWith('dependencies') && line.includes('[')) inDeps = true
    if (line === ']') inDeps = false
    const stripped = line.replace(/^["']|["'],?$/g, '')
    const m = stripped.match(specRe)
    if (m?.[1] !== undefined && /[A-Za-z]/.test(m[1]) && m[1].toLowerCase() !== 'python') {
      // Only accept obvious dependency lines: requirements.txt always, pyproject
      // only inside a deps context.
      if (inDeps || /[=<>~!]/.test(line) || !line.includes('=')) {
        out.set(m[1], m[2] ?? null)
      }
    }
  }
  return out
}

function parseMaven(content: string): DepMap {
  const out: DepMap = new Map()
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g
  let m: RegExpExecArray | null
  while ((m = depRe.exec(content)) !== null) {
    const body = m[1] ?? ''
    const g = body.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim()
    const a = body.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim()
    const v = body.match(/<version>([^<]+)<\/version>/)?.[1]?.trim()
    if (g !== undefined && a !== undefined) out.set(`${g}:${a}`, v ?? null)
  }
  return out
}

function parseGradle(content: string): DepMap {
  const out: DepMap = new Map()
  const cfg =
    /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor|kapt)\b/
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!cfg.test(line)) continue
    // 'group:artifact:version' or "group:artifact:version"
    const m = line.match(/["']([\w.-]+):([\w.-]+):([\w.${}-]+)["']/)
    if (m?.[1] !== undefined) {
      out.set(`${m[1]}:${m[2]}`, m[3] ?? null)
      continue
    }
    const noVer = line.match(/["']([\w.-]+):([\w.-]+)["']/)
    if (noVer?.[1] !== undefined) out.set(`${noVer[1]}:${noVer[2]}`, null)
  }
  return out
}

function parseSbt(content: string): DepMap {
  const out: DepMap = new Map()
  // "org" %% "name" % "version"  OR  "org" % "name" % "version"
  const re = /"([\w.-]+)"\s*%%?\s*"([\w.-]+)"\s*%\s*"([\w.${}-]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) out.set(`${m[1]}:${m[2]}`, m[3] ?? null)
  }
  return out
}

function parseVcpkg(content: string): DepMap {
  const out: DepMap = new Map()
  const json = JSON.parse(content) as { dependencies?: unknown }
  if (Array.isArray(json.dependencies)) {
    for (const dep of json.dependencies) {
      if (typeof dep === 'string') out.set(dep, null)
      else if (dep !== null && typeof dep === 'object') {
        const name = (dep as { name?: unknown }).name
        const ver = (dep as { version?: unknown })['version']
        if (typeof name === 'string') out.set(name, typeof ver === 'string' ? ver : null)
      }
    }
  }
  return out
}

function parseCmake(content: string): DepMap {
  const out: DepMap = new Map()
  const re = /find_package\s*\(\s*([A-Za-z0-9_-]+)(?:\s+([0-9][\w.]*))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) out.set(m[1], m[2] ?? null)
  }
  return out
}

function parseConan(content: string): DepMap {
  const out: DepMap = new Map()
  let inReq = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line === '[requires]') {
      inReq = true
      continue
    }
    if (line.startsWith('[')) inReq = false
    if (!inReq || line === '' || line.startsWith('#')) continue
    // name/version  (e.g. zlib/1.2.13)
    const m = line.match(/^([A-Za-z0-9_.-]+)\/([\w.@/+-]+)/)
    if (m?.[1] !== undefined) out.set(m[1], m[2] ?? null)
  }
  return out
}
