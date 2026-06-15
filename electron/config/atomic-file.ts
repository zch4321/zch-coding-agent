import { open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  const data = `${JSON.stringify(value, null, 2)}\n`
  const file = await open(temporaryPath, 'wx', 0o600)

  try {
    await file.writeFile(data, 'utf8')
    await file.sync()
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }

  await file.close()

  try {
    await rename(temporaryPath, filePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}
