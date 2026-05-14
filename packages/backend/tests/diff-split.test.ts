// Sharding strategies for multi-process node fan-out (P-3-01).
//
// Synthetic diff fixtures keep these tests Bun-only — no git invoked.

import { describe, expect, test } from 'bun:test'
import {
  parseDiff,
  splitDiffPerDirectory,
  splitDiffPerFile,
  splitDiffPerNFiles,
} from '../src/util/diffSplit'

const TWO_FILE = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/docs/readme.md b/docs/readme.md
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1 +1 @@
-old doc
+new doc
`

const WITH_BINARY = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
`

const WITH_RENAME = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
`

describe('parseDiff', () => {
  test('splits on each diff --git boundary', () => {
    const files = parseDiff(TWO_FILE)
    expect(files).toHaveLength(2)
    expect(files[0]?.path).toBe('src/a.ts')
    expect(files[1]?.path).toBe('docs/readme.md')
  })

  test('flags binary file blocks', () => {
    const files = parseDiff(WITH_BINARY)
    expect(files[0]?.binary).toBe(false)
    expect(files[1]?.binary).toBe(true)
  })

  test('renames stay a single FileDiff with both oldPath + path', () => {
    const files = parseDiff(WITH_RENAME)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('src/new.ts')
    expect(files[0]?.oldPath).toBe('src/old.ts')
  })

  test('handles empty diff cleanly', () => {
    expect(parseDiff('')).toEqual([])
  })
})

describe('splitDiffPerFile', () => {
  test('one shard per file', () => {
    const shards = splitDiffPerFile(TWO_FILE)
    expect(shards).toHaveLength(2)
    expect(shards[0]?.shardKey).toBe('src/a.ts')
    expect(shards[1]?.shardKey).toBe('docs/readme.md')
    expect(shards[0]?.content).toContain('src/a.ts')
    expect(shards[1]?.content).toContain('readme.md')
  })

  test('appends binary-files note to text shards', () => {
    const shards = splitDiffPerFile(WITH_BINARY)
    expect(shards).toHaveLength(1) // only the text file becomes a shard
    expect(shards[0]?.content).toContain('binary files: assets/logo.png')
    expect(shards[0]?.files).toEqual(['src/a.ts'])
  })

  test('rename → exactly one shard', () => {
    const shards = splitDiffPerFile(WITH_RENAME)
    expect(shards).toHaveLength(1)
    expect(shards[0]?.shardKey).toBe('src/new.ts')
    expect(shards[0]?.content).toContain('rename from src/old.ts')
  })
})

describe('splitDiffPerNFiles', () => {
  test('groups files in chunks of N', () => {
    const diff = [
      'diff --git a/a b/a',
      '@@ -1 +1 @@',
      '-1',
      '+1',
      'diff --git a/b b/b',
      '@@ -1 +1 @@',
      '-2',
      '+2',
      'diff --git a/c b/c',
      '@@ -1 +1 @@',
      '-3',
      '+3',
    ].join('\n')
    const shards = splitDiffPerNFiles(diff, 2)
    expect(shards).toHaveLength(2)
    expect(shards[0]?.files).toEqual(['a', 'b'])
    expect(shards[1]?.files).toEqual(['c'])
  })

  test('rejects n < 1', () => {
    expect(() => splitDiffPerNFiles('', 0)).toThrow()
    expect(() => splitDiffPerNFiles('', -1)).toThrow()
  })
})

describe('splitDiffPerDirectory', () => {
  test('groups files by depth-1 directory prefix', () => {
    const shards = splitDiffPerDirectory(TWO_FILE, 1)
    expect(shards).toHaveLength(2)
    const keys = shards.map((s) => s.shardKey).sort()
    expect(keys).toEqual(['docs/readme.md', 'src/a.ts'])
  })

  test('depth=2 groups by first two path segments', () => {
    const diff = [
      'diff --git a/src/util/a.ts b/src/util/a.ts',
      '@@ -1 +1 @@',
      '-1',
      '+1',
      'diff --git a/src/util/b.ts b/src/util/b.ts',
      '@@ -1 +1 @@',
      '-2',
      '+2',
      'diff --git a/src/runtime/c.ts b/src/runtime/c.ts',
      '@@ -1 +1 @@',
      '-3',
      '+3',
    ].join('\n')
    const shards = splitDiffPerDirectory(diff, 2)
    // src/util → 2 files; src/runtime → 1 file → 2 shards total.
    expect(shards).toHaveLength(2)
    const fileGroups = shards.map((s) => s.files.sort())
    expect(fileGroups).toContainEqual(['src/runtime/c.ts'])
    expect(fileGroups).toContainEqual(['src/util/a.ts', 'src/util/b.ts'])
  })

  test('files at top-level fall into their own shard', () => {
    const diff = ['diff --git a/README b/README', '@@ -1 +1 @@', '-1', '+1'].join('\n')
    const shards = splitDiffPerDirectory(diff, 1)
    expect(shards).toHaveLength(1)
    expect(shards[0]?.files).toEqual(['README'])
  })

  test('rejects depth < 1', () => {
    expect(() => splitDiffPerDirectory('', 0)).toThrow()
  })
})
