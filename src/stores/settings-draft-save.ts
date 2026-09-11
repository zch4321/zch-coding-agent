type SaveResponse<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: { message: string } }

export interface SettingsDraftSnapshot<Draft> {
  value: Draft
  signature: string
}

interface PendingSave {
  promise: Promise<boolean>
  requestedAgain: boolean
}

const pendingByOwner = new WeakMap<object, Map<string, PendingSave>>()

/** Checks whether another command currently owns a domain's save lane. */
export function isSettingsSavePending(owner: object, key: string): boolean {
  return pendingByOwner.get(owner)?.has(key) ?? false
}

/** Fingerprints a JSON-compatible settings draft independently of Vue proxies. */
export function settingsDraftSignature(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

/** Serializes one domain's saves and acknowledges only the captured draft. */
export function saveSettingsDraft<Draft, Value>(options: {
  owner: object
  key: string
  read: () => Draft | undefined
  write: (draft: Draft) => Promise<SaveResponse<Value>>
  accept: (
    value: Value,
    snapshot: SettingsDraftSnapshot<Draft>,
    unchanged: boolean,
  ) => void
  pending: (saving: boolean) => void
  fail: (message: string) => void
  drain?: boolean
}): Promise<boolean> {
  let operations = pendingByOwner.get(options.owner)
  if (!operations) {
    operations = new Map()
    pendingByOwner.set(options.owner, operations)
  }
  const existing = operations.get(options.key)
  if (existing) {
    existing.requestedAgain = true
    return existing.promise
  }
  const capture = (): SettingsDraftSnapshot<Draft> | undefined => {
    const value = options.read()
    if (value === undefined) return undefined
    const signature = settingsDraftSignature(value)
    return { value: JSON.parse(signature) as Draft, signature }
  }
  // Capture synchronously, before a caller can change the draft after clicking Save.
  let snapshot = capture()
  if (!snapshot) return Promise.resolve(false)
  options.pending(true)
  const operation: PendingSave = {
    promise: Promise.resolve(false),
    requestedAgain: false,
  }
  operation.promise = Promise.resolve().then(async () => {
    try {
      while (snapshot) {
        const result = await options.write(snapshot.value)
        if (!result.ok) {
          options.fail(result.error.message)
          return false
        }
        const unchanged =
          settingsDraftSignature(options.read()) === snapshot.signature
        options.accept(result.value, snapshot, unchanged)
        if (unchanged || (!options.drain && !operation.requestedAgain))
          return true
        operation.requestedAgain = false
        snapshot = capture()
      }
      return false
    } catch (error) {
      options.fail(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      operations.delete(options.key)
      options.pending(false)
    }
  })
  operations.set(options.key, operation)
  return operation.promise
}
