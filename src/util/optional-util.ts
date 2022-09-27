export function mapNullable<T, U>(
  value: T | null | undefined,
  mapFn: (v: T) => U | undefined
): U | undefined {
  return value == null ? undefined : mapFn(value)
}