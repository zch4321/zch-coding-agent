/** Exposes exactly the selected store members while retaining live getters and writes. */
export function pickStoreMembers<
  Store extends object,
  const Keys extends readonly (keyof Store)[],
>(store: Store, keys: Keys): Pick<Store, Keys[number]> {
  const facade = {} as Pick<Store, Keys[number]>
  for (const key of keys)
    Object.defineProperty(facade, key, {
      enumerable: true,
      get: () => store[key],
      set: (value: Store[typeof key]) => {
        Reflect.set(store, key, value)
      },
    })
  return facade
}

type Intersection<Value> = (
  Value extends unknown ? (value: Value) => void : never
) extends (value: infer Result) => void
  ? Result
  : never

/** Combines explicit capability objects without evaluating getters or allowing name collisions. */
export function combineStoreMembers<const Sources extends readonly object[]>(
  ...sources: Sources
): Intersection<Sources[number]> {
  const facade = {}
  for (const source of sources) {
    const descriptors = Object.getOwnPropertyDescriptors(source)
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Object.hasOwn(facade, key))
        throw new Error(`Duplicate facade capability: ${String(key)}`)
    }
    Object.defineProperties(facade, descriptors)
  }
  return facade as Intersection<Sources[number]>
}
