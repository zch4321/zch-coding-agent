import type { PublicConfig } from '../../shared/config'
import type { UiRememberedRule } from './agent-types'

/** Returns or updates now notice state. */
export function nowNotice(version: string) {
  return { version, acceptedAt: new Date().toISOString() }
}

/** Converts the input to ui remembered rules. */
export function toUiRememberedRules(config: PublicConfig): UiRememberedRule[] {
  return config.permission.rememberedRules.map((rule) => ({
    id: rule.id,
    effect: rule.effect,
    toolId: rule.toolId,
    workspaceScope: rule.workspaceScope,
    argConstraints: JSON.stringify(rule.argConstraints),
    expiresAt: rule.expiresAt,
    createdFromCallId: rule.createdFromCallId,
  }))
}
