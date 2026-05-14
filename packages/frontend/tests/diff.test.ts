// Sanity-check the DiffViewer's diff parser + per-line classifier.

import { describe, expect, test } from 'vitest'
import { __testLineClass as cls, __testSplitByFile as split } from '../src/components/DiffViewer'

const TWO_FILE = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
-old
+new
diff --git a/bar.ts b/bar.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/bar.ts
@@ -0,0 +1 @@
+hi
`

describe('splitByFile', () => {
  test('splits on each diff --git boundary', () => {
    const blocks = split(TWO_FILE)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.header).toBe('foo.ts')
    expect(blocks[1]?.header).toBe('bar.ts')
  })

  test('renames render with arrow in header', () => {
    const renamed = `diff --git a/old.ts b/new.ts\nsimilarity index 90%\n`
    const blocks = split(renamed)
    expect(blocks[0]?.header).toBe('old.ts → new.ts')
  })

  test('preamble before first diff is bucketed under "(preamble)"', () => {
    const blocks = split('garbage\ndiff --git a/x b/x\n')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.header).toBe('(preamble)')
    expect(blocks[1]?.header).toBe('x')
  })
})

describe('lineClass', () => {
  test('+ and - lines colored as add/del', () => {
    expect(cls('+new')).toBe('diff__add')
    expect(cls('-gone')).toBe('diff__del')
  })

  test('hunk markers and file path markers separately classed', () => {
    expect(cls('@@ -1,2 +1,2 @@')).toBe('diff__hunk')
    expect(cls('+++ b/foo.ts')).toBe('diff__meta')
    expect(cls('--- a/foo.ts')).toBe('diff__meta')
  })

  test('context lines fall through to ctx', () => {
    expect(cls(' unchanged')).toBe('diff__ctx')
    expect(cls('')).toBe('diff__ctx')
  })

  test('metadata lines (index/new file/rename) are meta', () => {
    expect(cls('index abc..def 100644')).toBe('diff__meta')
    expect(cls('new file mode 100644')).toBe('diff__meta')
    expect(cls('rename from old')).toBe('diff__meta')
  })
})
