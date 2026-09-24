/**
 * Branded System 1 request identifier constructor.
 *
 * @module @deepseek-ai/dsh-system1-workflow/request-id
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { System1RequestId } from './types.ts'

/**
 * Brand a string as a {@link System1RequestId}.
 * @param id - the raw request identifier.
 * @returns the branded request identifier.
 */
export function System1RequestId(id: string): System1RequestId {
  return brandString<System1RequestId>(id)
}
