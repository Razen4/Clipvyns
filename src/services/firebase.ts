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
  doc,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore'

import { importRemoteImage, importRemoteTextItem, listClipboardItems, readLocalImage } from './clipboard'
import type { ClipboardItem } from '../types'

const IMAGE_CHUNK_CHARACTERS = 700_000
const MAX_IMAGE_CHUNKS = 50
const MAX_SYNC_IMAGE_BYTES = 25 * 1024 * 1024

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

function imageChunkId(contentHash: string, index: number): string {
  return `${contentHash}_${index}`
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
  const recent = query(userItems(uid), orderBy('createdAt', 'desc'), limit(50))
  return onSnapshot(recent, (snapshot) => {
    const items: ClipboardItem[] = []
    for (const entry of snapshot.docs) {
      const data = entry.data()
      if (
        typeof data.id !== 'string' || typeof data.contentHash !== 'string' ||
        typeof data.createdAt !== 'number' || typeof data.sourceDevice !== 'string'
      ) continue
      if (data.kind === 'text' && typeof data.textContent === 'string') {
        items.push({ id: data.id, kind: 'text', textContent: data.textContent, previewDataUrl: null, contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice, width: null, height: null, mimeType: 'text/plain' })
      }
      if (data.kind === 'image' && typeof data.width === 'number' && typeof data.height === 'number' && typeof data.chunkCount === 'number') {
        items.push({ id: data.id, kind: 'image', textContent: null, previewDataUrl: null, contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice, width: data.width, height: data.height, mimeType: 'image/png', chunkCount: data.chunkCount })
      }
    }
    callback(items)
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
    await setDoc(doc(userItems(uid), item.id), {
      id: item.id, ownerUid: uid, kind: 'text', textContent: item.textContent,
      contentHash: item.contentHash, createdAt: item.createdAt, sourceDevice: item.sourceDevice,
      mimeType: 'text/plain', schemaVersion: 2,
    })
    return
  }
  if (!pngBase64 || !item.width || !item.height) throw new Error('Clipboard image is invalid')
  const byteLength = Math.floor(pngBase64.length * 3 / 4) - (pngBase64.endsWith('==') ? 2 : pngBase64.endsWith('=') ? 1 : 0)
  if (byteLength > MAX_SYNC_IMAGE_BYTES) throw new Error('Image exceeds the 25 MiB sync limit')
  const chunkCount = await uploadImageChunks(uid, item.contentHash, pngBase64)
  await setDoc(doc(userItems(uid), item.id), {
    id: item.id, ownerUid: uid, kind: 'image', contentHash: item.contentHash,
    createdAt: item.createdAt, sourceDevice: item.sourceDevice, width: item.width,
    height: item.height, mimeType: 'image/png', chunkCount, byteLength, schemaVersion: 2,
  })
}

export async function publishClipboardItem(uid: string, item: ClipboardItem): Promise<void> {
  if (!firestore) return
  if (item.kind === 'text') {
    if (!item.textContent) return
    await setDoc(doc(userItems(uid), item.id), {
      id: item.id,
      ownerUid: uid,
      kind: 'text',
      textContent: item.textContent,
      contentHash: item.contentHash,
      createdAt: item.createdAt,
      sourceDevice: item.sourceDevice,
      mimeType: 'text/plain',
      schemaVersion: 2,
    })
    return
  }

  if (!item.width || !item.height || item.mimeType !== 'image/png') return
  const pngBase64 = await readLocalImage(item.id)
  const byteLength = Math.floor(pngBase64.length * 3 / 4)
    - (pngBase64.endsWith('==') ? 2 : pngBase64.endsWith('=') ? 1 : 0)
  if (byteLength > MAX_SYNC_IMAGE_BYTES) throw new Error('Image exceeds the 25 MiB sync limit')
  const chunkCount = await uploadImageChunks(uid, item.contentHash, pngBase64)
  await setDoc(doc(userItems(uid), item.id), {
    id: item.id,
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
    schemaVersion: 2,
  })
}

export async function publishRecentClipboardItems(uid: string): Promise<void> {
  const localItems = await listClipboardItems('')
  for (const item of localItems) await publishClipboardItem(uid, item)
}

export function observeRemoteClipboardItems(
  uid: string,
  onImported: () => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const recent = query(userItems(uid), orderBy('createdAt', 'desc'), limit(50))
  return onSnapshot(
    recent,
    async (snapshot) => {
      try {
        let imported = false
        const localHashes = new Set((await listClipboardItems('')).map((item) => item.contentHash))
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed') continue
          const data = change.doc.data()
          if (
            typeof data.id !== 'string' ||
            typeof data.contentHash !== 'string' ||
            typeof data.createdAt !== 'number' ||
            typeof data.sourceDevice !== 'string'
          ) continue
          if (localHashes.has(data.contentHash)) continue

          if (data.kind === 'text' && typeof data.textContent !== 'string') {
            continue
          }
          if (data.kind === 'text') {
            await importRemoteTextItem({
              id: data.id, kind: 'text', textContent: data.textContent, previewDataUrl: null,
              contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice,
              width: null, height: null, mimeType: 'text/plain',
            })
          } else if (
            data.kind === 'image' && typeof data.chunkCount === 'number' &&
            typeof data.width === 'number' && typeof data.height === 'number' && data.mimeType === 'image/png'
          ) {
            await importRemoteImage({
              id: data.id, kind: 'image', textContent: null, previewDataUrl: null,
              contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice,
              width: data.width, height: data.height, mimeType: data.mimeType,
            }, await downloadImageChunks(uid, data.contentHash, data.chunkCount))
          } else if (data.kind === 'image') {
            throw new Error('Invalid remote image metadata')
          } else {
            continue
          }
          localHashes.add(data.contentHash)
          imported = true
        }
        if (imported) onImported()
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    },
    onError,
  )
}
