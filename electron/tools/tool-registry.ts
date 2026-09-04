/**
 * Compatibility facade for existing business modules. New infrastructure code
 * should import ToolRegistry and ToolExecutor from `electron/tooling`.
 */
export { ToolRegistry } from '../tooling/registry'
export { ToolExecutor } from '../tooling/executor'
