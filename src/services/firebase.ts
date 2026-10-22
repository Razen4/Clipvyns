import { initializeApp } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore'

import { deleteClipboardItemByHash, importRemoteImage, importRemoteTextItem, listClipboardItems, readLocalImage, restoreClipboardItemByHash, updateClipboardItemSyncMetadata } from './clipboard'
import type { ClipboardItem } from '../types'

const IMAGE_CHUNK_CHARACTERS = 700_000
const MAX_IMAGE_CHUNKS = 50
const MAX_SYNC_IMAGE_BYTES = 25 * 1024 * 1024
const HISTORY_STORAGE_LIMIT = 80
const REMOTE_CLIPBOARD_MAX_AGE_MS = 60_000
export const DEVICE_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000
export const DEVICE_ACTIVE_WINDOW_MS = 12 * 60 * 1000

export interface ConnectedDevice {
  id: string
  name: string
  platform: string
  lastSeen: number
  online: boolean
}

const requiredEnv = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const missingEnv = Object.entries(requiredEnv)
  .filter(([, value]) => !value)
  .map(([key]) => key)

export const firebaseConfigured = missingEnv.length === 0
export const firebaseConfigurationError = firebaseConfigured
  ? null
  : `Missing Firebase configuration: ${missingEnv.join(', ')}`

const app = firebaseConfigured ? initializeApp(requiredEnv) : null
export const auth = app ? getAuth(app) : null
const firestore = app ? getFirestore(app) : null

export async function prepareAuth(): Promise<void> {
  if (!auth) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  await setPersistence(auth, browserLocalPersistence)
}

export function observeAuth(callback: (user: User | null) => void): Unsubscribe {
  if (!auth) {
    callback(null)
    return () => undefined
  }
  return onAuthStateChanged(auth, callback)
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  if (!auth) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  await signInWithEmailAndPassword(auth, email, password)
}

export async function signOutCurrentUser(): Promise<void> {
  if (!auth) return
  await signOut(auth)
}

export async function requestPasswordReset(email: string): Promise<void> {
  if (!auth) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  await sendPasswordResetEmail(auth, email)
}

function userItems(uid: string) {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  return collection(firestore, 'users', uid, 'items')
}

function userDevices(uid: string) {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  return collection(firestore, 'users', uid, 'devices')
}

