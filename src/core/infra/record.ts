export interface AsRecordOptions {
  /** When true, return null instead of throwing on invalid input. */
  orNull?: boolean;
}

/** Spread only entries whose values are not undefined (exactOptionalPropertyTypes-safe). */
export function spreadDefined<T extends Record<string, unknown>>(source: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/** Narrow unknown JSON/YAML values to a plain object record. */
export function asRecord(
  value: unknown,
  label: string,
  options?: AsRecordOptions
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (options?.orNull) return null;
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}