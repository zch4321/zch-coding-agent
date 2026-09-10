import type { InjectionKey, Ref } from 'vue'

export const conversationResumeKey: InjectionKey<Ref<number>> = Symbol(
  'conversation-resume',
)
