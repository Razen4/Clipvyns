<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Unsubscribe } from 'firebase/firestore'
import { getVersion } from '@tauri-apps/api/app'
import { isRegistered, register, unregister, type ShortcutEvent } from '@tauri-apps/plugin-global-shortcut'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

import { DEVICE_ACTIVE_WINDOW_MS, observeDevices, type ConnectedDevice } from './services/firebase'
import { isLaunchAtLoginEnabled, revealDesktopApplication, setLaunchAtLogin } from './services/clipboard'
import { useAuthStore } from './stores/auth'
import { useClipboardStore } from './stores/clipboard'
import type { ClipboardItem } from './types'

const store = useClipboardStore()
const auth = useAuthStore()
const activeSection = ref<'clipboard' | 'devices' | 'settings'>('clipboard')
const filter = ref<'all' | 'image' | 'text'>('all')
const selectedId = ref<string | null>(null)
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
const launchAtLoginEnabled = ref(false)
const launchAtLoginBusy = ref(false)
const launchAtLoginError = ref<string | null>(null)
const appVersion = ref('…')
const availableUpdate = shallowRef<Update | null>(null)
const updateStatus = ref<'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error'>('idle')
const updateError = ref<string | null>(null)
const updateNotice = ref<string | null>(null)
const updateDownloaded = ref(0)
const updateTotal = ref<number | null>(null)
let stopDevices: Unsubscribe | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let activeShortcut: string | null = null

const visibleItems = computed(() => store.items.filter((item) => filter.value === 'all' || item.kind === filter.value))
const selected = computed(() => store.items.find((item) => item.id === selectedId.value) ?? null)
const profileName = computed(() => auth.user?.displayName || auth.user?.email?.split('@')[0] || 'Clipvyn user')
const profileInitial = computed(() => profileName.value.trim().charAt(0).toUpperCase() || 'U')
const syncReady = computed(() => auth.signedIn && store.remoteReady && !store.syncing && !store.syncError)
const syncLabel = computed(() => !auth.signedIn ? 'Not signed in' : store.syncError ? 'Sync error' : syncReady.value ? 'Synced' : 'Syncing…')
const updateBusy = computed(() => ['checking', 'downloading', 'installing'].includes(updateStatus.value))
const updateProgress = computed(() => updateTotal.value
  ? Math.min(100, Math.round(updateDownloaded.value / updateTotal.value * 100))
  : null)

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

function pasteItem(item: ClipboardItem) {
  selectedId.value = item.id
  void store.paste(item.id)
}

function showSection(section: 'clipboard' | 'devices' | 'settings') {
  activeSection.value = section
}

