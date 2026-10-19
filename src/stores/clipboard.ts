import { defineStore } from 'pinia'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { deleteClipboardItem, getLocalDeviceInfo, listClipboardItems, pasteClipboardItem, setClipboardItemPinned, type LocalDeviceInfo } from '../services/clipboard'
import { DEVICE_HEARTBEAT_INTERVAL_MS, deleteSyncedClipboardItem, observeRemoteClipboardItems, publishClipboardItem, publishDevicePresence, publishRecentClipboardItems, setSyncedClipboardItemPinned } from '../services/firebase'
import type { ClipboardItem } from '../types'

let searchTimer: ReturnType<typeof setTimeout> | undefined
let presenceTimer: ReturnType<typeof setInterval> | undefined
let pasteNoticeTimer: ReturnType<typeof setTimeout> | undefined

export const useClipboardStore = defineStore('clipboard', {
  state: () => ({
    items: [] as ClipboardItem[],
    query: '',
    loading: true,
    restoringId: null as string | null,
    pasteNotice: null as string | null,
    pasteNoticeKind: null as 'success' | 'warning' | null,
    deletingId: null as string | null,
    error: null as string | null,
    unlisten: null as UnlistenFn | null,
    unsubscribeRemote: null as (() => void) | null,
    syncUserId: null as string | null,
    syncError: null as string | null,
    syncing: false,
    remoteReady: false,
  }),
  actions: {
    async initialize() {
      await this.refresh()
      this.unlisten = await listen<ClipboardItem>('clipboard://changed', async (event) => {
        await this.refresh()
        if (this.syncUserId) {
          publishClipboardItem(this.syncUserId, event.payload)
            .then(() => { if (this.remoteReady) this.syncError = null })
            .catch((error) => {
              this.syncError = error instanceof Error ? error.message : String(error)
            })
        }
      })
    },
    dispose() {
      this.unlisten?.()
      this.unlisten = null
      this.stopSync()
      if (searchTimer) clearTimeout(searchTimer)
    },
    async startSync(uid: string) {
      if (this.syncUserId === uid) return
      this.stopSync()
      this.syncUserId = uid
      this.syncError = null
      this.syncing = true
      this.remoteReady = false
      let resolveInitialSnapshot!: () => void
      let rejectInitialSnapshot!: (error: Error) => void
      const initialSnapshot = new Promise<void>((resolve, reject) => {
        resolveInitialSnapshot = resolve
        rejectInitialSnapshot = reject
      })
      this.unsubscribeRemote = observeRemoteClipboardItems(
        uid,
        () => {
          this.syncError = null
          this.remoteReady = true
          resolveInitialSnapshot()
          return this.refresh()
        },
        (error) => {
          this.syncError = error.message
          this.syncing = false
          this.remoteReady = false
          rejectInitialSnapshot(error)
        },
      )
      try {
        await initialSnapshot
        let deviceInfo: LocalDeviceInfo | undefined
        try {
          deviceInfo = await getLocalDeviceInfo()
        } catch {
          // Presence can still use the browser platform if native device metadata is unavailable.
        }
        await publishDevicePresence(uid, 'Desktop', deviceInfo)
        presenceTimer = setInterval(() => {
          publishDevicePresence(uid, 'Desktop', deviceInfo).catch((error) => {
            this.syncError = error instanceof Error ? error.message : String(error)
          })
        }, DEVICE_HEARTBEAT_INTERVAL_MS)
        await publishRecentClipboardItems(uid)
        if (this.remoteReady) this.syncError = null
      } catch (error) {
        this.syncError = error instanceof Error ? error.message : String(error)
      } finally {
        this.syncing = false
      }
    },
    stopSync() {
      this.unsubscribeRemote?.()
      this.unsubscribeRemote = null
      this.syncUserId = null
      this.syncing = false
      this.remoteReady = false
      this.syncError = null
      if (presenceTimer) clearInterval(presenceTimer)
      presenceTimer = undefined
    },
    scheduleSearch(query: string) {
      this.query = query
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => this.refresh(), 160)
    },
    async refresh() {
      this.loading = this.items.length === 0
      this.error = null
      try {
        this.items = await listClipboardItems(this.query.trim())
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },
    async paste(id: string) {
      if (this.restoringId) return
      this.restoringId = id
      this.error = null
      this.pasteNotice = null
      this.pasteNoticeKind = null
      if (pasteNoticeTimer) clearTimeout(pasteNoticeTimer)
      try {
        const result = await pasteClipboardItem(id)
        if (result.permissionRequired) {
          this.pasteNotice = 'Copied to the clipboard. To paste automatically, allow Clipboard Sharings in macOS System Settings > Privacy & Security > Accessibility, reopen the app, then try again. Until then, switch to the destination and press ⌘V.'
          this.pasteNoticeKind = 'warning'
        } else if (result.pasted) {
          this.pasteNotice = '✓ Copied to clipboard'
          this.pasteNoticeKind = 'success'
          pasteNoticeTimer = setTimeout(() => { this.pasteNotice = null; this.pasteNoticeKind = null }, 2200)
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.restoringId = null
      }
    },
    async remove(id: string) {
      if (this.deletingId) return
      this.deletingId = id
      this.error = null
      try {
        const item = this.items.find((entry) => entry.id === id)
        if (item && this.syncUserId) await deleteSyncedClipboardItem(this.syncUserId, item)
        await deleteClipboardItem(id)
        this.items = this.items.filter((item) => item.id !== id)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        await this.refresh()
      } finally {
        this.deletingId = null
      }
    },
    async togglePinned(id: string) {
      const item = this.items.find((entry) => entry.id === id)
      if (!item) return
      const pinned = !item.pinned
      this.error = null
      try {
        if (this.syncUserId) await setSyncedClipboardItemPinned(this.syncUserId, item, pinned)
        await setClipboardItemPinned(id, pinned)
        item.pinned = pinned
        this.items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },
  },
})
