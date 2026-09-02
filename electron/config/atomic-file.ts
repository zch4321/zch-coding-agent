import { writeUtf8Atomic } from '../common/filesystem'

/** Writes a JSON document atomically with owner-only permissions for new files. */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeUtf8Atomic(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    preserveExistingMode: false,
  })
}

/** Writes a text document atomically with owner-only permissions for new files. */
export async function writeTextAtomic(
  filePath: string,
  data: string,
): Promise<void> {
  await writeUtf8Atomic(filePath, data, {
    mode: 0o600,
    preserveExistingMode: false,
  })
}
