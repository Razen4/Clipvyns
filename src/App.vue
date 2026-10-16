<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Unsubscribe } from 'firebase/firestore'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isRegistered, register, unregister, type ShortcutEvent } from '@tauri-apps/plugin-global-shortcut'

import { DEVICE_ACTIVE_WINDOW_MS, observeDevices, type ConnectedDevice } from './services/firebase'
import { useAuthStore } from './stores/auth'
import { useClipboardStore } from './stores/clipboard'
import type { ClipboardItem } from './types'

const store = useClipboardStore()
const auth = useAuthStore()
const activeSection = ref<'clipboard' | 'devices' | 'settings'>('clipboard')
const filter = ref<'all' | 'image' | 'text'>('all')
const selectedId = ref<string | null>(null)
const mobilePreviewOpen = ref(false)
const loginOpen = ref(false)
const email = ref('')
const password = ref('')
const devices = ref<ConnectedDevice[]>([])
const deviceError = ref<string | null>(null)
const now = ref(Date.now())
const shortcutOptions = [
  { value: 'CommandOrControl+Shift+Space', label: 'Cmd/Ctrl + Shift + Space' },
  { value: 'CommandOrControl+Shift+Period', label: 'Cmd/Ctrl + Shift + .' },
  { value: 'CommandOrControl+Shift+Comma', label: 'Cmd/Ctrl + Shift + ,' },
]
const shortcutEnabled = ref(localStorage.getItem('global-shortcut-enabled') !== 'false')
const shortcutValue = ref(localStorage.getItem('global-shortcut-value') || shortcutOptions[0].value)
const shortcutError = ref<string | null>(null)
const shortcutBusy = ref(false)
let stopDevices: Unsubscribe | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let activeShortcut: string | null = null

const visibleItems = computed(() => store.items.filter((item) => filter.value === 'all' || item.kind === filter.value))
const selected = computed(() => store.items.find((item) => item.id === selectedId.value) ?? null)
const profileName = computed(() => auth.user?.displayName || auth.user?.email?.split('@')[0] || 'MyClipboard user')
const profileInitial = computed(() => profileName.value.trim().charAt(0).toUpperCase() || 'U')

watch(() => store.items, (items) => {
  if (!items.some((item) => item.id === selectedId.value)) selectedId.value = items[0]?.id ?? null
})

watch(() => auth.user?.uid, (uid) => {
  stopDevices?.(); stopDevices = null; devices.value = []; deviceError.value = null
  if (uid) {
    void store.startSync(uid)
    stopDevices = observeDevices(uid, (next) => {
      devices.value = next; deviceError.value = null
    }, (reason) => { deviceError.value = reason.message })
  } else {
    store.stopSync()
  }
})

async function submitAuth() {
  try {
    await auth.submit(email.value.trim(), password.value)
    loginOpen.value = false
    password.value = ''
  } catch { /* exposed by the auth store */ }
}

function selectItem(item: ClipboardItem) {
  selectedId.value = item.id
  if (window.matchMedia('(max-width: 1279px)').matches) mobilePreviewOpen.value = true
}

function showSection(section: 'clipboard' | 'devices' | 'settings') {
  activeSection.value = section
  mobilePreviewOpen.value = false
}

