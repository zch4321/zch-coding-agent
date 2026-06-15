import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { writeJsonAtomic } from './atomic-file'

interface SecretRecord {
  ciphertext: string
  updatedAt: string
}

interface SecretFile {
  schemaVersion: 1
  records: Record<string, SecretRecord>
}

export interface SafeStorageAdapter {
  readonly platform: NodeJS.Platform
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend(): string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export class ElectronSafeStorageAdapter implements SafeStorageAdapter {
  readonly platform = process.platform

  isAsyncEncryptionAvailable(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable()
  }

  getSelectedStorageBackend(): string {
    return this.platform === 'linux'
      ? safeStorage.getSelectedStorageBackend()
      : 'system'
  }

  encryptStringAsync(value: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(value)
  }

  decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return safeStorage.decryptStringAsync(value)
  }
}

export type SecretStorageStatus =
  | { available: true; backend: string }
  | {
      available: false
      backend: string
      reason: 'unavailable' | 'weak_backend' | 'temporary_failure'
    }

export class SecretStorageUnavailableError extends Error {
  readonly code = 'SECRET_STORAGE_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'SecretStorageUnavailableError'
  }
}

export class SecretStore {
  readonly #filePath: string
  readonly #adapter: SafeStorageAdapter
  #data: SecretFile = { schemaVersion: 1, records: {} }
  #status: SecretStorageStatus = {
    available: false,
    backend: 'unknown',
    reason: 'unavailable',
  }

  constructor(filePath: string, adapter: SafeStorageAdapter) {
    this.#filePath = filePath
    this.#adapter = adapter
  }

  get status(): SecretStorageStatus {
    return structuredClone(this.#status)
  }

  async initialize(): Promise<SecretStorageStatus> {
    await mkdir(path.dirname(this.#filePath), { recursive: true })
    this.#data = await this.#read()

    let available: boolean

    try {
      available = await this.#adapter.isAsyncEncryptionAvailable()
    } catch {
      this.#status = {
        available: false,
        backend: 'unknown',
        reason: 'temporary_failure',
      }
      return this.status
    }

    const backend = this.#adapter.getSelectedStorageBackend()

    if (!available) {
      this.#status = { available: false, backend, reason: 'unavailable' }
    } else if (this.#adapter.platform === 'linux' && backend === 'basic_text') {
      this.#status = { available: false, backend, reason: 'weak_backend' }
    } else {
      this.#status = { available: true, backend }
    }

    return this.status
  }

  has(reference: string | undefined): boolean {
    return reference !== undefined && reference in this.#data.records
  }

  async set(
    value: string,
    reference = `secret:${randomUUID()}`,
  ): Promise<string> {
    this.#assertAvailable()

    let encrypted: Buffer

    try {
      encrypted = await this.#adapter.encryptStringAsync(value)
    } catch {
      throw new SecretStorageUnavailableError(
        'Secret encryption is temporarily unavailable',
      )
    }

    this.#data.records[reference] = {
      ciphertext: encrypted.toString('base64'),
      updatedAt: new Date().toISOString(),
    }
    await this.#persist()
    return reference
  }

  async get(reference: string): Promise<string | undefined> {
    this.#assertAvailable()
    const record = this.#data.records[reference]

    if (!record) {
      return undefined
    }

    let decrypted: { result: string; shouldReEncrypt: boolean }

    try {
      decrypted = await this.#adapter.decryptStringAsync(
        Buffer.from(record.ciphertext, 'base64'),
      )
    } catch {
      throw new SecretStorageUnavailableError(
        'Secret decryption is temporarily unavailable',
      )
    }

    if (decrypted.shouldReEncrypt) {
      await this.set(decrypted.result, reference)
    }

    return decrypted.result
  }

  async delete(reference: string | undefined): Promise<void> {
    if (!reference || !(reference in this.#data.records)) {
      return
    }

    delete this.#data.records[reference]
    await this.#persist()
  }

  async #read(): Promise<SecretFile> {
    try {
      const content = await readFile(this.#filePath, 'utf8')
      const candidate = JSON.parse(content) as Partial<SecretFile>

      if (
        candidate.schemaVersion !== 1 ||
        !candidate.records ||
        typeof candidate.records !== 'object'
      ) {
        throw new Error('Invalid secret store format')
      }

      return {
        schemaVersion: 1,
        records: candidate.records,
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { schemaVersion: 1, records: {} }
      }

      throw error
    }
  }

  async #persist(): Promise<void> {
    await writeJsonAtomic(this.#filePath, this.#data)
  }

  #assertAvailable(): void {
    if (!this.#status.available) {
      throw new SecretStorageUnavailableError(
        `Secret storage is unavailable (${this.#status.reason}, ${this.#status.backend})`,
      )
    }
  }
}