function deviceId(): string {
  const key = 'clipboard-device-id'
  try {
    const existing = localStorage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    localStorage.setItem(key, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export function currentDeviceId(): string {
  return deviceId()
}

export async function deleteConnectedDevice(uid: string, id: string): Promise<void> {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  if (!id || id === deviceId()) throw new Error('The current device cannot be removed')
  await deleteDoc(doc(userDevices(uid), id))
}

export async function publishDevicePresence(
  uid: string,
  appKind: 'Web' | 'Desktop' | 'Android',
  device?: { name: string; platform: string },
): Promise<void> {
  if (!firestore) return
  const platform = device?.platform || navigator.platform || 'Unknown platform'
  const id = deviceId()
  await setDoc(doc(userDevices(uid), id), {
    id,
    ownerUid: uid,
    name: device?.name || `${appKind} · ${platform}`,
    platform,
    appKind,
    lastSeen: Date.now(),
    schemaVersion: 1,
  })
}

export function observeDevices(
  uid: string,
  callback: (devices: ConnectedDevice[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(userDevices(uid), (snapshot) => {
    const devices = snapshot.docs.flatMap((entry) => {
      const value = entry.data()
      if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.platform !== 'string' || typeof value.lastSeen !== 'number') return []
      return [{ id: value.id, name: value.name, platform: value.platform, lastSeen: value.lastSeen, online: Date.now() - value.lastSeen < DEVICE_ACTIVE_WINDOW_MS }]
    }).sort((a, b) => b.lastSeen - a.lastSeen)
    callback(devices)
  }, onError)
}

function imageChunkId(contentHash: string, index: number): string {
  return `${contentHash}_${index}`
}

function canonicalItemId(contentHash: string): string {
  const hex = contentHash.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Clipboard item hash is invalid')
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function syncedItem(uid: string, contentHash: string) {
  return doc(userItems(uid), canonicalItemId(contentHash))
}

async function itemDocumentsByHash(uid: string, contentHash: string) {
  return getDocs(query(userItems(uid), where('contentHash', '==', contentHash)))
}

async function removeLegacyItemDocuments(uid: string, contentHash: string): Promise<void> {
  const canonicalId = syncedItem(uid, contentHash).id
  const matches = await itemDocumentsByHash(uid, contentHash)
  await Promise.all(matches.docs
    .filter((entry) => entry.id !== canonicalId)
    .map((entry) => deleteDoc(entry.ref)))
}

async function uploadImageChunks(uid: string, contentHash: string, pngBase64: string): Promise<number> {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  const chunks = Array.from(
    { length: Math.ceil(pngBase64.length / IMAGE_CHUNK_CHARACTERS) },
    (_, index) => pngBase64.slice(index * IMAGE_CHUNK_CHARACTERS, (index + 1) * IMAGE_CHUNK_CHARACTERS),
  )
  if (chunks.length === 0 || chunks.length > MAX_IMAGE_CHUNKS) {
    throw new Error('Image is too large to sync')
  }
  await Promise.all(chunks.map((dataBase64, index) => setDoc(
    doc(firestore, 'users', uid, 'imageChunks', imageChunkId(contentHash, index)),
    { ownerUid: uid, contentHash, index, dataBase64, schemaVersion: 2 },
  )))
  return chunks.length
}

export async function downloadImageChunks(uid: string, contentHash: string, chunkCount: number): Promise<string> {
  if (!firestore || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_IMAGE_CHUNKS) {
    throw new Error('Invalid remote image chunks')
  }
  const snapshots = await Promise.all(Array.from({ length: chunkCount }, (_, index) => getDoc(
    doc(firestore, 'users', uid, 'imageChunks', imageChunkId(contentHash, index)),
  )))
  return snapshots.map((snapshot, index) => {
    const data = snapshot.data()
    if (!snapshot.exists() || data?.contentHash !== contentHash || data.index !== index || typeof data.dataBase64 !== 'string') {
      throw new Error('Remote image data is incomplete')
    }
    return data.dataBase64
  }).join('')
}

export function observeWebClipboardItems(
  uid: string,
  callback: (items: ClipboardItem[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const recent = query(userItems(uid), orderBy('createdAt', 'desc'))
  return onSnapshot(recent, (snapshot) => {
    const itemsByHash = new Map<string, ClipboardItem>()
    for (const entry of snapshot.docs) {
      const data = entry.data()
      if (
        typeof data.id !== 'string' || typeof data.contentHash !== 'string' ||
        typeof data.createdAt !== 'number' || typeof data.sourceDevice !== 'string'
      ) continue
      if (data.kind === 'text' && typeof data.textContent === 'string') {
        if (!itemsByHash.has(data.contentHash)) itemsByHash.set(data.contentHash, { id: data.id, kind: 'text', textContent: data.textContent, previewDataUrl: null, contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice, width: null, height: null, mimeType: 'text/plain', pinned: data.pinned === true })
      }
      if (data.kind === 'image' && typeof data.width === 'number' && typeof data.height === 'number' && typeof data.chunkCount === 'number') {
        if (!itemsByHash.has(data.contentHash)) itemsByHash.set(data.contentHash, { id: data.id, kind: 'image', textContent: null, previewDataUrl: null, contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice, width: data.width, height: data.height, mimeType: 'image/png', pinned: data.pinned === true, chunkCount: data.chunkCount })
      }
    }
    callback([...itemsByHash.values()]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
      .slice(0, HISTORY_STORAGE_LIMIT))
  }, onError)
}

export async function publishWebClipboardItem(
  uid: string,
  item: ClipboardItem,
  pngBase64?: string,
): Promise<void> {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  if (item.kind === 'text') {
    if (!item.textContent) throw new Error('Clipboard text is empty')
    const id = canonicalItemId(item.contentHash)
    await setDoc(syncedItem(uid, item.contentHash), {
      id, ownerUid: uid, kind: 'text', textContent: item.textContent,
      contentHash: item.contentHash, createdAt: item.createdAt, sourceDevice: item.sourceDevice,
      mimeType: 'text/plain', pinned: item.pinned, schemaVersion: 2,
    })
    await removeLegacyItemDocuments(uid, item.contentHash)
    await pruneSyncedClipboardItems(uid)
    return
  }
  if (!pngBase64 || !item.width || !item.height) throw new Error('Clipboard image is invalid')
  const byteLength = Math.floor(pngBase64.length * 3 / 4) - (pngBase64.endsWith('==') ? 2 : pngBase64.endsWith('=') ? 1 : 0)
  if (byteLength > MAX_SYNC_IMAGE_BYTES) throw new Error('Image exceeds the 25 MiB sync limit')
  const chunkCount = await uploadImageChunks(uid, item.contentHash, pngBase64)
  const id = canonicalItemId(item.contentHash)
  await setDoc(syncedItem(uid, item.contentHash), {
    id, ownerUid: uid, kind: 'image', contentHash: item.contentHash,
    createdAt: item.createdAt, sourceDevice: item.sourceDevice, width: item.width,
    height: item.height, mimeType: 'image/png', chunkCount, byteLength, pinned: item.pinned, schemaVersion: 2,
  })
  await removeLegacyItemDocuments(uid, item.contentHash)
  await pruneSyncedClipboardItems(uid)
}

export async function publishClipboardItem(uid: string, item: ClipboardItem, pruneAfter = true): Promise<void> {
  if (!firestore) return
  if (item.kind === 'text') {
    if (!item.textContent) return
    const id = canonicalItemId(item.contentHash)
    await setDoc(syncedItem(uid, item.contentHash), {
      id,
      ownerUid: uid,
      kind: 'text',
      textContent: item.textContent,
      contentHash: item.contentHash,
      createdAt: item.createdAt,
      sourceDevice: item.sourceDevice,
      mimeType: 'text/plain',
      pinned: item.pinned,
      schemaVersion: 2,
    })
    await removeLegacyItemDocuments(uid, item.contentHash)
    if (pruneAfter) await pruneSyncedClipboardItems(uid)
    return
  }

  if (!item.width || !item.height || item.mimeType !== 'image/png') return
  const pngBase64 = await readLocalImage(item.id)
  const byteLength = Math.floor(pngBase64.length * 3 / 4)
    - (pngBase64.endsWith('==') ? 2 : pngBase64.endsWith('=') ? 1 : 0)
  if (byteLength > MAX_SYNC_IMAGE_BYTES) throw new Error('Image exceeds the 25 MiB sync limit')
  const chunkCount = await uploadImageChunks(uid, item.contentHash, pngBase64)
  const id = canonicalItemId(item.contentHash)
  await setDoc(syncedItem(uid, item.contentHash), {
    id,
    ownerUid: uid,
    kind: 'image',
    contentHash: item.contentHash,
    createdAt: item.createdAt,
    sourceDevice: item.sourceDevice,
    width: item.width,
    height: item.height,
    mimeType: 'image/png',
    chunkCount,
    byteLength,
    pinned: item.pinned,
    schemaVersion: 2,
  })
  await removeLegacyItemDocuments(uid, item.contentHash)
  if (pruneAfter) await pruneSyncedClipboardItems(uid)
}

async function deleteSyncedClipboardHash(uid: string, contentHash: string, expectedChunkCount = 0): Promise<void> {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  const matches = await itemDocumentsByHash(uid, contentHash)
  const chunkCount = matches.docs.reduce((largest, entry) => {
    const value = entry.data().chunkCount
    return typeof value === 'number' ? Math.max(largest, value) : largest
  }, expectedChunkCount)
  await Promise.all(matches.docs.map((entry) => deleteDoc(entry.ref)))
  if (chunkCount) {
    await Promise.all(Array.from({ length: chunkCount }, (_, index) => deleteDoc(
      doc(firestore, 'users', uid, 'imageChunks', imageChunkId(contentHash, index)),
    )))
  }
}

export async function deleteSyncedClipboardItem(uid: string, item: ClipboardItem): Promise<void> {
  await deleteSyncedClipboardHash(uid, item.contentHash, item.chunkCount ?? 0)
}

export async function pruneSyncedClipboardItems(uid: string): Promise<void> {
  const snapshot = await getDocs(query(userItems(uid), orderBy('createdAt', 'desc')))
  const itemsByHash = new Map<string, { contentHash: string; createdAt: number; pinned: boolean; chunkCount: number }>()
  for (const entry of snapshot.docs) {
    const data = entry.data()
    if (typeof data.contentHash !== 'string' || typeof data.createdAt !== 'number') continue
    const candidate = {
      contentHash: data.contentHash,
      createdAt: data.createdAt,
      pinned: data.pinned === true,
      chunkCount: typeof data.chunkCount === 'number' ? data.chunkCount : 0,
    }
    const existing = itemsByHash.get(candidate.contentHash)
    if (!existing || candidate.createdAt > existing.createdAt) itemsByHash.set(candidate.contentHash, candidate)
  }
  const expired = [...itemsByHash.values()]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
    .slice(HISTORY_STORAGE_LIMIT)
  await Promise.all(expired.map((item) => deleteSyncedClipboardHash(uid, item.contentHash, item.chunkCount)))
}

export async function setSyncedClipboardItemPinned(uid: string, item: ClipboardItem, pinned: boolean): Promise<void> {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  const matches = await itemDocumentsByHash(uid, item.contentHash)
  if (matches.empty) throw new Error('Synced clipboard item no longer exists')
  await Promise.all(matches.docs.map((entry) => setDoc(entry.ref, { pinned }, { merge: true })))
}

export async function activateSyncedClipboardItem(
  uid: string,
  item: ClipboardItem,
  sourceDevice: string,
): Promise<void> {
  if (!firestore) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  const matches = await itemDocumentsByHash(uid, item.contentHash)
  if (matches.empty) throw new Error('Synced clipboard item no longer exists')
  const createdAt = Date.now()
  await Promise.all(matches.docs.map((entry) => setDoc(entry.ref, {
    createdAt,
    sourceDevice,
  }, { merge: true })))
}

export async function publishRecentClipboardItems(uid: string): Promise<void> {
  const localItems = await listClipboardItems('')
  for (const item of localItems) await publishClipboardItem(uid, item, false)
  await pruneSyncedClipboardItems(uid)
}

export function observeRemoteClipboardItems(
  uid: string,
  onImported: () => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const recent = query(userItems(uid), orderBy('createdAt', 'desc'))
  let knownHashes: Set<string> | null = null
  let initialSnapshot = true
  const listenerStartedAt = Date.now()
  const observedCreatedAt = new Map<string, number>()
  return onSnapshot(
    recent,
    async (snapshot) => {
      try {
        const processedHashes = new Set<string>()
        let clipboardCandidate: { contentHash: string; createdAt: number } | null = null
        knownHashes ??= new Set((await listClipboardItems('')).map((item) => item.contentHash))
        for (const change of snapshot.docChanges()) {
          const data = change.doc.data()
          if (change.type === 'removed') {
            observedCreatedAt.delete(change.doc.id)
            if (typeof data.contentHash === 'string') {
              const remaining = await itemDocumentsByHash(uid, data.contentHash)
              if (!remaining.empty) continue
              await deleteClipboardItemByHash(data.contentHash)
              knownHashes.delete(data.contentHash)
            }
            continue
          }
          if (
            typeof data.id !== 'string' ||
            typeof data.contentHash !== 'string' ||
            typeof data.createdAt !== 'number' ||
            typeof data.sourceDevice !== 'string'
          ) continue
          const previousCreatedAt = observedCreatedAt.get(change.doc.id)
          observedCreatedAt.set(change.doc.id, data.createdAt)
          const shouldRestoreClipboard = !initialSnapshot
            && !change.doc.metadata.hasPendingWrites
            && data.createdAt > (previousCreatedAt ?? 0)
            && data.createdAt >= listenerStartedAt - REMOTE_CLIPBOARD_MAX_AGE_MS
          if (processedHashes.has(data.contentHash)) continue
          processedHashes.add(data.contentHash)
          if (knownHashes.has(data.contentHash)) {
            await updateClipboardItemSyncMetadata({
              id: data.id, kind: data.kind, textContent: null, previewDataUrl: null,
              contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice,
              width: null, height: null, mimeType: null, pinned: data.pinned === true,
            })
            if (shouldRestoreClipboard && (!clipboardCandidate || data.createdAt > clipboardCandidate.createdAt)) {
              clipboardCandidate = { contentHash: data.contentHash, createdAt: data.createdAt }
            }
            continue
          }

          if (data.kind === 'text' && typeof data.textContent !== 'string') {
            continue
          }
          if (data.kind === 'text') {
            await importRemoteTextItem({
              id: data.id, kind: 'text', textContent: data.textContent, previewDataUrl: null,
              contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice,
              width: null, height: null, mimeType: 'text/plain', pinned: typeof data.pinned === 'boolean' ? data.pinned : false,
            })
          } else if (
            data.kind === 'image' && typeof data.chunkCount === 'number' &&
            typeof data.width === 'number' && typeof data.height === 'number' && data.mimeType === 'image/png'
          ) {
            await importRemoteImage({
              id: data.id, kind: 'image', textContent: null, previewDataUrl: null,
              contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice,
              width: data.width, height: data.height, mimeType: data.mimeType, pinned: typeof data.pinned === 'boolean' ? data.pinned : false,
            }, await downloadImageChunks(uid, data.contentHash, data.chunkCount))
          } else if (data.kind === 'image') {
            throw new Error('Invalid remote image metadata')
          } else {
            continue
          }
          knownHashes.add(data.contentHash)
          if (shouldRestoreClipboard && (!clipboardCandidate || data.createdAt > clipboardCandidate.createdAt)) {
            clipboardCandidate = { contentHash: data.contentHash, createdAt: data.createdAt }
          }
        }
        if (clipboardCandidate) await restoreClipboardItemByHash(clipboardCandidate.contentHash)
        initialSnapshot = false
        onImported()
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    },
    onError,
  )
}
