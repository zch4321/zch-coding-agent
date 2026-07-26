import { safeStorage } from 'electron'
import type { SafeStorageAdapter } from './secret-store'

/** Adapts electron safe storage to its host interface. */
export class ElectronSafeStorageAdapter implements SafeStorageAdapter {
  readonly platform = process.platform

  /** Determines whether is async encryption available. */
  isAsyncEncryptionAvailable(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable()
  }

  /** Returns selected storage backend. */
  getSelectedStorageBackend(): string {
    return this.platform === 'linux'
      ? safeStorage.getSelectedStorageBackend()
      : 'system'
  }

  /** Returns or updates encrypt string async state. */
  encryptStringAsync(value: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(value)
  }

  /** Returns or updates decrypt string async state. */
  decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return safeStorage.decryptStringAsync(value)
  }
}
