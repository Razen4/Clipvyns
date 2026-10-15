import { defineStore } from 'pinia'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { deleteClipboardItem, listClipboardItems, pasteClipboardItem } from '../services/clipboard'
import { observeRemoteClipboardItems, publishClipboardItem, publishRecentClipboardItems } from '../services/firebase'
import type { ClipboardItem } from '../types'

let searchTimer: ReturnType<typeof setTimeout> | undefined

export const useClipboardStore = defineStore('clipboard', {
  state: () => ({
    items: [] as ClipboardItem[],
    query: '',
    loading: true,
    restoringId: null as string | null,
    deletingId: null as string | null,
    error: null as string | null,
    unlisten: null as UnlistenFn | null,
    unsubscribeRemote: null as (() => void) | null,
    syncUserId: null as string | null,
    syncError: null as string | null,
    syncing: false,
  }),
  actions: {
    async initialize() {
      await this.refresh()
      this.unlisten = await listen<ClipboardItem>('clipboard://changed', async (event) => {
        await this.refresh()
        if (this.syncUserId) {
          publishClipboardItem(this.syncUserId, event.payload)
            .then(() => { this.syncError = null })
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
      this.unsubscribeRemote = observeRemoteClipboardItems(
        uid,
        () => {
          this.syncError = null
          return this.refresh()
        },
        (error) => {
          this.syncError = error.message
          this.syncing = false
        },
      )
      try {
        await publishRecentClipboardItems(uid)
        this.syncError = null
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
      this.syncError = null
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
      try {
        await pasteClipboardItem(id)
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
        await deleteClipboardItem(id)
        this.items = this.items.filter((item) => item.id !== id)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        await this.refresh()
      } finally {
        this.deletingId = null
      }
    },
  },
})
