/**
 * Branded System 1 inbox input identifier constructor.
 *
 * @module @deepseek-ai/dsh-system1-workflow/input-id
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { System1InputId as System1InputIdBrand } from './types.ts'

/** Branded inbox input identifier; see `./types.ts`. */
export type System1InputId = System1InputIdBrand

/**
 * Brand a string as a {@link System1InputId}.
 * @param id - the raw input identifier.
 * @returns the branded input identifier.
 */
export function System1InputId(id: string): System1InputId {
  return brandString<System1InputId>(id)
}

/**
 * Mint a fresh inbox input identifier. UUID-backed so identifiers stay
 * unique across process restarts that share one session log; recovery
 * matches transitions to enqueues by this identity.
 * @returns a new branded input identifier.
 */
export function newSystem1InputId(): System1InputId {
  return System1InputId(`inbox-input-${randomUUID()}`)
}
