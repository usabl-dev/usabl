/** Stable sort by a string key, using UTF-16 code-unit order. Returns a new array. */
export function sortBy<T>(items: T[], keyFn: (t: T) => string): T[] {
  return items
    .map((value, index) => ({ value, index, key: keyFn(value) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((x) => x.value);
}
