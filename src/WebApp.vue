<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import checkIcon from '@iconify-icons/lucide/check'
import clipboardIcon from '@iconify-icons/lucide/clipboard'
import clipboardPasteIcon from '@iconify-icons/lucide/clipboard-paste'
import fileTextIcon from '@iconify-icons/lucide/file-text'
import imageIcon from '@iconify-icons/lucide/image'
import laptopIcon from '@iconify-icons/lucide/laptop'
import monitorIcon from '@iconify-icons/lucide/monitor'
import devicesIcon from '@iconify-icons/lucide/monitor-smartphone'
import pinIcon from '@iconify-icons/lucide/pin'
import searchIcon from '@iconify-icons/lucide/search'
import settingsIcon from '@iconify-icons/lucide/settings'
import smartphoneIcon from '@iconify-icons/lucide/smartphone'
import trashIcon from '@iconify-icons/lucide/trash-2'
import userIcon from '@iconify-icons/lucide/user'
import xIcon from '@iconify-icons/lucide/x'
import type { Unsubscribe } from 'firebase/firestore'
import { getVersion } from '@tauri-apps/api/app'
import { readText as readNativeClipboardText, writeText as writeNativeClipboardText } from '@tauri-apps/plugin-clipboard-manager'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useAuthStore } from './stores/auth'
import { DEVICE_ACTIVE_WINDOW_MS, DEVICE_HEARTBEAT_INTERVAL_MS, activateSyncedClipboardItem, deleteSyncedClipboardItem, downloadImageChunks, observeDevices, observeWebClipboardItems, pruneSyncedClipboardItems, publishDevicePresence, publishWebClipboardItem, setSyncedClipboardItemPinned, type ConnectedDevice } from './services/firebase'
import type { ClipboardItem } from './types'

const LOCAL_CLIPBOARD_KEY = 'clipvyn-web-clipboard-v1'
const HISTORY_STORAGE_LIMIT = 80
const HISTORY_DISPLAY_LIMIT = 50
const isAndroidCompanion = '__TAURI_INTERNALS__' in window && /Android/i.test(navigator.userAgent)

function loadLocalClipboard(): ClipboardItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_CLIPBOARD_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is ClipboardItem => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as Partial<ClipboardItem>
      return typeof candidate.id === 'string'
        && (candidate.kind === 'text' || candidate.kind === 'image')
        && typeof candidate.contentHash === 'string'
        && typeof candidate.createdAt === 'number'
        && typeof candidate.sourceDevice === 'string'
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt).slice(0, HISTORY_STORAGE_LIMIT)
  } catch {
    return []
  }
}

function mergeClipboardItems(localItems: ClipboardItem[], remoteItems: ClipboardItem[]): ClipboardItem[] {
  const itemsByHash = new Map(localItems.map((item) => [item.contentHash, item]))
  for (const remoteItem of remoteItems) {
    const localItem = itemsByHash.get(remoteItem.contentHash)
    itemsByHash.set(remoteItem.contentHash, {
      ...localItem,
      ...remoteItem,
      previewDataUrl: remoteItem.previewDataUrl || localItem?.previewDataUrl || null,
    })
  }
  return [...itemsByHash.values()]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
    .slice(0, HISTORY_STORAGE_LIMIT)
}

const auth = useAuthStore()
const localItems = loadLocalClipboard()
const items = ref<ClipboardItem[]>(localItems)
const selected = ref<ClipboardItem | null>(localItems[0] ?? null)
const search = ref('')
const filter = ref<'all' | 'image' | 'text'>('all')
const loginOpen = ref(false)
const email = ref('')
const password = ref('')
const loading = ref(localItems.length === 0)
const error = ref<string | null>(null)
const deviceError = ref<string | null>(null)
const currentAppVersion = ref<string | null>(null)
const updateChecking = ref(false)
const updateAvailable = ref(false)
const updateStatus = ref<string | null>(null)
const updateUrl = ref<string | null>(null)
const pasting = ref(false)
const copiedItemId = ref<string | null>(null)
const activeSection = ref<'clipboard' | 'devices' | 'settings'>('clipboard')
const mobilePreviewOpen = ref(false)
const devices = ref<ConnectedDevice[]>([])
const localDevice: ConnectedDevice = { id: isAndroidCompanion ? 'local-android' : 'local-web', name: isAndroidCompanion ? 'This Android device' : 'This browser', platform: isAndroidCompanion ? 'Android' : navigator.platform || 'Browser', lastSeen: Date.now(), online: true }
const now = ref(Date.now())
const syncReady = ref(false)
let stop: Unsubscribe | null = null
let stopDevices: Unsubscribe | null = null
let presenceTimer: ReturnType<typeof setInterval> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let refreshPresence: (() => Promise<void>) | null = null
let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null

