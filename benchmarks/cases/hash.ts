import { createHash } from 'node:crypto'
import type { BenchmarkArchive } from './contracts'

/** Computes a SHA-256 hex digest for a string or byte buffer. */
export function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Computes a deterministic SHA-256 digest over the sorted files in a benchmark archive. */
export function archiveTreeSha256(archive: BenchmarkArchive): string {
  const hash = createHash('sha256')
  for (const file of [...archive.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    const content = Buffer.from(file.content, 'utf8')
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.executable ? 'x' : '-')
    hash.update('\0')
    hash.update(String(content.byteLength))
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}
