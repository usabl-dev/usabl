/**
 * Compares two strings by UTF-16 code units. Use it in place of localeCompare wherever an order
 * reaches the gate or a stored record: a locale compare changes with the machine's locale, and it
 * returns zero for some distinct strings, which leaves the order to arrival.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable sort by a string key, using UTF-16 code-unit order. Returns a new array. */
export function sortBy<T>(items: T[], keyFn: (t: T) => string): T[] {
  return items
    .map((value, index) => ({ value, index, key: keyFn(value) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((x) => x.value);
}