const visible = computed(() => items.value.filter((item) => {
  const haystack = `${item.textContent || ''} ${item.sourceDevice}`.toLowerCase()
  return (filter.value === 'all' || item.kind === filter.value) && haystack.includes(search.value.toLowerCase())
}).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt).slice(0, HISTORY_DISPLAY_LIMIT))
const visibleDevices = computed(() => auth.signedIn ? devices.value : [localDevice])
const profileName = computed(() => auth.user?.displayName || auth.user?.email?.split('@')[0] || 'Clipvyn user')
const profileInitial = computed(() => profileName.value.trim().charAt(0).toUpperCase() || 'U')
const syncLabel = computed(() => !auth.signedIn ? 'Not signed in' : syncReady.value ? 'Synced' : error.value ? 'Sync error' : 'Syncing…')

watch(items, (next) => {
  try {
    localStorage.setItem(LOCAL_CLIPBOARD_KEY, JSON.stringify(next.slice(0, HISTORY_STORAGE_LIMIT)))
  } catch (reason) {
    console.warn('Unable to persist web clipboard history', reason)
  }
}, { deep: true, immediate: true })

watch([() => auth.ready, () => auth.user?.uid] as const, ([ready, uid]) => {
  stop?.(); stopDevices?.(); if (presenceTimer) clearInterval(presenceTimer)
  stopDevices = null; refreshPresence = null
  devices.value = []; error.value = null; deviceError.value = null; syncReady.value = false
  if (!ready) { loading.value = items.value.length === 0; return }
  if (!uid) { loading.value = false; selected.value = items.value[0] ?? null; if (activeSection.value === 'settings') activeSection.value = 'clipboard'; return }
  if (isAndroidCompanion) void syncAndroidClipboard()
  loading.value = items.value.length === 0
  const connectDevices = () => {
    if (stopDevices) return
    stopDevices = observeDevices(uid, (next) => {
      devices.value = next; deviceError.value = null
    }, (reason) => {
      deviceError.value = `Read devices: ${reason.message}`
      stopDevices = null
    })
  }
  const sendPresence = async () => {
    try {
      await publishDevicePresence(uid, isAndroidCompanion ? 'Android' : 'Web')
      deviceError.value = null
      connectDevices()
    } catch (reason) {
      deviceError.value = `Update presence: ${reason instanceof Error ? reason.message : String(reason)}`
    }
  }
  refreshPresence = sendPresence
  connectDevices(); sendPresence(); presenceTimer = setInterval(sendPresence, DEVICE_HEARTBEAT_INTERVAL_MS)
  stop = observeWebClipboardItems(uid, async (next) => {
    items.value = mergeClipboardItems(items.value, next)
    selected.value = items.value.find((item) => item.contentHash === selected.value?.contentHash) ?? items.value[0] ?? null
    syncReady.value = true
    for (const item of next.filter((entry) => entry.kind === 'image' && entry.chunkCount && !entry.previewDataUrl)) {
      try {
        const previewDataUrl = `data:image/png;base64,${await downloadImageChunks(uid, item.contentHash, item.chunkCount!)}`
        item.previewDataUrl = previewDataUrl
        const mergedItem = items.value.find((entry) => entry.contentHash === item.contentHash)
        if (mergedItem) mergedItem.previewDataUrl = previewDataUrl
      }
      catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); syncReady.value = false }
    }
    loading.value = false
  }, (reason) => { error.value = reason.message; loading.value = false; syncReady.value = false })
  void pruneSyncedClipboardItems(uid).catch((reason) => {
    error.value = reason instanceof Error ? reason.message : String(reason)
    syncReady.value = false
  })
}, { immediate: true })
async function submit() { try { await auth.submit(email.value.trim(), password.value); loginOpen.value = false } catch { /* exposed by auth store */ } }
async function copy(item: ClipboardItem) {
  try {
    if (item.kind === 'text' && item.textContent) {
      if (isAndroidCompanion) await writeNativeClipboardText(item.textContent)
      else await navigator.clipboard.writeText(item.textContent)
    }
    else if (item.kind === 'image' && isAndroidCompanion) {
      throw new Error('The Android companion currently copies and shares text only')
    } else if (item.kind === 'image' && item.previewDataUrl) {
      const blob = await (await fetch(item.previewDataUrl)).blob()
      await navigator.clipboard.write([new globalThis.ClipboardItem({ [blob.type || 'image/png']: blob })])
    } else throw new Error('This clipboard item is unavailable')
    if (auth.user) await activateSyncedClipboardItem(auth.user.uid, item, webDeviceName())
    copiedItemId.value = item.id
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
    copyFeedbackTimer = setTimeout(() => { copiedItemId.value = null }, 2200)
  } catch (reason) {
    error.value = reason instanceof Error && reason.name === 'NotAllowedError'
      ? 'Allow clipboard permission in your browser, then try again.'
      : reason instanceof Error ? reason.message : String(reason)
  }
}
async function pasteFromClipboard() {
  pasting.value = true; error.value = null
  try {
    if (isAndroidCompanion) {
      const text = await readNativeClipboardText()
      if (text) { await publishText(text); return }
      throw new Error('Clipboard does not contain text')
    }
    const clipboardItems = await navigator.clipboard.read()
    for (const clipboardItem of clipboardItems) {
      const imageType = clipboardItem.types.find((type) => type.startsWith('image/'))
      if (imageType) { await publishImage(await clipboardItem.getType(imageType)); return }
      if (clipboardItem.types.includes('text/plain')) {
        const text = await (await clipboardItem.getType('text/plain')).text()
        if (text) { await publishText(text); return }
      }
    }
    throw new Error('Clipboard does not contain text or an image')
  } catch (reason) {
    error.value = reason instanceof Error && reason.name === 'NotAllowedError'
      ? 'Allow clipboard permission in your browser, then try again.'
      : reason instanceof Error ? reason.message : String(reason)
  } finally { pasting.value = false }
}
async function syncAndroidClipboard() {
  if (!isAndroidCompanion) return
  try {
    const text = await readNativeClipboardText()
    if (!text) return
    const contentHash = await hashParts([new TextEncoder().encode('text\0'), new TextEncoder().encode(text)])
    const existing = items.value.find((item) => item.contentHash === contentHash)
    if (existing) {
      if (auth.user) await publishWebClipboardItem(auth.user.uid, existing)
      return
    }
    await publishText(text)
  } catch (reason) {
    console.warn('Unable to import the Android clipboard', reason)
  }
}
function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1
  }
  return 0
}
async function checkAndroidUpdate() {
  if (!isAndroidCompanion) return
  updateChecking.value = true; updateStatus.value = null; updateAvailable.value = false; updateUrl.value = null
  try {
    const current = currentAppVersion.value || await getVersion()
    currentAppVersion.value = current
    const response = await fetch('https://api.github.com/repos/Razen4/Clipvyns/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
    const release = await response.json() as {
      tag_name?: string
      html_url?: string
      assets?: Array<{ name?: string; browser_download_url?: string }>
    }
    const latest = release.tag_name?.replace(/^v/, '')
    if (!latest) throw new Error('Latest release has no version tag')
    if (compareVersions(latest, current) <= 0) {
      updateStatus.value = `Clipvyn ${current} is the latest version.`
      return
    }
    const apk = release.assets?.find((asset) => asset.name?.toLowerCase().endsWith('.apk'))
    updateAvailable.value = true
    updateUrl.value = apk?.browser_download_url || release.html_url || 'https://github.com/Razen4/Clipvyns/releases/latest'
    updateStatus.value = apk
      ? `Clipvyn ${latest} is available. Download the APK to update.`
      : `Clipvyn ${latest} is available. The release page does not include an APK yet.`
  } catch (reason) {
    updateStatus.value = `Unable to check for updates: ${reason instanceof Error ? reason.message : String(reason)}`
  } finally {
    updateChecking.value = false
  }
}
async function openAndroidUpdate() {
  await openUrl(updateUrl.value || 'https://github.com/Razen4/Clipvyns/releases/latest')
}
async function publishText(text: string) {
  const contentHash = await hashParts([new TextEncoder().encode('text\0'), new TextEncoder().encode(text)])
  const item: ClipboardItem = {
    id: crypto.randomUUID(), kind: 'text', textContent: text, previewDataUrl: null, contentHash,
    createdAt: Date.now(), sourceDevice: webDeviceName(), width: null, height: null, mimeType: 'text/plain', pinned: false,
  }
  saveLocalItem(item)
  if (auth.user) await publishWebClipboardItem(auth.user.uid, item)
}
async function publishImage(blob: Blob) {
  const image = await loadImage(blob)
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to prepare clipboard image')
  context.drawImage(image, 0, 0)
  const rgba = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data)
  const dimensions = new Uint8Array(8); new DataView(dimensions.buffer).setUint32(0, canvas.width, true); new DataView(dimensions.buffer).setUint32(4, canvas.height, true)
  const contentHash = await hashParts([new TextEncoder().encode('image\0'), dimensions, rgba])
  const pngBase64 = canvas.toDataURL('image/png').split(',', 2)[1]
  const item: ClipboardItem = {
    id: crypto.randomUUID(), kind: 'image', textContent: null, previewDataUrl: `data:image/png;base64,${pngBase64}`,
    contentHash, createdAt: Date.now(), sourceDevice: webDeviceName(), width: canvas.width, height: canvas.height, mimeType: 'image/png', pinned: false,
  }
  saveLocalItem(item)
  if (auth.user) await publishWebClipboardItem(auth.user.uid, item, pngBase64)
}
function saveLocalItem(item: ClipboardItem) {
  items.value = [item, ...items.value.filter((entry) => entry.contentHash !== item.contentHash)]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
    .slice(0, HISTORY_STORAGE_LIMIT)
  selected.value = item
}
async function hashParts(parts: Uint8Array[]): Promise<string> {
  const size = parts.reduce((total, part) => total + part.byteLength, 0); const joined = new Uint8Array(size); let offset = 0
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', joined))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try { return await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Clipboard image cannot be decoded')); image.src = url }) }
  finally { URL.revokeObjectURL(url) }
}
function webDeviceName() { return isAndroidCompanion ? 'Clipvyn · Android' : `Web · ${navigator.platform || 'browser'}` }
async function selectItem(item: ClipboardItem) {
  selected.value = item
  if (window.matchMedia('(max-width: 1279px)').matches) mobilePreviewOpen.value = true
  await copy(item)
}
async function togglePinned(item: ClipboardItem) {
  error.value = null
  const pinned = !item.pinned
  item.pinned = pinned
  items.value.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
  try { if (auth.user) await setSyncedClipboardItemPinned(auth.user.uid, item, pinned) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function removeItem(item: ClipboardItem) {
  error.value = null
  items.value = items.value.filter((entry) => entry.contentHash !== item.contentHash)
  if (selected.value?.contentHash === item.contentHash) selected.value = items.value[0] ?? null
  try {
    if (auth.user) await deleteSyncedClipboardItem(auth.user.uid, item)
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
function showSection(section: 'clipboard' | 'devices' | 'settings') { if (section === 'settings' && !auth.signedIn && !isAndroidCompanion) return; activeSection.value = section; mobilePreviewOpen.value = false }
function deviceIsOnline(device: ConnectedDevice) { return device.id === 'local-web' || now.value - device.lastSeen < DEVICE_ACTIVE_WINDOW_MS }
function deviceIcon(device: ConnectedDevice) { const platform = device.platform.toLowerCase(); return platform.includes('win') ? monitorIcon : platform.includes('mac') ? laptopIcon : smartphoneIcon }
function refreshPresenceWhenVisible() {
  if (document.visibilityState !== 'visible') return
  void refreshPresence?.()
  void syncAndroidClipboard()
}
function age(value: number) { const min = Math.floor((Date.now() - value) / 60000); return min < 1 ? 'now' : min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago` }
onBeforeUnmount(() => { stop?.(); stopDevices?.(); if (presenceTimer) clearInterval(presenceTimer); if (clockTimer) clearInterval(clockTimer); if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer); document.removeEventListener('visibilitychange', refreshPresenceWhenVisible) })
onMounted(() => { auth.initialize(); void syncAndroidClipboard(); if (isAndroidCompanion) void getVersion().then((version) => { currentAppVersion.value = version }); clockTimer = setInterval(() => { now.value = Date.now() }, 60_000); document.addEventListener('visibilitychange', refreshPresenceWhenVisible) })
</script>

<template>
  <main class="web-shell h-screen overflow-hidden bg-[#070c1b] text-slate-100" :class="{ 'android-companion': isAndroidCompanion }">
    <aside class="hidden w-72 shrink-0 border-r border-white/8 bg-[#0a1124] p-6 lg:flex lg:flex-col">
      <div class="mb-12 flex items-center gap-3"><div class="brand-mark"><img src="/icon.png" alt="Clipvyn" /></div><div><b class="text-lg">Clipvyn</b><p class="text-sm text-slate-400">Sync across devices</p></div></div>
      <nav class="space-y-2 text-sm"><button class="nav" :class="activeSection === 'clipboard' && 'active'" @click="showSection('clipboard')"><Icon :icon="clipboardIcon" aria-hidden="true" /> Clipboard <span>{{ items.length }}</span></button><button class="nav" :class="activeSection === 'devices' && 'active'" @click="showSection('devices')"><Icon :icon="devicesIcon" aria-hidden="true" /> Devices <span>{{ visibleDevices.length }}</span></button><button v-if="auth.signedIn || isAndroidCompanion" class="nav" :class="activeSection === 'settings' && 'active'" @click="showSection('settings')"><Icon :icon="settingsIcon" aria-hidden="true" /> Settings</button></nav>
      <div class="account-card mt-auto rounded-2xl border border-white/8 bg-white/[.03] p-4 text-sm">
        <div class="account-profile">
          <img v-if="auth.user?.photoURL" :src="auth.user.photoURL" :alt="profileName" class="account-avatar" referrerpolicy="no-referrer" />
          <div v-else class="account-avatar account-initial">{{ profileInitial }}</div>
          <div class="min-w-0 flex-1"><b class="block truncate">{{ auth.signedIn ? profileName : 'Guest' }}</b><p class="truncate text-xs text-slate-400">{{ auth.user?.email || 'No account connected' }}</p></div>
        </div>
        <div class="account-status"><span :class="syncReady ? 'status-online' : 'status-offline'">●</span><div><b>{{ syncLabel }}</b><p>{{ syncReady ? 'Clipboard is up to date' : error ? 'Clipboard sync needs attention' : auth.signedIn ? 'Connecting to Firebase' : 'Sign in to sync your clipboard' }}</p></div></div>
        <button class="account-card-action" :disabled="auth.busy" @click="auth.signedIn ? auth.signOut() : (loginOpen = true)">{{ auth.busy ? 'Please wait…' : auth.signedIn ? 'Sign out' : 'Sign in' }}</button>
      </div>
    </aside>
    <section class="min-w-0 flex-1 p-3 sm:p-5">
      <header class="app-header mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-white/8 bg-[#0c1428] px-5 py-4">
        <div class="header-top">
          <div class="header-copy"><h1 class="text-2xl font-semibold">{{ activeSection === 'clipboard' ? 'Clipboard' : activeSection === 'devices' ? 'Devices & Sync' : 'Settings' }}</h1><p class="mt-1 text-sm text-slate-400">{{ activeSection === 'clipboard' ? 'Your latest 50 items · Sync across devices' : activeSection === 'devices' ? 'Your connected clipboard devices' : 'Manage your clipboard experience' }}</p><span class="mobile-sync-state lg:hidden"><i :class="syncReady ? 'online' : 'offline'" />{{ syncLabel }}</span></div>
          <button class="mobile-account-action lg:hidden" :disabled="auth.busy" @click="auth.signedIn ? auth.signOut() : (loginOpen = true)"><span class="mobile-account-avatar"><span v-if="auth.signedIn">{{ profileInitial }}</span><Icon v-else :icon="userIcon" aria-hidden="true" /></span><span>{{ auth.signedIn ? 'Sign out' : 'Sign in' }}</span></button>
        </div>
        <div v-if="activeSection === 'clipboard'" class="header-actions ml-auto flex w-full items-center gap-2 sm:w-auto">
          <label class="mobile-search"><Icon :icon="searchIcon" aria-hidden="true" /><input v-model="search" type="search" placeholder="Search clipboard…" /></label>
          <button class="paste-action" :disabled="pasting" @click="pasteFromClipboard"><Icon :icon="clipboardPasteIcon" aria-hidden="true" /> {{ pasting ? 'Pasting…' : 'Paste from clipboard' }}</button>
        </div>
      </header>
      <div v-if="copiedItemId" class="copy-toast" role="status" aria-live="polite"><span aria-hidden="true"><Icon :icon="checkIcon" /></span> Copied to clipboard</div>
      <template v-if="activeSection === 'clipboard'"><div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]"><section class="panel web-list"><div class="mb-5 flex gap-2"><button v-for="tab in [['all','All'],['image','Images'],['text','Text']] as const" :key="tab[0]" class="filter" :class="filter === tab[0] && 'selected'" @click="filter = tab[0]">{{ tab[1] }}</button></div><p v-if="error" class="list-error">{{ error }}</p><div v-if="loading || !visible.length" class="empty">{{ loading ? 'Loading clipboard…' : search ? 'No matching clipboard items.' : 'No local clipboard items yet. Use Paste from clipboard to add one.' }}</div><div v-else class="space-y-3"><article v-for="item in visible" :key="item.id" class="clip-row"><button class="clip" :class="[selected?.id === item.id && 'clip-selected', item.pinned && 'clip-pinned']" @click="selectItem(item)"><div class="thumb" :class="item.kind === 'text' && 'text-thumb'"><img v-if="item.previewDataUrl" :src="item.previewDataUrl" alt="Clipboard preview" /><Icon v-else :icon="item.kind === 'image' ? imageIcon : fileTextIcon" aria-hidden="true" /></div><div class="min-w-0 flex-1 text-left"><b :class="item.kind === 'text' ? 'text-preview' : 'block truncate'">{{ item.kind === 'image' ? `Image · ${item.width} × ${item.height}` : item.textContent }}</b><p v-if="item.kind === 'image'" class="mt-1 truncate text-sm text-slate-400">PNG image</p><p class="mt-2 text-xs text-slate-500">● {{ item.sourceDevice }} · {{ age(item.createdAt) }}</p></div></button><div class="clip-actions"><button type="button" class="clip-pin" :class="item.pinned && 'pinned'" :aria-label="item.pinned ? 'Unpin clipboard item' : 'Pin clipboard item'" :title="item.pinned ? 'Unpin' : 'Pin'" @click="togglePinned(item)"><Icon :icon="pinIcon" aria-hidden="true" /></button><button type="button" class="clip-delete" aria-label="Delete clipboard item" title="Delete clipboard item" @click="removeItem(item)"><Icon :icon="trashIcon" aria-hidden="true" /></button></div></article></div></section><aside class="panel web-detail"><template v-if="selected"><div class="mb-4"><b>{{ selected.kind === 'image' ? `Image · ${selected.width} × ${selected.height}` : 'Text item' }}</b></div><div class="preview"><img v-if="selected.previewDataUrl" :src="selected.previewDataUrl" alt="Selected image" /><p v-else>{{ selected.textContent }}</p></div><dl class="info"><div><dt>Device</dt><dd>{{ selected.sourceDevice }}</dd></div><div><dt>Type</dt><dd>{{ selected.mimeType }}</dd></div><div><dt>Copied</dt><dd>{{ new Date(selected.createdAt).toLocaleString() }}</dd></div></dl><button class="primary mt-5 w-full" :disabled="isAndroidCompanion && selected.kind === 'image'" @click="copy(selected)">{{ selected.kind === 'image' ? isAndroidCompanion ? 'Image copy unavailable on Android' : 'Copy image' : 'Copy text' }}</button></template><div v-else class="empty">Select an item to view details.</div></aside></div>
      <aside v-if="selected && mobilePreviewOpen" class="mobile-preview-sheet xl:hidden"><div class="flex items-center justify-between"><b>Preview</b><button aria-label="Close preview" @click="mobilePreviewOpen = false"><Icon :icon="xIcon" aria-hidden="true" /></button></div><img v-if="selected.previewDataUrl" :src="selected.previewDataUrl" alt="Selected preview" /><p v-else>{{ selected.textContent }}</p><button class="primary w-full" @click="copy(selected)">Copy text</button></aside></template>
      <section v-else-if="activeSection === 'devices'" class="panel devices-panel"><div v-if="auth.signedIn && deviceError" class="empty">Device sync error: {{ deviceError }}</div><div v-else-if="auth.signedIn && !visibleDevices.length" class="empty">No device heartbeat yet. Open the desktop or web app while signed in.</div><div v-else class="space-y-3"><article v-for="device in visibleDevices" :key="device.id" class="device-card"><div class="device-icon"><Icon :icon="deviceIcon(device)" aria-hidden="true" /></div><div class="min-w-0 flex-1"><b class="block truncate">{{ device.name }}</b><p class="mt-1 text-sm text-slate-400">{{ device.platform }}</p><p class="mt-2 text-xs" :class="deviceIsOnline(device) ? 'text-emerald-400' : 'text-slate-500'">● {{ deviceIsOnline(device) ? 'Active recently' : `Last seen ${age(device.lastSeen)}` }}</p></div><span class="badge" :class="deviceIsOnline(device) ? 'device-online' : 'device-offline'">{{ deviceIsOnline(device) ? 'Active' : 'Inactive' }}</span></article></div></section>
      <section v-else class="panel settings-panel">
        <h2 class="text-lg font-semibold">Sync settings</h2>
        <div v-if="isAndroidCompanion" class="setting-row android-update-setting">
          <div><b>App update</b><p>Installed version: {{ currentAppVersion || 'Reading…' }}</p><p v-if="updateStatus" :class="updateAvailable ? 'update-available' : ''">{{ updateStatus }}</p></div>
          <div class="android-update-actions"><button class="secondary" :disabled="updateChecking" @click="checkAndroidUpdate">{{ updateChecking ? 'Checking…' : 'Check for updates' }}</button><button v-if="updateAvailable" class="primary" @click="openAndroidUpdate">Open download</button></div>
        </div>
        <div class="setting-row"><div><b>Auto sync</b><p>New clipboard items sync immediately in realtime.</p></div><span class="setting-on">On</span></div><div class="setting-row"><div><b>Device status</b><p>Presence refreshes every 10 minutes and when the app becomes active.</p></div><span>10 min</span></div><div class="setting-row"><div><b>Clipboard history</b><p>Stores the latest 80 items and shows up to 50 matching items.</p></div><span>80 / 50</span></div><div class="setting-row"><div><b>Clipboard permission</b><p>{{ isAndroidCompanion ? 'Android allows clipboard access while Clipvyn is visible.' : 'Paste needs browser permission and a direct button press.' }}</p></div><span>Required</span></div>
      </section>
    </section>
    <div v-if="loginOpen" class="fixed inset-0 grid place-items-center bg-black/70 p-5"><form class="w-full max-w-sm rounded-2xl border border-white/10 bg-[#101a31] p-6" @submit.prevent="submit"><h2 class="text-xl font-semibold">Sign in to Clipvyn</h2><p class="mt-1 text-sm text-slate-400">Use the same Firebase account as desktop.</p><input v-model="email" required type="email" placeholder="Email" class="search mt-5 w-full" /><input v-model="password" required type="password" minlength="6" placeholder="Password" class="search mt-3 w-full" /><p v-if="auth.error" class="mt-3 text-sm text-rose-300">{{ auth.error }}</p><button class="primary mt-5 w-full" :disabled="auth.busy">{{ auth.busy ? 'Signing in…' : 'Sign in' }}</button><button type="button" class="mt-3 w-full text-sm text-slate-400" @click="loginOpen = false">Cancel</button></form></div>
    <nav class="mobile-nav"><button :class="activeSection === 'clipboard' && 'active'" @click="showSection('clipboard')"><Icon :icon="clipboardIcon" aria-hidden="true" /><span>Clipboard</span></button><button :class="activeSection === 'devices' && 'active'" @click="showSection('devices')"><Icon :icon="devicesIcon" aria-hidden="true" /><span>Devices</span></button><button v-if="auth.signedIn || isAndroidCompanion" :class="activeSection === 'settings' && 'active'" @click="showSection('settings')"><Icon :icon="settingsIcon" aria-hidden="true" /><span>Settings</span></button></nav>
  </main>
</template>
