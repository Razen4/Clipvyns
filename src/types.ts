export type ClipboardKind = 'text' | 'image'

export interface ClipboardItem {
  id: string
  kind: ClipboardKind
  textContent: string | null
  previewDataUrl: string | null
  contentHash: string
  createdAt: number
  sourceDevice: string
  width: number | null
  height: number | null
  mimeType: string | null
}
