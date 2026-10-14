import { invoke } from '@tauri-apps/api/core'

import type { ClipboardItem } from '../types'

export function listClipboardItems(query: string): Promise<ClipboardItem[]> {
  return invoke('list_clipboard_items', { query })
}

export function pasteClipboardItem(id: string): Promise<void> {
  return invoke('paste_clipboard_item', { id })
}

export function deleteClipboardItem(id: string): Promise<void> {
  return invoke('delete_clipboard_item', { id })
}

export function importRemoteTextItem(item: ClipboardItem): Promise<void> {
  if (item.kind !== 'text' || !item.textContent) {
    return Promise.reject(new Error('Only non-empty text items can be imported'))
  }
  return invoke('import_remote_text_item', {
    item: {
      id: item.id,
      textContent: item.textContent,
      contentHash: item.contentHash,
      createdAt: item.createdAt,
      sourceDevice: item.sourceDevice,
    },
  })
}