function onSearch(event: Event) { store.scheduleSearch((event.target as HTMLInputElement).value) }
function deviceIsActive(device: ConnectedDevice) { return now.value - device.lastSeen < DEVICE_ACTIVE_WINDOW_MS }
function age(value: number) { const min = Math.floor((Date.now() - value) / 60000); return min < 1 ? 'now' : min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago` }

async function revealApplication(event: ShortcutEvent) {
  if (event.state !== 'Pressed') return
  const window = getCurrentWindow()
  await window.show()
  await window.unminimize()
  await window.setFocus()
}

async function activateShortcut(nextShortcut: string): Promise<boolean> {
  if (activeShortcut === nextShortcut) return true
  shortcutBusy.value = true
  shortcutError.value = null
  try {
    if (await isRegistered(nextShortcut)) await unregister(nextShortcut)
    await register(nextShortcut, (event) => { void revealApplication(event) })
    const previousShortcut = activeShortcut
    activeShortcut = nextShortcut
    if (previousShortcut && previousShortcut !== nextShortcut) await unregister(previousShortcut)
    shortcutValue.value = nextShortcut
    shortcutEnabled.value = true
    localStorage.setItem('global-shortcut-value', nextShortcut)
    localStorage.setItem('global-shortcut-enabled', 'true')
    return true
  } catch {
    shortcutError.value = 'This shortcut is unavailable or already used by another app. Choose another shortcut.'
    shortcutEnabled.value = activeShortcut !== null
    return false
  } finally {
    shortcutBusy.value = false
  }
}

async function changeShortcut(event: Event) {
  const select = event.target as HTMLSelectElement
  const nextShortcut = select.value
  if (!shortcutEnabled.value) {
    shortcutValue.value = nextShortcut
    localStorage.setItem('global-shortcut-value', nextShortcut)
    return
  }
  if (!await activateShortcut(nextShortcut)) select.value = shortcutValue.value
}

async function toggleShortcut() {
  if (shortcutEnabled.value) {
    shortcutBusy.value = true
    try {
      if (activeShortcut) await unregister(activeShortcut)
      activeShortcut = null
      shortcutEnabled.value = false
      shortcutError.value = null
      localStorage.setItem('global-shortcut-enabled', 'false')
    } catch {
      shortcutError.value = 'The shortcut could not be disabled. Restart the app and try again.'
    } finally { shortcutBusy.value = false }
    return
  }
  await activateShortcut(shortcutValue.value)
}

function onKeydown(event: KeyboardEvent) {
  if (loginOpen.value) {
    if (event.key === 'Escape') loginOpen.value = false
    return
  }
  const index = visibleItems.value.findIndex((item) => item.id === selectedId.value)
  if (event.key === 'ArrowDown' && visibleItems.value.length) {
    event.preventDefault(); selectedId.value = visibleItems.value[Math.min(index + 1, visibleItems.value.length - 1)]?.id ?? null
  } else if (event.key === 'ArrowUp' && visibleItems.value.length) {
    event.preventDefault(); selectedId.value = visibleItems.value[Math.max(0, index - 1)]?.id ?? null
  } else if (event.key === 'Enter' && selected.value) {
    event.preventDefault(); void store.paste(selected.value.id)
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  clockTimer = setInterval(() => { now.value = Date.now() }, 60_000)
  await Promise.all([store.initialize(), auth.initialize()])
  if (auth.user) await store.startSync(auth.user.uid)
  if (shortcutEnabled.value) await activateShortcut(shortcutValue.value)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stopDevices?.()
  if (clockTimer) clearInterval(clockTimer)
  if (activeShortcut) void unregister(activeShortcut)
  store.dispose()
  auth.dispose()
})
</script>

<template>
  <main class="web-shell h-screen overflow-hidden bg-[#070c1b] text-slate-100">
    <aside class="hidden w-72 shrink-0 border-r border-white/8 bg-[#0a1124] p-6 lg:flex lg:flex-col">
      <div class="mb-12 flex items-center gap-3"><div class="brand-mark"><img src="/icon.png" alt="MyClipboard" /></div><div><b class="text-lg">MyClipboard</b><p class="text-sm text-slate-400">Sync across devices</p></div></div>
      <nav class="space-y-2 text-sm"><button class="nav" :class="activeSection === 'clipboard' && 'active'" @click="showSection('clipboard')">▣ Clipboard <span>{{ store.items.length }}</span></button><button class="nav" :class="activeSection === 'devices' && 'active'" @click="showSection('devices')">⌖ Devices <span>{{ devices.length }}</span></button><button class="nav" :class="activeSection === 'settings' && 'active'" @click="showSection('settings')">⚙ Settings</button></nav>
      <div class="account-card mt-auto rounded-2xl border border-white/8 bg-white/[.03] p-4 text-sm">
        <div class="account-profile"><img v-if="auth.user?.photoURL" :src="auth.user.photoURL" :alt="profileName" class="account-avatar" referrerpolicy="no-referrer" /><div v-else class="account-avatar account-initial">{{ profileInitial }}</div><div class="min-w-0 flex-1"><b class="block truncate">{{ auth.signedIn ? profileName : 'Guest' }}</b><p class="truncate text-xs text-slate-400">{{ auth.user?.email || 'No account connected' }}</p></div></div>
        <div class="account-status"><span :class="auth.signedIn ? 'status-online' : 'status-offline'">●</span><div><b>{{ auth.signedIn ? 'Synced' : 'Not signed in' }}</b><p>{{ auth.signedIn ? 'Connected to Firebase' : 'Sign in to sync your clipboard' }}</p></div></div>
        <button class="account-card-action" :disabled="auth.busy" @click="auth.signedIn ? auth.signOut() : (loginOpen = true)">{{ auth.busy ? 'Please wait…' : auth.signedIn ? 'Sign out' : 'Sign in' }}</button>
      </div>
    </aside>

    <section class="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
      <header class="app-header mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-white/8 bg-[#0c1428] px-5 py-4">
        <div class="header-top"><div class="header-copy"><h1 class="text-2xl font-semibold">{{ activeSection === 'clipboard' ? 'Clipboard' : activeSection === 'devices' ? 'Devices & Sync' : 'Settings' }}</h1><p class="mt-1 text-sm text-slate-400">{{ activeSection === 'clipboard' ? 'Your latest 50 items · Sync across devices' : activeSection === 'devices' ? 'Your connected clipboard devices' : 'Manage your clipboard experience' }}</p><span class="mobile-sync-state lg:hidden"><i :class="auth.signedIn ? 'online' : 'offline'" />{{ auth.signedIn ? 'Synced' : 'Local only' }}</span></div><button class="mobile-account-action lg:hidden" :disabled="auth.busy" @click="auth.signedIn ? auth.signOut() : (loginOpen = true)"><span class="mobile-account-avatar">{{ auth.signedIn ? profileInitial : '♙' }}</span><span>{{ auth.signedIn ? 'Sign out' : 'Sign in' }}</span></button></div>
        <div v-if="activeSection === 'clipboard'" class="header-actions ml-auto flex w-full items-center gap-2 sm:w-auto"><label class="mobile-search"><span aria-hidden="true">⌕</span><input :value="store.query" type="search" placeholder="Search clipboard…" @input="onSearch" /></label><span class="desktop-auto-capture">● Automatic capture</span></div>
      </header>

      <p v-if="store.syncError" class="mb-4 rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{{ store.syncError }}</p>
      <div v-if="store.pasteNotice" class="paste-notice"><span>{{ store.pasteNotice }}</span><button type="button" aria-label="Dismiss paste notice" @click="store.pasteNotice = null">×</button></div>

      <template v-if="activeSection === 'clipboard'">
        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
          <section class="panel web-list">
            <div class="mb-5 flex gap-2"><button v-for="tab in [['all','All'],['image','Images'],['text','Text']] as const" :key="tab[0]" class="filter" :class="filter === tab[0] && 'selected'" @click="filter = tab[0]">{{ tab[1] }}</button></div>
            <p v-if="store.error" class="list-error">{{ store.error }}</p>
            <div v-if="store.loading || !visibleItems.length" class="empty">{{ store.loading ? 'Loading clipboard…' : store.query ? 'No matching clipboard items.' : 'Copy text or an image and it will appear here.' }}</div>
            <div v-else class="space-y-3"><button v-for="item in visibleItems" :key="item.id" class="clip" :class="selectedId === item.id && 'clip-selected'" @click="selectItem(item)"><div class="thumb" :class="item.kind === 'text' && 'text-thumb'"><img v-if="item.previewDataUrl" :src="item.previewDataUrl" alt="Clipboard preview" /><span v-else>{{ item.kind === 'image' ? '▧' : '≡' }}</span></div><div class="min-w-0 flex-1 text-left"><b :class="item.kind === 'text' ? 'text-preview' : 'block truncate'">{{ item.kind === 'image' ? `Image · ${item.width} × ${item.height}` : item.textContent }}</b><p v-if="item.kind === 'image'" class="mt-1 truncate text-sm text-slate-400">PNG image</p><p class="mt-2 text-xs text-slate-500">● {{ item.sourceDevice }} · {{ age(item.createdAt) }}</p></div><span class="badge">{{ item.kind }}</span></button></div>
          </section>
          <aside class="panel web-detail"><template v-if="selected"><div class="mb-4 flex justify-between"><b>{{ selected.kind === 'image' ? `Image · ${selected.width} × ${selected.height}` : 'Text item' }}</b><span class="badge">{{ selected.kind }}</span></div><div class="preview"><img v-if="selected.previewDataUrl" :src="selected.previewDataUrl" alt="Selected preview" /><p v-else>{{ selected.textContent }}</p></div><dl class="info"><div><dt>Device</dt><dd>{{ selected.sourceDevice }}</dd></div><div><dt>Type</dt><dd>{{ selected.mimeType }}</dd></div><div><dt>Copied</dt><dd>{{ new Date(selected.createdAt).toLocaleString() }}</dd></div></dl><div class="detail-actions"><button class="primary" :disabled="store.restoringId === selected.id" @click="store.paste(selected.id)">{{ store.restoringId === selected.id ? 'Pasting…' : 'Paste item' }}</button><button class="delete-action" :disabled="store.deletingId === selected.id" @click="store.remove(selected.id)">{{ store.deletingId === selected.id ? 'Deleting…' : 'Delete' }}</button></div></template><div v-else class="empty">Select an item to view details.</div></aside>
        </div>
        <aside v-if="selected && mobilePreviewOpen" class="mobile-preview-sheet xl:hidden"><div class="flex items-center justify-between"><b>Preview</b><button aria-label="Close preview" @click="mobilePreviewOpen = false">×</button></div><img v-if="selected.previewDataUrl" :src="selected.previewDataUrl" alt="Selected preview" /><p v-else>{{ selected.textContent }}</p><div class="detail-actions"><button class="primary" @click="store.paste(selected.id)">Paste item</button><button class="delete-action" @click="store.remove(selected.id)">Delete</button></div></aside>
      </template>

      <section v-else-if="activeSection === 'devices'" class="panel devices-panel"><div v-if="!auth.signedIn" class="empty">Sign in to see connected devices.</div><div v-else-if="deviceError" class="empty">Device sync error: {{ deviceError }}</div><div v-else-if="!devices.length" class="empty">No device heartbeat yet.</div><div v-else class="space-y-3"><article v-for="device in devices" :key="device.id" class="device-card"><div class="device-icon">{{ device.platform.toLowerCase().includes('win') ? '⊞' : device.platform.toLowerCase().includes('mac') ? '⌘' : '◫' }}</div><div class="min-w-0 flex-1"><b class="block truncate">{{ device.name }}</b><p class="mt-1 text-sm text-slate-400">{{ device.platform }}</p><p class="mt-2 text-xs" :class="deviceIsActive(device) ? 'text-emerald-400' : 'text-slate-500'">● {{ deviceIsActive(device) ? 'Active recently' : `Last seen ${age(device.lastSeen)}` }}</p></div><span class="badge" :class="deviceIsActive(device) ? 'device-online' : 'device-offline'">{{ deviceIsActive(device) ? 'Active' : 'Inactive' }}</span></article></div></section>

      <section v-else class="panel settings-panel"><h2 class="text-lg font-semibold">Sync settings</h2><div class="setting-row"><div><b>Automatic capture</b><p>New clipboard items are captured and synced immediately.</p></div><span class="setting-on">On</span></div><div class="setting-row shortcut-setting"><div><b>Open app shortcut</b><p>Shows and focuses the app while it is running.</p><p v-if="shortcutError" class="shortcut-error">{{ shortcutError }}</p></div><div class="shortcut-controls"><select :value="shortcutValue" :disabled="shortcutBusy" aria-label="Global shortcut" @change="changeShortcut"><option v-for="option in shortcutOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select><button type="button" role="switch" :aria-checked="shortcutEnabled" :disabled="shortcutBusy" class="shortcut-toggle" :class="shortcutEnabled && 'enabled'" @click="toggleShortcut"><span /></button></div></div><div class="setting-row"><div><b>Device status</b><p>Presence refreshes every 10 minutes.</p></div><span>10 min</span></div><div class="setting-row"><div><b>Keep latest items</b><p>Local history and the synced feed keep the latest 50 items.</p></div><span>50</span></div></section>
    </section>

    <div v-if="loginOpen" class="fixed inset-0 z-30 grid place-items-center bg-black/70 p-5" @click.self="loginOpen = false"><form class="w-full max-w-sm rounded-2xl border border-white/10 bg-[#101a31] p-6" @submit.prevent="submitAuth"><h2 class="text-xl font-semibold">Sign in to MyClipboard</h2><p class="mt-1 text-sm text-slate-400">Use the same Firebase account as the web app.</p><input v-model="email" required type="email" autocomplete="email" placeholder="Email" class="search mt-5 w-full" /><input v-model="password" required type="password" autocomplete="current-password" minlength="6" placeholder="Password" class="search mt-3 w-full" /><p v-if="auth.error" class="mt-3 text-sm text-rose-300">{{ auth.error }}</p><p v-if="auth.notice" class="mt-3 text-sm text-emerald-300">{{ auth.notice }}</p><button class="primary mt-5 w-full" :disabled="auth.busy">{{ auth.busy ? 'Signing in…' : 'Sign in' }}</button><button type="button" class="mt-3 w-full text-sm text-slate-400" :disabled="auth.busy" @click="auth.resetPassword(email)">Reset Firebase password</button><button type="button" class="mt-3 w-full text-sm text-slate-400" @click="loginOpen = false">Cancel</button></form></div>

    <nav class="mobile-nav"><button :class="activeSection === 'clipboard' && 'active'" @click="showSection('clipboard')">▣<span>Clipboard</span></button><button :class="activeSection === 'devices' && 'active'" @click="showSection('devices')">⌖<span>Devices</span></button><button :class="activeSection === 'settings' && 'active'" @click="showSection('settings')">⚙<span>Settings</span></button></nav>
  </main>
</template>
