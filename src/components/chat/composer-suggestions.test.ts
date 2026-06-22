import { describe, expect, it } from 'vitest'
import {
  detectComposerSuggestionTrigger,
  formatWorkspaceExpansionPath,
  formatWorkspaceSuggestionPath,
  replaceComposerRange,
  workspaceSuggestionQuery,
} from './composer-suggestions'

describe('composer suggestions', () => {
  it('detects line-leading slash commands', () => {
    expect(detectComposerSuggestionTrigger('/pl', 3)).toEqual({
      kind: 'slash',
      query: 'pl',
      replaceStart: 0,
      replaceEnd: 3,
    })
    expect(detectComposerSuggestionTrigger('ask\n/go', 7)).toEqual({
      kind: 'slash',
      query: 'go',
      replaceStart: 4,
      replaceEnd: 7,
    })
  })

  it('detects skill command names', () => {
    expect(detectComposerSuggestionTrigger('/skill live', 11)).toEqual({
      kind: 'skill',
      query: 'live',
      replaceStart: 7,
      replaceEnd: 11,
    })
  })

  it('detects workspace mentions at the cursor', () => {
    expect(
      detectComposerSuggestionTrigger(
        'Review @src/st',
        'Review @src/st'.length,
      ),
    ).toEqual({
      kind: 'context',
      query: 'src/st',
      replaceStart: 7,
      replaceEnd: 14,
    })
  })

  it('splits workspace mention lookups into directory and filter text', () => {
    expect(workspaceSuggestionQuery('src/st')).toEqual({
      directory: 'src',
      filter: 'st',
    })
    expect(workspaceSuggestionQuery('src/')).toEqual({
      directory: 'src',
      filter: '',
    })
    expect(workspaceSuggestionQuery('README')).toEqual({
      directory: '.',
      filter: 'README',
    })
  })

  it('replaces selected suggestion ranges', () => {
    expect(replaceComposerRange('/pl', 0, 3, '/plan ')).toBe('/plan ')
    expect(formatWorkspaceSuggestionPath('src', 'main.ts')).toBe('src/main.ts')
    expect(formatWorkspaceSuggestionPath('.', 'README.md')).toBe('README.md')
    expect(formatWorkspaceExpansionPath('src/components')).toBe(
      'src/components/',
    )
  })
})
