// flag-audit W0（§5.6 布尔 query 解析四种口径）——HTTP 布尔 query 参数的统一
// 解析口。收口前同一语义四种写法：oidc `?force` 仅认 'true'（`?force=1` 静默变
// false）、memories 认 'true'|'1'、cached-repos/runtime 认 '1'|'true'、tasks
// `?cascade` 用 `!== 'false'` 的默认真双重否定。统一为：1/true/0/false（大小写
// 不敏感），缺省走调用方声明的 default，其余值 422 fail-loud（而非各站点随机
// 静默取默认）。

import type { Context } from 'hono'
import { ValidationError } from '@/util/errors'

const TRUE_VALUES = new Set(['1', 'true'])
const FALSE_VALUES = new Set(['0', 'false'])

export function parseBoolQuery(c: Context, name: string, opts: { default: boolean }): boolean {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return opts.default
  const v = raw.toLowerCase()
  if (TRUE_VALUES.has(v)) return true
  if (FALSE_VALUES.has(v)) return false
  throw new ValidationError(
    'invalid-bool-query',
    `query parameter '${name}' must be one of 1/true/0/false (got '${raw}')`,
  )
}
