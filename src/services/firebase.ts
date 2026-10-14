import { initializeApp } from 'firebase/app'
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
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
  type FirestoreError,
  type Unsubscribe,
} from 'firebase/firestore'

import { importRemoteTextItem, listClipboardItems } from './clipboard'
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

export async function registerWithEmail(email: string, password: string): Promise<void> {
  if (!auth) throw new Error(firebaseConfigurationError ?? 'Firebase is not configured')
  await createUserWithEmailAndPassword(auth, email, password)
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

export async function publishTextItem(uid: string, item: ClipboardItem): Promise<void> {
  if (!firestore || item.kind !== 'text' || !item.textContent) return
  await setDoc(doc(userItems(uid), item.id), {
    id: item.id,
    ownerUid: uid,
    kind: 'text',
    textContent: item.textContent,
    contentHash: item.contentHash,
    createdAt: item.createdAt,
    sourceDevice: item.sourceDevice,
    mimeType: 'text/plain',
    schemaVersion: 1,
  })
}

export async function publishRecentTextItems(uid: string): Promise<void> {
  const localItems = await listClipboardItems('')
  await Promise.all(localItems.filter((item) => item.kind === 'text').map((item) => publishTextItem(uid, item)))
}

export function observeRemoteTextItems(
  uid: string,
  onImported: () => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const recent = query(userItems(uid), orderBy('createdAt', 'desc'), limit(50))
  return onSnapshot(
    recent,
    async (snapshot) => {
      let imported = false
      for (const change of snapshot.docChanges()) {
        if (change.type === 'removed') continue
        const data = change.doc.data()
        if (
          data.kind !== 'text' ||
          typeof data.id !== 'string' ||
          typeof data.textContent !== 'string' ||
          typeof data.contentHash !== 'string' ||
          typeof data.createdAt !== 'number' ||
          typeof data.sourceDevice !== 'string'
        ) {
          continue
        }
        await importRemoteTextItem({
          id: data.id,
          kind: 'text',
          textContent: data.textContent,
          previewDataUrl: null,
          contentHash: data.contentHash,
          createdAt: data.createdAt,
          sourceDevice: data.sourceDevice,
          width: null,
          height: null,
          mimeType: 'text/plain',
        })
        imported = true
      }
      if (imported) onImported()
    },
    onError,
  )
}
