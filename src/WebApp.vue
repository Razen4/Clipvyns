<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Unsubscribe } from 'firebase/firestore'
import { useAuthStore } from './stores/auth'
import { downloadImageChunks, observeWebClipboardItems } from './services/firebase'
import type { ClipboardItem } from './types'

const auth = useAuthStore()
const items = ref<ClipboardItem[]>([])
const selected = ref<ClipboardItem | null>(null)
const search = ref('')
const filter = ref<'all' | 'image' | 'text'>('all')
const loginOpen = ref(false)
const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
let stop: Unsubscribe | null = null

const visible = computed(() => items.value.filter((item) => {
  const haystack = `${item.textContent || ''} ${item.sourceDevice}`.toLowerCase()
  return (filter.value === 'all' || item.kind === filter.value) && haystack.includes(search.value.toLowerCase())
}))

watch(() => auth.user?.uid, (uid) => {
  stop?.(); items.value = []; selected.value = null
  if (!uid) return
  loading.value = true
  stop = observeWebClipboardItems(uid, async (next) => {
    items.value = next; selected.value ??= next[0] ?? null
    for (const item of next.filter((entry) => entry.kind === 'image' && entry.chunkCount && !entry.previewDataUrl)) {
      try { item.previewDataUrl = `data:image/png;base64,${await downloadImageChunks(uid, item.contentHash, item.chunkCount!)}` }
      catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
    }
    loading.value = false
  }, (reason) => { error.value = reason.message; loading.value = false })
}, { immediate: true })
async function submit() { try { await auth.submit(email.value.trim(), password.value); loginOpen.value = false } catch { /* exposed by auth store */ } }
async function copy(item: ClipboardItem) { if (item.kind === 'text' && item.textContent) await navigator.clipboard.writeText(item.textContent) }
function age(value: number) { const min = Math.floor((Date.now() - value) / 60000); return min < 1 ? 'now' : min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago` }
onBeforeUnmount(() => stop?.())
onMounted(() => auth.initialize())
</script>

<template>
  <main class="web-shell min-h-screen bg-[#070c1b] text-slate-100">
    <aside class="hidden w-72 shrink-0 border-r border-white/8 bg-[#0a1124] p-6 lg:flex lg:flex-col">
      <div class="mb-12 flex items-center gap-3"><div class="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-400 to-violet-600 text-2xl">▣</div><div><b class="text-lg">MyClipboard</b><p class="text-sm text-slate-400">Sync across devices</p></div></div>
      <nav class="space-y-2 text-sm"><button class="nav active">▣ Clipboard <span>{{ items.length }}</span></button><button class="nav">☆ Favorites</button><button class="nav">⌖ Devices</button><button class="nav">⚙ Settings</button></nav>
      <div class="mt-auto rounded-2xl border border-white/8 bg-white/[.03] p-4 text-sm"><p class="text-emerald-400">● {{ auth.signedIn ? 'Synced' : 'Not signed in' }}</p><p class="mt-1 text-xs text-slate-500">{{ auth.signedIn ? 'Connected to Firebase' : 'Sign in to sync' }}</p></div>
    </aside>
    <section class="min-w-0 flex-1 p-3 sm:p-5"><header class="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-white/8 bg-[#0c1428] px-5 py-4"><div><h1 class="text-2xl font-semibold">Clipboard</h1><p class="mt-1 text-sm text-slate-400">Your latest 50 items · Sync across devices</p></div><div class="ml-auto flex w-full gap-3 sm:w-auto"><input v-model="search" placeholder="⌕  Search clipboard…" class="search sm:w-80" /><button class="primary" @click="auth.signedIn ? auth.signOut() : (loginOpen = true)">{{ auth.signedIn ? 'Sign out' : 'Sign in' }}</button></div></header>
      <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]"><section class="panel"><div class="mb-5 flex gap-2"><button v-for="tab in [['all','All'],['image','Images'],['text','Text']] as const" :key="tab[0]" class="filter" :class="filter === tab[0] && 'selected'" @click="filter = tab[0]">{{ tab[1] }}</button></div><div v-if="!auth.signedIn || loading || error || !visible.length" class="empty">{{ error || (auth.signedIn ? (loading ? 'Loading clipboard…' : 'No clipboard items yet.') : 'Sign in to view your synced clipboard.') }}</div><div v-else class="space-y-3"><button v-for="item in visible" :key="item.id" class="clip" :class="selected?.id === item.id && 'clip-selected'" @click="selected = item"><div class="thumb"><img v-if="item.previewDataUrl" :src="item.previewDataUrl" alt="Clipboard preview" /><span v-else>{{ item.kind === 'image' ? '▧' : '≡' }}</span></div><div class="min-w-0 flex-1 text-left"><b class="block truncate">{{ item.kind === 'image' ? `Image · ${item.width} × ${item.height}` : item.textContent }}</b><p class="mt-1 truncate text-sm text-slate-400">{{ item.kind === 'image' ? 'PNG image' : item.textContent }}</p><p class="mt-2 text-xs text-slate-500">● {{ item.sourceDevice }} · {{ age(item.createdAt) }}</p></div><span class="badge">{{ item.kind }}</span></button></div></section><aside class="panel"><template v-if="selected"><div class="mb-4 flex justify-between"><b>{{ selected.kind === 'image' ? `Image · ${selected.width} × ${selected.height}` : 'Text item' }}</b><span class="badge">{{ selected.kind }}</span></div><div class="preview"><img v-if="selected.previewDataUrl" :src="selected.previewDataUrl" alt="Selected image" /><p v-else>{{ selected.textContent }}</p></div><dl class="info"><div><dt>Device</dt><dd>{{ selected.sourceDevice }}</dd></div><div><dt>Type</dt><dd>{{ selected.mimeType }}</dd></div><div><dt>Copied</dt><dd>{{ new Date(selected.createdAt).toLocaleString() }}</dd></div></dl><button class="primary mt-5 w-full" @click="copy(selected)">Copy text</button></template><div v-else class="empty">Select an item to view details.</div></aside></div>
    </section>
    <div v-if="loginOpen" class="fixed inset-0 grid place-items-center bg-black/70 p-5"><form class="w-full max-w-sm rounded-2xl border border-white/10 bg-[#101a31] p-6" @submit.prevent="submit"><h2 class="text-xl font-semibold">Sign in to MyClipboard</h2><p class="mt-1 text-sm text-slate-400">Use the same Firebase account as desktop.</p><input v-model="email" required type="email" placeholder="Email" class="search mt-5 w-full" /><input v-model="password" required type="password" minlength="6" placeholder="Password" class="search mt-3 w-full" /><p v-if="auth.error" class="mt-3 text-sm text-rose-300">{{ auth.error }}</p><button class="primary mt-5 w-full" :disabled="auth.busy">{{ auth.busy ? 'Signing in…' : 'Sign in' }}</button><button type="button" class="mt-3 w-full text-sm text-slate-400" @click="loginOpen = false">Cancel</button></form></div>
  </main>
</template>
