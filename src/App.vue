<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import ClipboardCard from './components/ClipboardCard.vue'
import { useAuthStore } from './stores/auth'
import { useClipboardStore } from './stores/clipboard'

const store = useClipboardStore()
const authStore = useAuthStore()
const selectedIndex = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)
const authOpen = ref(false)
const email = ref('')
const password = ref('')

const statusLabel = computed(() => {
  if (store.error || store.syncError) return 'Sync error'
  if (store.loading) return 'Loading'
  if (!navigator.onLine) return 'Offline'
  if (store.syncing) return 'Syncing'
  if (authStore.signedIn) return 'Synced'
  return 'Local only'
})

const statusDot = computed(() => {
  if (store.error || store.syncError) return 'bg-rose-400'
  if (!navigator.onLine) return 'bg-amber-400'
  if (authStore.signedIn) return 'bg-emerald-400'
  return 'bg-slate-500'
})

watch(() => store.items, () => {
  selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, store.items.length - 1))
})

watch(() => authStore.user?.uid, (uid) => {
  if (uid) store.startSync(uid)
  else store.stopSync()
})

async function submitAuth() {
  try {
    await authStore.submit(email.value.trim(), password.value)
    authOpen.value = false
    password.value = ''
  } catch {
    // The auth store exposes a safe, user-facing error.
  }
}

function onSearch(event: Event) {
  selectedIndex.value = 0
  store.scheduleSearch((event.target as HTMLInputElement).value)
}

function onKeydown(event: KeyboardEvent) {
  if (authOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      authOpen.value = false
    }
    return
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selectedIndex.value = Math.min(store.items.length - 1, selectedIndex.value + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    selectedIndex.value = Math.max(0, selectedIndex.value - 1)
  } else if (event.key === 'Enter' && store.items[selectedIndex.value]) {
    event.preventDefault()
    store.paste(store.items[selectedIndex.value].id)
  } else if (event.key === '/' && document.activeElement !== searchInput.value) {
    event.preventDefault()
    searchInput.value?.focus()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await Promise.all([store.initialize(), authStore.initialize()])
  if (authStore.user) await store.startSync(authStore.user.uid)
  await nextTick()
  searchInput.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  store.dispose()
  authStore.dispose()
})
</script>

