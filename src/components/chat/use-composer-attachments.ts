import { computed } from 'vue'
import { resolveImageInput } from '../../../shared/model-settings'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useProviderSettingsStore } from '../../stores/agent-settings'
import { useAgentRuntimeStore } from '../../stores/agent-runtime'
import { useComposerDraftsStore } from '../../stores/composer-drafts'
import { selectedDraftTarget } from '../../stores/composer-draft-view'
import { useAttachmentInputsStore } from '../../stores/attachment-inputs'

/** Connects browser paste/drop events and imported previews to the currently selected composer. */
export function useComposerAttachments() {
  const replica = useAgentReplicaStore()
  const drafts = useComposerDraftsStore()
  const inputs = useAttachmentInputsStore()
  const runtime = useAgentRuntimeStore()
  const providers = useProviderSettingsStore()
  const target = computed(() => selectedDraftTarget(replica))
  const assets = computed(() =>
    target.value ? drafts.get(target.value).assets : [],
  )
  const pending = computed(() =>
    target.value ? inputs.pending(target.value) : [],
  )
  const unsupported = computed(() => {
    const selection = runtime.composerModelSelection
    const provider = providers.providers.find(
      (item) => item.id === selection.providerId,
    )
    return Boolean(
      provider &&
      assets.value.some((asset) => asset.kind === 'image') &&
      resolveImageInput(provider, selection.model) === 'unsupported',
    )
  })

  function importFiles(files: readonly File[]): void {
    if (target.value && !runtime.startPending)
      void inputs.importFiles({ ...target.value }, files)
  }
  function paste(event: ClipboardEvent): void {
    if (!target.value || runtime.startPending) return
    const data = event.clipboardData
    const files = Array.from(data?.files ?? [])
    if (files.length) {
      event.preventDefault()
      importFiles(files)
    } else if (
      data &&
      !data.getData('text/plain') &&
      !data.getData('text/html')
    ) {
      event.preventDefault()
      void inputs.importClipboard({ ...target.value })
    }
  }
  function dragover(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  }
  function drop(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    importFiles(Array.from(event.dataTransfer.files))
  }
  function remove(id: string): void {
    if (target.value)
      drafts.setAssets(
        target.value,
        assets.value.filter((asset) => asset.id !== id),
      )
  }
  return {
    assets,
    pending,
    unsupported,
    importFiles,
    paste,
    dragover,
    drop,
    remove,
    cancel: inputs.cancel,
  }
}
