import { safeStorage } from 'electron'
import type { SafeStorageAdapter } from './secret-store'

/** Adapts Electron safeStorage encryption to the process-neutral SecretStore interface. */
export class ElectronSafeStorageAdapter implements SafeStorageAdapter {
  readonly platform = process.platform

  /** Reports whether the current platform supports asynchronous safeStorage encryption. */
  isAsyncEncryptionAvailable(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable()
  }

  /** Returns the storage backend selected by Electron for the current platform. */
  getSelectedStorageBackend(): string {
    return this.platform === 'linux'
      ? safeStorage.getSelectedStorageBackend()
      : 'system'
  }

  /** Encrypts plaintext through Electron safeStorage and returns ciphertext bytes. */
  encryptStringAsync(value: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(value)
  }

  /** Decrypts safeStorage ciphertext and reports whether it should be re-encrypted. */
  decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return safeStorage.decryptStringAsync(value)
  }
}
