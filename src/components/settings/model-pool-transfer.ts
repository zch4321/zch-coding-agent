/** Preserves pool order while applying target-tree changes to visible routes. */
export function reconcileVisibleRouteSelection(
  selectedKeys: readonly string[],
  visibleKeys: ReadonlySet<string>,
  checkedKeys: readonly (string | number)[],
): string[] {
  const checkedVisibleKeys = new Set(
    checkedKeys.map(String).filter((key) => visibleKeys.has(key)),
  )
  return selectedKeys.filter(
    (key) => !visibleKeys.has(key) || checkedVisibleKeys.has(key),
  )
}
