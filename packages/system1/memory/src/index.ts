/**
 * System 1 context: selection and memory.
 *
 * @module @deepseek-ai/dsh-system1-memory
 */

/** Package version marker (ensures the barrel has executable statements). */
export const MEMORY_PACKAGE_VERSION = '0.1.7-alpha.2'

export { WorkingMemory, ContextSelector } from './memory.ts'
export type {
  MemoryEntry,
  WorkingMemoryConfig,
  ContextSelectorConfig,
} from './memory.ts'
