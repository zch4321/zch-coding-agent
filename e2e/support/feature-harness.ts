import { rm } from 'node:fs/promises'
import {
  closeElectronApplication,
  launchElectronHarness,
  type ElectronHarness,
} from './electron-harness'
import { startFakeProvider, type FakeProvider } from './fake-provider'

export interface FeatureHarness extends ElectronHarness {
  fakeProvider: FakeProvider
}

export async function launchFeatureHarness(): Promise<FeatureHarness> {
  const fakeProvider = await startFakeProvider()
  try {
    const electronHarness = await launchElectronHarness('agent-feature-e2e-')
    return { ...electronHarness, fakeProvider }
  } catch (error) {
    await fakeProvider.close()
    throw error
  }
}

export async function disposeFeatureHarness(
  harness: FeatureHarness,
): Promise<void> {
  await closeElectronApplication(harness)
  await harness.fakeProvider.close()
  await rm(harness.temporaryRoot, { recursive: true, force: true })
}
