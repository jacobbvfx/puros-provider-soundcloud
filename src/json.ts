/** Defensive readers for api-v2 JSON, whose fields are often absent or null. */

export type JsonRecord = Record<string, unknown>

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** api-v2 IDs are integers; they become decimal-string source IDs. */
export function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value
  return null
}

export function yearOf(value: unknown): number | null {
  const text = asString(value)
  const match = text?.match(/^(\d{4})-\d{2}-\d{2}/)
  if (!match) return null
  const year = Number(match[1])
  return year >= 1900 && year <= 2200 ? year : null
}