function onSearch(event: Event) { store.scheduleSearch((event.target as HTMLInputElement).value) }
function deviceIsActive(device: ConnectedDevice) { return now.value - device.lastSeen < DEVICE_ACTIVE_WINDOW_MS }
function age(value: number) { const min = Math.floor((Date.now() - value) / 60000); return min < 1 ? 'now' : min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago` }

async function revealApplication(event: ShortcutEvent) {
  if (event.state !== 'Pressed') return
  await revealDesktopApplication()
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

async function loadLaunchAtLogin() {
  launchAtLoginBusy.value = true
  launchAtLoginError.value = null
  try {
    launchAtLoginEnabled.value = await isLaunchAtLoginEnabled()
  } catch {
    launchAtLoginError.value = 'Unable to read the launch-at-login setting.'
  } finally {
    launchAtLoginBusy.value = false
  }
}

async function toggleLaunchAtLogin() {
  const nextValue = !launchAtLoginEnabled.value
  launchAtLoginBusy.value = true
  launchAtLoginError.value = null
  try {
    await setLaunchAtLogin(nextValue)
    launchAtLoginEnabled.value = await isLaunchAtLoginEnabled()
  } catch {
    launchAtLoginError.value = nextValue
      ? 'Unable to enable launch at login. Check your system settings and try again.'
      : 'Unable to disable launch at login. Check your system settings and try again.'
  } finally {
    launchAtLoginBusy.value = false
  }
}

async function checkForApplicationUpdate(manual = true) {
  if (updateBusy.value) return
  updateStatus.value = 'checking'
  updateError.value = null
  updateNotice.value = null
  try {
    const nextUpdate = await check({ timeout: 15_000 })
    if (availableUpdate.value && availableUpdate.value !== nextUpdate) {
      await availableUpdate.value.close()
    }
    availableUpdate.value = nextUpdate
    updateStatus.value = nextUpdate ? 'available' : 'idle'
    if (!nextUpdate && manual) updateNotice.value = `Version ${appVersion.value} is up to date.`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Could not fetch a valid release JSON')) {
      updateStatus.value = 'idle'
      if (manual) updateNotice.value = 'No published update is available yet.'
      return
    }
    updateStatus.value = 'error'
    updateError.value = message
  }
}

async function installApplicationUpdate() {
  const update = availableUpdate.value
  if (!update || updateBusy.value) return
  updateStatus.value = 'downloading'
  updateError.value = null
  updateNotice.value = null
  updateDownloaded.value = 0
  updateTotal.value = null
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') updateTotal.value = event.data.contentLength ?? null
      if (event.event === 'Progress') updateDownloaded.value += event.data.chunkLength
      if (event.event === 'Finished') updateStatus.value = 'installing'
    }, { restartAfterInstall: true })
    await relaunch()
  } catch (error) {
    updateStatus.value = 'error'
    updateError.value = error instanceof Error ? error.message : String(error)
  }
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
  await Promise.all([
    store.initialize(),
    auth.initialize(),
    getVersion().then((version) => { appVersion.value = version }),
  ])
  await loadLaunchAtLogin()
  if (auth.user) await store.startSync(auth.user.uid)
  if (shortcutEnabled.value) await activateShortcut(shortcutValue.value)
  void checkForApplicationUpdate(false)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stopDevices?.()
  if (clockTimer) clearInterval(clockTimer)
  if (activeShortcut) void unregister(activeShortcut)
  if (availableUpdate.value && !updateBusy.value) void availableUpdate.value.close()
  store.dispose()
  auth.dispose()
})
</script>

<template>
  <main class="web-shell h-screen overflow-hidden bg-[#070c1b] text-slate-100">
    <aside class="hidden w-72 shrink-0 border-r border-white/8 bg-[#0a1124] p-6 lg:flex lg:flex-col">
      <div class="mb-12 flex items-center gap-3"><div class="brand-mark"><img src="/icon.png" alt="Clipvyn" /></div><div><b class="text-lg">Clipvyn</b><p class="text-sm text-slate-400">Sync across devices</p></div></div>
      <nav class="space-y-2 text-sm"><button class="nav" :class="activeSection === 'clipboard' && 'active'" @click="showSection('clipboard')">▣ Clipboard <span>{{ store.items.length }}</span></button><button class="nav" :class="activeSection === 'devices' && 'active'" @click="showSection('devices')">⌖ Devices <span>{{ devices.length }}</span></button><button class="nav" :class="activeSection === 'settings' && 'active'" @click="showSection('settings')">⚙ Settings</button></nav>
      <div class="account-card mt-auto rounded-2xl border border-white/8 bg-white/[.03] p-4 text-sm">
        <div class="account-profile"><img v-if="auth.user?.photoURL" :src="auth.user.photoURL" :alt="profileName" class="account-avatar" referrerpolicy="no-referrer" /><div v-else class="account-avatar account-initial">{{ profileInitial }}</div><div class="min-w-0 flex-1"><b class="block truncate">{{ auth.signedIn ? profileName : 'Guest' }}</b><p class="truncate text-xs text-slate-400">{{ auth.user?.email || 'No account connected' }}</p></div></div>
        <div class="account-status"><span :class="syncReady ? 'status-online' : 'status-offline'">●</span><div><b>{{ syncLabel }}</b><p>{{ syncReady ? 'Clipboard is up to date' : store.syncError ? 'Clipboard sync needs attention' : auth.signedIn ? 'Connecting to Firebase' : 'Sign in to sync your clipboard' }}</p></div></div>
        <button class="account-card-action" :disabled="auth.busy" @click="auth.signedIn ? auth.signOut() : (loginOpen = true)">{{ auth.busy ? 'Please wait…' : auth.signedIn ? 'Sign out' : 'Sign in' }}</button>
      </div>
    </aside>

    <section class="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
      <header class="app-header mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-white/8 bg-[#0c1428] px-5 py-4">
        <div class="header-top"><div class="header-copy"><h1 class="text-2xl font-semibold">{{ activeSection === 'clipboard' ? 'Clipboard' : activeSection === 'devices' ? 'Devices & Sync' : 'Settings' }}</h1><p class="mt-1 text-sm text-slate-400">{{ activeSection === 'clipboard' ? 'Your latest 50 items · Sync across devices' : activeSection === 'devices' ? 'Your connected clipboard devices' : 'Manage your clipboard experience' }}</p><span class="mobile-sync-state lg:hidden"><i :class="syncReady ? 'online' : 'offline'" />{{ auth.signedIn ? syncLabel : 'Local only' }}</span></div><button class="mobile-account-action lg:hidden" :disabled="auth.busy" @click="auth.signedIn ? auth.signOut() : (loginOpen = true)"><span class="mobile-account-avatar">{{ auth.signedIn ? profileInitial : '♙' }}</span><span>{{ auth.signedIn ? 'Sign out' : 'Sign in' }}</span></button></div>
        <div v-if="activeSection === 'clipboard'" class="header-actions ml-auto flex w-full items-center gap-2 sm:w-auto"><label class="mobile-search"><span aria-hidden="true">⌕</span><input :value="store.query" type="search" placeholder="Search clipboard…" @input="onSearch" /></label><span class="desktop-auto-capture">● Automatic capture</span></div>
      </header>

      <p v-if="store.syncError" class="mb-4 rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{{ store.syncError }}</p>
      <div v-if="store.pasteNotice" class="paste-notice" :class="store.pasteNoticeKind === 'success' && 'copy-toast'" role="status" aria-live="polite"><span>{{ store.pasteNotice }}</span><button type="button" aria-label="Dismiss paste notice" @click="store.pasteNotice = null; store.pasteNoticeKind = null">×</button></div>

      <section v-if="activeSection === 'settings' || availableUpdate" class="update-panel" aria-live="polite">
        <div class="min-w-0 flex-1">
          <b>{{ availableUpdate ? `Update ${availableUpdate.version} available` : `Application version ${appVersion}` }}</b>
          <p v-if="availableUpdate?.body" class="update-notes">{{ availableUpdate.body }}</p>
          <p v-else-if="updateStatus === 'checking'">Checking for updates…</p>
          <p v-else-if="updateStatus === 'downloading'">Downloading update{{ updateProgress === null ? '…' : ` · ${updateProgress}%` }}</p>
          <p v-else-if="updateStatus === 'installing'">Installing update…</p>
          <p v-else-if="updateError" class="update-error">{{ updateError }}</p>
          <p v-else>{{ updateNotice || 'Updates are verified before installation.' }}</p>
          <div v-if="updateStatus === 'downloading'" class="update-progress"><span :style="{ width: `${updateProgress ?? 8}%` }" /></div>
        </div>
        <button v-if="availableUpdate" type="button" class="primary update-action" :disabled="updateBusy" @click="installApplicationUpdate">
          {{ updateStatus === 'downloading' ? 'Downloading…' : updateStatus === 'installing' ? 'Installing…' : 'Update and restart' }}
        </button>
        <button v-else type="button" class="secondary update-action" :disabled="updateBusy" @click="checkForApplicationUpdate(true)">
          {{ updateStatus === 'checking' ? 'Checking…' : 'Check for updates' }}
        </button>
      </section>

      <template v-if="activeSection === 'clipboard'">
        <section class="panel web-list">
          <div class="mb-5 flex gap-2"><button v-for="tab in [['all','All'],['image','Images'],['text','Text']] as const" :key="tab[0]" class="filter" :class="filter === tab[0] && 'selected'" @click="filter = tab[0]">{{ tab[1] }}</button></div>
          <p v-if="store.error" class="list-error">{{ store.error }}</p>
          <div v-if="store.loading || !visibleItems.length" class="empty">{{ store.loading ? 'Loading clipboard…' : store.query ? 'No matching clipboard items.' : 'Copy text or an image and it will appear here.' }}</div>
          <div v-else class="space-y-3"><article v-for="item in visibleItems" :key="item.id" class="clip-row"><button class="clip" :class="[selectedId === item.id && 'clip-selected', item.pinned && 'clip-pinned']" :disabled="store.restoringId === item.id" @click="pasteItem(item)"><div class="thumb" :class="item.kind === 'text' && 'text-thumb'"><img v-if="item.previewDataUrl" :src="item.previewDataUrl" alt="Clipboard preview" /><span v-else>{{ item.kind === 'image' ? '▧' : '≡' }}</span></div><div class="min-w-0 flex-1 text-left"><b :class="item.kind === 'text' ? 'text-preview' : 'block truncate'">{{ item.kind === 'image' ? `Image · ${item.width} × ${item.height}` : item.textContent }}</b><p v-if="item.kind === 'image'" class="mt-1 truncate text-sm text-slate-400">PNG image</p><p class="mt-2 text-xs text-slate-500">● {{ item.sourceDevice }} · {{ age(item.createdAt) }}</p></div><span v-if="store.restoringId === item.id" class="badge">Pasting…</span></button><div class="clip-actions"><button type="button" class="clip-pin" :class="item.pinned && 'pinned'" :aria-label="item.pinned ? 'Unpin clipboard item' : 'Pin clipboard item'" :title="item.pinned ? 'Unpin' : 'Pin'" @click="store.togglePinned(item.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 4 6 6-3 1-4 4-2 5-2-5-4-4-3-1 6-6z" /></svg></button><button type="button" class="clip-delete" :disabled="store.deletingId === item.id" aria-label="Delete clipboard item" title="Delete clipboard item" @click="store.remove(item.id)"><svg v-if="store.deletingId !== item.id" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-8 0 1 13h8l1-13" /></svg><span v-else class="delete-spinner" aria-hidden="true" /></button></div></article></div>
        </section>
      </template>

      <section v-else-if="activeSection === 'devices'" class="panel devices-panel"><div v-if="!auth.signedIn" class="empty">Sign in to see connected devices.</div><div v-else-if="deviceError" class="empty">Device sync error: {{ deviceError }}</div><div v-else-if="!devices.length" class="empty">No device heartbeat yet.</div><div v-else class="space-y-3"><article v-for="device in devices" :key="device.id" class="device-card"><div class="device-icon">{{ device.platform.toLowerCase().includes('win') ? '⊞' : device.platform.toLowerCase().includes('mac') ? '⌘' : '◫' }}</div><div class="min-w-0 flex-1"><b class="block truncate">{{ device.name }}</b><p class="mt-1 text-sm text-slate-400">{{ device.platform }}</p><p class="mt-2 text-xs" :class="deviceIsActive(device) ? 'text-emerald-400' : 'text-slate-500'">● {{ deviceIsActive(device) ? 'Active recently' : `Last seen ${age(device.lastSeen)}` }}</p></div><span class="badge" :class="deviceIsActive(device) ? 'device-online' : 'device-offline'">{{ deviceIsActive(device) ? 'Active' : 'Inactive' }}</span></article></div></section>

      <section v-else class="panel settings-panel"><h2 class="text-lg font-semibold">Sync settings</h2><div class="setting-row"><div><b>Automatic capture</b><p>New clipboard items are captured and synced immediately.</p></div><span class="setting-on">On</span></div><div class="setting-row"><div><b>Launch at login</b><p>Open Clipvyn automatically when you sign in to macOS or Windows.</p><p v-if="launchAtLoginError" class="shortcut-error">{{ launchAtLoginError }}</p></div><button type="button" role="switch" :aria-checked="launchAtLoginEnabled" :disabled="launchAtLoginBusy" class="shortcut-toggle" :class="launchAtLoginEnabled && 'enabled'" @click="toggleLaunchAtLogin"><span /></button></div><div class="setting-row shortcut-setting"><div><b>Open app shortcut</b><p>Shows and focuses the app while it is running.</p><p v-if="shortcutError" class="shortcut-error">{{ shortcutError }}</p></div><div class="shortcut-controls"><select :value="shortcutValue" :disabled="shortcutBusy" aria-label="Global shortcut" @change="changeShortcut"><option v-for="option in shortcutOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select><button type="button" role="switch" :aria-checked="shortcutEnabled" :disabled="shortcutBusy" class="shortcut-toggle" :class="shortcutEnabled && 'enabled'" @click="toggleShortcut"><span /></button></div></div><div class="setting-row"><div><b>Device status</b><p>Presence refreshes every 10 minutes.</p></div><span>10 min</span></div><div class="setting-row"><div><b>Clipboard history</b><p>Stores the latest 80 items and shows up to 50 matching items.</p></div><span>80 / 50</span></div></section>
    </section>

    <div v-if="loginOpen" class="fixed inset-0 z-30 grid place-items-center bg-black/70 p-5" @click.self="loginOpen = false"><form class="w-full max-w-sm rounded-2xl border border-white/10 bg-[#101a31] p-6" @submit.prevent="submitAuth"><h2 class="text-xl font-semibold">Sign in to Clipvyn</h2><p class="mt-1 text-sm text-slate-400">Use the same Firebase account as the web app.</p><input v-model="email" required type="email" autocomplete="email" placeholder="Email" class="search mt-5 w-full" /><input v-model="password" required type="password" autocomplete="current-password" minlength="6" placeholder="Password" class="search mt-3 w-full" /><p v-if="auth.error" class="mt-3 text-sm text-rose-300">{{ auth.error }}</p><p v-if="auth.notice" class="mt-3 text-sm text-emerald-300">{{ auth.notice }}</p><button class="primary mt-5 w-full" :disabled="auth.busy">{{ auth.busy ? 'Signing in…' : 'Sign in' }}</button><button type="button" class="mt-3 w-full text-sm text-slate-400" :disabled="auth.busy" @click="auth.resetPassword(email)">Reset Firebase password</button><button type="button" class="mt-3 w-full text-sm text-slate-400" @click="loginOpen = false">Cancel</button></form></div>

    <nav class="mobile-nav"><button :class="activeSection === 'clipboard' && 'active'" @click="showSection('clipboard')">▣<span>Clipboard</span></button><button :class="activeSection === 'devices' && 'active'" @click="showSection('devices')">⌖<span>Devices</span></button><button :class="activeSection === 'settings' && 'active'" @click="showSection('settings')">⚙<span>Settings</span></button></nav>
  </main>
</template>
