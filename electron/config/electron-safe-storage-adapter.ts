import { safeStorage } from 'electron'
import type { SafeStorageAdapter } from './secret-store'

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
