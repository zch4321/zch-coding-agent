// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  SETTINGS_PAGES,
  type SettingsDomain,
  type SettingsManagementPage,
} from './settings-tabs'

const CONFIG_DOMAINS: SettingsDomain[] = [
  'application',
  'assistant',
  'integrations',
  'models',
  'network',
  'providers',
  'runtime',
  'security',
]

const CONFIG_SECTIONS = [
  'assistant',
  'executionEnvironment',
  'limits',
  'logging',
  'mcp',
  'modelPool',
  'models',
  'network',
  'permission',
  'privacy',
  'prompts',
  'providers',
  'skills',
  'subagents',
  'webSearch',
  'workspace',
]

describe('settings page registry', () => {
  it('maps each config domain to exactly one menu page', () => {
    const domains = SETTINGS_PAGES.filter(
      (page) => page.group === 'configuration',
    ).map((page) => page.id as SettingsDomain)

    expect([...domains].sort()).toEqual([...CONFIG_DOMAINS].sort())
    expect(new Set(domains).size).toBe(CONFIG_DOMAINS.length)
  })

  it('assigns every granular config section to one domain', () => {
    const sections = SETTINGS_PAGES.filter(
      (page) => page.group === 'configuration',
    ).flatMap((page) => page.sections)

    expect([...sections].sort()).toEqual(CONFIG_SECTIONS)
    expect(new Set(sections).size).toBe(CONFIG_SECTIONS.length)
  })

  it('keeps data-management pages outside config ownership', () => {
    const pages = SETTINGS_PAGES.filter((page) => page.group === 'management')
    expect(pages.map((page) => page.id as SettingsManagementPage)).toEqual([
      'project',
      'archived',
    ])
    expect(pages.every((page) => page.sections.length === 0)).toBe(true)
  })
})
