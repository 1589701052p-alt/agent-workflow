// Supplementary coverage for diff sharding (P-3-01, packages/backend/src/util/diffSplit.ts).
//
// Locks two binary/rename boundary regressions that diff-split.test.ts never exercises:
//
//   GAP 1 [diffsplit-all-binary-drops-note] — When EVERY file in a diff is binary,
//     groupShards filters textFiles=[] so group([]) yields [] so the returned Shard[]
//     is empty. The binNote is still computed but attached to nothing, so an all-binary
//     diff (real changes, all dropped) collapses to the same empty result as a truly-empty
//     diff and the operator never learns the binary files were skipped. This file pins
//     that boundary so any future change that starts emitting a note-carrying shard (or
//     otherwise distinguishes the two) is a deliberate, test-visible decision.
//
//   GAP 2 [diffsplit-rename-binary-mixed-per-directory] — splitDiffPerDirectory groups a
//     rename by its NEW path (oldPath preserved in raw but ignored for grouping), never
//     creates a text shard for a binary file, and fans the binary-files footer out to
//     EVERY resulting directory shard. The 3-file fixture below (rename old/->new/, edit
//     in new/, plain edit in lib/, binary in assets/) is the minimal combination that
//     actually demonstrates the footer landing on >1 shard simultaneously.
//
// Synthetic diff fixtures keep these Bun-only — no git invoked. Expected values were
// confirmed against the live implementation before commit.

import { describe, expect, test } from 'bun:test'
import { parseDiff, splitDiffPerDirectory, splitDiffPerFile } from '../src/util/diffSplit'

// Two binary files, no text file at all.
const ALL_BINARY = `diff --git a/x.png b/x.png
Binary files a/x.png and b/x.png differ
diff --git a/y.bin b/y.bin
Binary files a/y.bin and b/y.bin differ
`

// rename (old/ -> new/) + ordinary edit in new/ + plain edit in lib/ + binary in assets/.
// Three text files across two directories so the binary footer must fan out to >1 shard.
const MIXED = `diff --git a/old/x.ts b/new/x.ts
similarity index 100%
rename from old/x.ts
rename to new/x.ts
diff --git a/new/y.ts b/new/y.ts
--- a/new/y.ts
+++ b/new/y.ts
@@ -1 +1 @@
-old
+new
diff --git a/lib/z.ts b/lib/z.ts
--- a/lib/z.ts
+++ b/lib/z.ts
@@ -1 +1 @@
-a
+b
diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
`

const BINARY_FOOTER = '\n\nbinary files: assets/logo.png'

describe('all-binary diff boundary (diffsplit-all-binary-drops-note)', () => {
  test('parseDiff flags both files binary (inputs really are binary)', () => {
    const files = parseDiff(ALL_BINARY)
    expect(files).toHaveLength(2)
    expect(files[0]?.binary).toBe(true)
    expect(files[1]?.binary).toBe(true)
  })

  test('splitDiffPerFile of an all-binary diff yields zero shards — binary note delivered to nobody', () => {
    const shards = splitDiffPerFile(ALL_BINARY)
    expect(shards).toHaveLength(0)
    // The note is computed inside groupShards but, with no text shard to carry it,
    // it reaches no shard at all.
    expect(shards.some((s) => s.content.includes('binary files:'))).toBe(false)
  })

  test('splitDiffPerDirectory of an all-binary diff yields zero shards', () => {
    const shards = splitDiffPerDirectory(ALL_BINARY, 1)
    expect(shards).toHaveLength(0)
  })
})

describe('rename + binary-skip + per-directory (diffsplit-rename-binary-mixed-per-directory)', () => {
  test('rename grouped by NEW path, binary creates no shard, footer fanned to every shard', () => {
    const shards = splitDiffPerDirectory(MIXED, 1)

    // Two text directory groups (lib, new); the binary 'assets' file is filtered
    // before grouping so it never forms a shard, and the rename's 'old' directory
    // never appears because grouping keys on the NEW path.
    expect(shards).toHaveLength(2)

    const keys = shards.map((s) => s.shardKey)
    expect(keys).toEqual(['lib/z.ts', 'new/x.ts'])
    expect(keys).not.toContain('assets/logo.png')
    expect(shards.some((s) => s.shardKey.startsWith('old/'))).toBe(false)

    // Sorted by group key ascending: lib then new.
    const lib = shards[0]
    const newDir = shards[1]

    expect(lib?.files).toEqual(['lib/z.ts'])

    // shardKey for the multi-file 'new' bucket is the lexicographically-smallest path.
    expect(newDir?.shardKey).toBe('new/x.ts')
    expect(newDir?.files).toEqual(['new/x.ts', 'new/y.ts'])
    // oldPath is preserved verbatim in the raw rename block (grouping ignored it).
    expect(newDir?.content).toContain('rename from old/x.ts')
    expect(newDir?.content).toContain('rename to new/x.ts')
    // ... but the old directory did NOT spawn its own shard.
    expect(newDir?.content).not.toContain('binary files: assets/logo.png\nbinary')
  })

  test('the binary-files footer is appended identically to BOTH directory shards', () => {
    const shards = splitDiffPerDirectory(MIXED, 1)
    expect(shards).toHaveLength(2)
    for (const shard of shards) {
      expect(shard.content.endsWith(BINARY_FOOTER)).toBe(true)
    }
    // Both tails are the same footer — the note fanned out to all shards.
    const tails = shards.map((s) => s.content.slice(-BINARY_FOOTER.length))
    expect(tails).toEqual([BINARY_FOOTER, BINARY_FOOTER])
  })
})
