import { describe, expect, it } from 'vitest'
import { applyAppThemeVariables, naiveThemeOverrides } from './naive-theme'

describe('Naive UI application theme', () => {
  it('shares the application primary palette with Naive UI', () => {
    const applied = new Map<string, string>()
    const root = {
      style: {
        setProperty: (name: string, value: string) => applied.set(name, value),
      },
    } as unknown as HTMLElement
    applyAppThemeVariables(root)

    expect(applied.get('--accent')).toBe('#0969da')
    expect(applied.get('--surface-hover')).toBe('#eaeef2')
    expect(naiveThemeOverrides.common?.primaryColor).toBe('#0969da')
    expect(naiveThemeOverrides.common?.hoverColor).toBe('#eaeef2')
  })
})