<template>
  <main class="flex h-screen flex-col overflow-hidden bg-[#0b1020] text-slate-100">
    <header class="border-b border-white/7 px-4 pb-3 pt-4">
      <div class="mb-3 flex items-center justify-between">
        <div>
          <h1 class="text-sm font-semibold tracking-tight">Clipboard</h1>
          <p class="mt-0.5 text-[11px] text-slate-500">Your latest 50 captures</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="max-w-32 truncate rounded-lg px-2 py-1 text-[10px] text-slate-400 transition hover:bg-white/8 hover:text-slate-200"
            type="button"
            @click="authStore.signedIn ? authStore.signOut() : (authOpen = true)"
          >
            {{ authStore.signedIn ? authStore.user?.email : 'Sign in' }}
          </button>
          <div class="flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.035] px-2.5 py-1 text-[10px] text-slate-400" :title="store.syncError || undefined">
            <span class="size-1.5 rounded-full" :class="statusDot"></span>
            {{ statusLabel }}
          </div>
        </div>
      </div>

      <p v-if="store.syncError" class="mb-3 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[11px] leading-4 text-rose-200">
        {{ store.syncError }}
      </p>

      <label class="relative block">
        <span class="sr-only">Search clipboard history</span>
        <svg class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.7" />
          <path d="m16 16 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        <input
          ref="searchInput"
          :value="store.query"
          type="search"
          autocomplete="off"
          placeholder="Search clipboard…"
          class="w-full rounded-xl border border-white/8 bg-white/[0.045] py-2.5 pl-9 pr-12 text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60 focus:ring-2 focus:ring-violet-400/10"
          @input="onSearch"
        />
        <kbd class="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">/</kbd>
      </label>
    </header>

    <section class="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
      <div v-if="store.loading" class="space-y-2" aria-label="Loading clipboard history">
        <div v-for="n in 5" :key="n" class="h-[66px] animate-pulse rounded-xl border border-white/5 bg-white/[0.035]"></div>
      </div>

      <div v-else-if="store.error" class="flex h-full flex-col items-center justify-center px-8 text-center">
        <div class="mb-3 flex size-10 items-center justify-center rounded-full bg-rose-400/10 text-rose-300">!</div>
        <h2 class="text-sm font-medium">History unavailable</h2>
        <p class="mt-1 max-w-64 text-xs leading-5 text-slate-500">{{ store.error }}</p>
        <button class="mt-4 rounded-lg bg-white/8 px-3 py-1.5 text-xs hover:bg-white/12" type="button" @click="store.refresh">Try again</button>
      </div>

      <div v-else-if="store.items.length === 0" class="flex h-full flex-col items-center justify-center px-8 text-center">
        <div class="mb-3 flex size-11 items-center justify-center rounded-2xl bg-violet-400/10 text-violet-300">
          <svg class="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 5h6m-7 2H6.5A1.5 1.5 0 0 0 5 8.5v10A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 17.5 7H16M9 4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5v2A1.5 1.5 0 0 1 13.5 8h-3A1.5 1.5 0 0 1 9 6.5v-2Z" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </div>
        <h2 class="text-sm font-medium">{{ store.query ? 'No matches' : 'Clipboard is ready' }}</h2>
        <p class="mt-1 max-w-64 text-xs leading-5 text-slate-500">
          {{ store.query ? 'Try a different search.' : 'Copy text or an image in any app and it will appear here.' }}
        </p>
      </div>

      <div v-else class="space-y-2" role="listbox" aria-label="Clipboard history">
        <ClipboardCard
          v-for="(item, index) in store.items"
          :key="item.id"
          :item="item"
          :active="selectedIndex === index"
          :restoring="store.restoringId === item.id"
          :deleting="store.deletingId === item.id"
          role="option"
          :aria-selected="selectedIndex === index"
          @mouseenter="selectedIndex = index"
          @select="store.paste"
          @delete="store.remove"
        />
      </div>
    </section>

    <footer class="flex items-center justify-between border-t border-white/7 px-4 py-2 text-[10px] text-slate-600">
      <span>↑↓ navigate · Enter paste</span>
      <span>{{ store.items.length }}/50</span>
    </footer>

    <div v-if="authOpen" class="absolute inset-0 z-20 flex items-center justify-center bg-[#060914]/85 p-6 backdrop-blur-sm" @click.self="authOpen = false">
      <form class="w-full max-w-sm rounded-2xl border border-white/10 bg-[#11182a] p-5 shadow-2xl" @submit.prevent="submitAuth">
        <div class="mb-4 flex items-start justify-between">
          <div>
            <h2 class="text-sm font-semibold">Sync your clipboard</h2>
            <p class="mt-1 text-[11px] text-slate-500">Use the same account on your Mac and Windows PC.</p>
          </div>
          <button type="button" class="rounded-lg px-2 py-1 text-slate-500 hover:bg-white/8 hover:text-slate-200" aria-label="Close" @click="authOpen = false">×</button>
        </div>

        <label class="mb-3 block text-[11px] text-slate-400">
          Email
          <input v-model="email" required type="email" autocomplete="email" class="mt-1.5 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-violet-400/60" />
        </label>
        <label class="block text-[11px] text-slate-400">
          Password
          <input v-model="password" required minlength="6" type="password" autocomplete="current-password" class="mt-1.5 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-violet-400/60" />
        </label>

        <p v-if="authStore.error" class="mt-3 rounded-lg bg-rose-400/10 px-3 py-2 text-[11px] leading-4 text-rose-300">{{ authStore.error }}</p>
        <p v-if="authStore.notice" class="mt-3 rounded-lg bg-emerald-400/10 px-3 py-2 text-[11px] leading-4 text-emerald-300">{{ authStore.notice }}</p>

        <button class="mt-4 w-full rounded-lg bg-violet-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-violet-400 disabled:cursor-wait disabled:opacity-60" type="submit" :disabled="authStore.busy">
          {{ authStore.busy ? 'Please wait…' : 'Sign in' }}
        </button>
        <button
          class="w-full rounded-lg px-3 py-2 text-[11px] text-slate-500 hover:bg-white/5 hover:text-slate-300 disabled:opacity-50"
          type="button"
          :disabled="authStore.busy"
          @click="authStore.resetPassword(email)"
        >
          Reset Firebase password
        </button>
      </form>
    </div>
  </main>
</template>
