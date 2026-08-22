import type { DiagnosticId } from '../../shared/ids'

const diagnosedErrors = new WeakMap<object, DiagnosticId>()
const diagnosedCodes = new WeakMap<object, string>()

/** Associates a diagnostic ID with an error without mutating Provider objects. */
export function associateDiagnosticId(
  error: unknown,
  diagnosticId: DiagnosticId | undefined,
): void {
  if (!diagnosticId || !error || typeof error !== 'object') return
  diagnosedErrors.set(error, diagnosticId)
}

/** Associates a stable public code with an error for enclosing Run handling. */
export function associateDiagnosticCode(error: unknown, code: string): void {
  if (!error || typeof error !== 'object') return
  diagnosedCodes.set(error, code)
}

/** Returns a previously associated diagnostic ID, following bounded causes. */
export function diagnosticIdForError(
  error: unknown,
  depth = 0,
): DiagnosticId | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = diagnosedErrors.get(error)
  if (direct || depth >= 2) return direct
  return diagnosticIdForError(Reflect.get(error, 'cause'), depth + 1)
}

/** Returns an associated stable code, following bounded causes. */
export function diagnosticCodeForError(
  error: unknown,
  depth = 0,
): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = diagnosedCodes.get(error)
  if (direct || depth >= 2) return direct
  return diagnosticCodeForError(Reflect.get(error, 'cause'), depth + 1)
}
