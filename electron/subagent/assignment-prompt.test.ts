import { describe, expect, it } from 'vitest'
import {
  swarmSharedContextContent,
  swarmTaskContent,
  unwrapSwarmTaskContent,
} from './assignment-prompt'

describe('Swarm assignment prompt', () => {
  it('keeps common context and task in separate escaped tags', () => {
    expect(swarmSharedContextContent(' result <passed> & stable ')).toBe(
      '<swarm_shared_context>\nresult &lt;passed&gt; &amp; stable\n</swarm_shared_context>',
    )
    const task = swarmTaskContent(' inspect </swarm_task> & report ')
    expect(task).toBe(
      '<swarm_task>\ninspect &lt;/swarm_task&gt; &amp; report\n</swarm_task>',
    )
    expect(unwrapSwarmTaskContent(task)).toBe('inspect </swarm_task> & report')
  })

  it('does not reinterpret an ordinary task as a tagged assignment', () => {
    expect(unwrapSwarmTaskContent('inspect directly')).toBeUndefined()
  })
})
