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
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore'

import { importRemoteImage, importRemoteTextItem, listClipboardItems, readLocalImage } from './clipboard'
import { downloadImage, filebaseConfigurationError, filebaseConfigured, imageObjectKey, uploadImage } from './filebase'
import type { ClipboardItem } from '../types'

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

  if (!filebaseConfigured) throw new Error(filebaseConfigurationError ?? 'Filebase is not configured')
  if (!item.width || !item.height || item.mimeType !== 'image/png') return
  const objectKey = imageObjectKey(uid, item.contentHash)
  await uploadImage(objectKey, await readLocalImage(item.id))
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
    objectKey,
    schemaVersion: 2,
  })
}

export async function publishRecentClipboardItems(uid: string): Promise<void> {
  const localItems = await listClipboardItems('')
  await Promise.all(localItems.map((item) => publishClipboardItem(uid, item)))
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
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed') continue
          const data = change.doc.data()
          if (
            typeof data.id !== 'string' ||
            typeof data.contentHash !== 'string' ||
            typeof data.createdAt !== 'number' ||
            typeof data.sourceDevice !== 'string'
          ) continue

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
            data.kind === 'image' && filebaseConfigured && data.objectKey === imageObjectKey(uid, data.contentHash) &&
            typeof data.width === 'number' && typeof data.height === 'number' && data.mimeType === 'image/png'
          ) {
            await importRemoteImage({
              id: data.id, kind: 'image', textContent: null, previewDataUrl: null,
              contentHash: data.contentHash, createdAt: data.createdAt, sourceDevice: data.sourceDevice,
              width: data.width, height: data.height, mimeType: data.mimeType, objectKey: data.objectKey,
            }, await downloadImage(data.objectKey))
          } else if (data.kind === 'image') {
            throw new Error(filebaseConfigurationError ?? 'Invalid remote image metadata')
          } else {
            continue
          }
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
