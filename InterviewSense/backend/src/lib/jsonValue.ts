/**
 * Normalizes Prisma `Json` field reads across client runtimes.
 *
 * Under the Rust-free driver-adapter client (Prisma's query compiler), Json
 * columns can arrive wrapped as `{ value: "<json string>" }` instead of a
 * parsed object. The native engine returns objects directly. unwrapJsonValue
 * is a pass-through for the native shape and unwraps the wrapped shape, so
 * application code works identically with either runtime.
 */
function parseJsonObject(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const parsed = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object') return { ok: true, value: parsed };
  } catch {
    // fall through: not JSON
  }
  return { ok: false };
}

export function unwrapJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    return parsed.ok ? parsed.value : value;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'value' && typeof (value as { value: unknown }).value === 'string') {
      const parsed = parseJsonObject((value as { value: string }).value);
      return parsed.ok ? parsed.value : value;
    }
  }
  return value;
}
