// RFC-083 PR-E — source-text backstops the unit tests can't observe.
//  1. The ALWAYS-ON baseline path (baseline / gitBackend / assemble / impact)
//     must NOT import deep/* — else protobufjs gets pulled into every structural
//     analysis (and risks the RFC-079 binary-init-cycle). Deep is reached only
//     via the service orchestrator, on `?mode=deep`.
//  2. The two-tier confidence contract: precise = 'extracted', heuristic =
//     'inferred'. Lock it at source so a refactor can't silently blur them.
//  3. runner wires a timeout (runtime not observable in CI).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SD = resolve(import.meta.dir, '..', 'src', 'services', 'structuralDiff')
const read = (rel: string): string => readFileSync(resolve(SD, rel), 'utf8')

describe('deep/ stays out of the always-on baseline path', () => {
  for (const f of ['baseline.ts', 'gitBackend.ts', 'assemble.ts', 'impact.ts']) {
    test(`${f} does not import deep/`, () => {
      const src = read(f)
      expect(src).not.toMatch(/from ['"]\.\/deep\//)
      expect(src).not.toMatch(/protobufjs/)
    })
  }

  test('the shared barrel does not reference deep / protobuf', () => {
    const barrel = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'index.ts'),
      'utf8',
    )
    expect(barrel).not.toMatch(/deep/)
    expect(barrel).not.toMatch(/protobuf/)
  })
})

describe('two-tier confidence contract', () => {
  test("deep precise impact tags callers 'extracted'", () => {
    expect(read('deep/deepImpact.ts')).toMatch(/confidence: 'extracted'/)
  })
  test("baseline heuristic impact tags callers 'inferred'", () => {
    expect(read('impact.ts')).toMatch(/confidence: 'inferred'/)
  })
})

describe('deep runner safety', () => {
  test('runIndexer wires a timeout + kills the process', () => {
    const src = read('deep/runner.ts')
    expect(src).toMatch(/setTimeout/)
    expect(src).toMatch(/\.kill\(/)
    expect(src).toMatch(/timeoutMs/)
  })
  test('indexer binary is resolved from settings/PATH, no hardcoded abs dev path', () => {
    const src = read('deep/indexers.ts')
    expect(src).not.toMatch(/\/Users\/|\/home\/|\/opt\//)
    expect(src).toMatch(/resolveIndexerBin/)
  })
})
