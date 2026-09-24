/**
 * System 1 MCP: resilient tool adapter with controlled mutations.
 *
 * @module @deepseek-ai/dsh-system1-mcp
 */

/** Package version marker (ensures the barrel has executable statements). */
export const MCP_PACKAGE_VERSION = '0.1.7-alpha.2'

export { McpAdapter } from './adapter.ts'
export type {
  McpToolDefinition,
  McpExecutor,
  CircuitState,
  McpAdapterConfig,
} from './adapter.ts'
