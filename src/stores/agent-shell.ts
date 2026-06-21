import { defineStore } from 'pinia'

export const useAgentShellStore = defineStore('agent-shell', {
  state: () => ({
    initialized: false,
    bridgeAvailable: false,
    error: '',
    unsubscribers: [] as Array<() => void>,
  }),
  actions: {
    registerUnsubscriber(unsubscribe: () => void) {
      this.unsubscribers.push(unsubscribe)
    },
    disposeSubscriptions() {
      for (const unsubscribe of this.unsubscribers.splice(0)) {
        unsubscribe()
      }
    },
  },
})
