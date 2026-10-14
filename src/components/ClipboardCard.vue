<script setup lang="ts">
import { computed } from 'vue'

import type { ClipboardItem } from '../types'

const props = defineProps<{
  item: ClipboardItem
  active: boolean
  restoring: boolean
  deleting: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  delete: [id: string]
}>()

const relativeTime = computed(() => {
  const seconds = Math.max(0, Math.floor((Date.now() - props.item.createdAt) / 1000))
  if (seconds < 10) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(props.item.createdAt)
})

const textPreview = computed(() => props.item.textContent?.replace(/\s+/g, ' ').trim() || '')
</script>

<template>
  <div class="group relative">
    <button
      class="grid w-full items-center gap-3 rounded-xl border pl-3 pr-12 text-left transition"
      :class="[
        active ? 'border-violet-400/70 bg-violet-400/10' : 'border-white/6 bg-white/[0.035] hover:border-white/15 hover:bg-white/[0.065]',
        item.kind === 'image' ? 'grid-cols-[96px_minmax(0,1fr)] py-3' : 'grid-cols-[44px_minmax(0,1fr)] py-2.5',
      ]"
      type="button"
      :aria-label="`Paste ${item.kind} item from ${item.sourceDevice}`"
      :aria-busy="restoring"
      @click="emit('select', item.id)"
    >
      <div
        class="flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-800 text-slate-400"
        :class="item.kind === 'image' ? 'h-20 w-24' : 'size-11'"
      >
        <img
          v-if="item.kind === 'image' && item.previewDataUrl"
          :src="item.previewDataUrl"
          alt="Clipboard image preview"
          class="size-full object-contain"
        />
        <svg v-else class="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 7h10M7 11h10M7 15h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
      </div>

      <div class="min-w-0">
        <p v-if="item.kind === 'text'" class="line-clamp-2 text-[13px] font-medium leading-5 text-slate-100">
          {{ textPreview || 'Empty text' }}
        </p>
        <p v-else class="truncate text-[13px] font-medium text-slate-100">
          Image · {{ item.width }}×{{ item.height }}
        </p>
        <div class="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500">
          <span class="size-1.5 shrink-0 rounded-full bg-emerald-400"></span>
          <span class="truncate">{{ item.sourceDevice }}</span>
          <span aria-hidden="true">·</span>
          <time :datetime="new Date(item.createdAt).toISOString()">{{ relativeTime }}</time>
        </div>
      </div>
    </button>

    <button
      class="absolute right-2 top-1/2 min-w-8 -translate-y-1/2 rounded-lg border border-transparent px-2 py-1.5 text-[10px] text-slate-500 transition hover:border-rose-400/25 hover:bg-rose-400/10 hover:text-rose-300 focus-visible:text-rose-300 disabled:cursor-wait disabled:opacity-50"
      type="button"
      :disabled="deleting"
      aria-label="Delete clipboard item"
      @click.stop="emit('delete', item.id)"
    >
      <span v-if="deleting">…</span>
      <svg v-else class="mx-auto size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M8 9v8m4-8v8m4-8v8M5 6h14m-9-2h4m-7 2 .7 14h8.6L17 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>
