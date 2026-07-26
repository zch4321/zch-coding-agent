import type { PublicConfig } from '../../shared/config'
import type { UiRememberedRule } from './agent-types'

/** Creates the persisted notice acknowledgement record for a configuration version. */
export function nowNotice(version: string) {
  return { version, acceptedAt: new Date().toISOString() }
}

/** Maps public remembered permission rules to the renderer's UI rule shape. */
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
