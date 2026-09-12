type SaveResponse<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: { message: string } }

export interface SettingsDraftSnapshot<Draft> {
  value: Draft
  signature: string
}

interface PendingSave {
  promise: Promise<boolean>
  activeSignature: string
  queuedSignature?: string
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
  const capture = (): SettingsDraftSnapshot<Draft> | undefined => {
    const value = options.read()
    if (value === undefined) return undefined
    const signature = settingsDraftSignature(value)
    return { value: JSON.parse(signature) as Draft, signature }
  }
  // Every explicit save captures its input, including requests queued behind an active write.
  let snapshot = capture()
  const existing = operations.get(options.key)
  if (existing) {
    if (snapshot)
      existing.queuedSignature =
        snapshot.signature === existing.activeSignature
          ? undefined
          : snapshot.signature
    return existing.promise
  }
  if (!snapshot) return Promise.resolve(false)
  const operation: PendingSave = {
    promise: Promise.resolve(false),
    activeSignature: snapshot.signature,
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
        const queuedSignature = operation.queuedSignature
        operation.queuedSignature = undefined
        if (options.drain) {
          if (unchanged) return true
          snapshot = capture()
        } else {
          if (queuedSignature === undefined) return true
          snapshot = {
            value: JSON.parse(queuedSignature) as Draft,
            signature: queuedSignature,
          }
        }
        if (snapshot) operation.activeSignature = snapshot.signature
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
  options.pending(true)
  return operation.promise
}
