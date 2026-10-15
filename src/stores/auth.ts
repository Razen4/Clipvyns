import { defineStore } from 'pinia'
import type { User } from 'firebase/auth'

import {
  firebaseConfigurationError,
  observeAuth,
  prepareAuth,
  requestPasswordReset,
  signInWithEmail,
  signOutCurrentUser,
} from '../services/firebase'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as User | null,
    ready: false,
    busy: false,
    error: firebaseConfigurationError as string | null,
    notice: null as string | null,
    unsubscribe: null as (() => void) | null,
  }),
  getters: {
    signedIn: (state) => state.user !== null,
  },
  actions: {
    async initialize() {
      try {
        await prepareAuth()
        this.unsubscribe = observeAuth((user) => {
          this.user = user
          this.ready = true
        })
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.ready = true
      }
    },
    async submit(email: string, password: string) {
      this.busy = true
      this.error = null
      this.notice = null
      try {
        await signInWithEmail(email, password)
      } catch (error) {
        this.error = friendlyAuthError(error)
        throw error
      } finally {
        this.busy = false
      }
    },
    async resetPassword(email: string) {
      const normalized = email.trim()
      if (!normalized) {
        this.error = 'Enter your email address first.'
        return
      }
      this.busy = true
      this.error = null
      this.notice = null
      try {
        await requestPasswordReset(normalized)
        this.notice = 'Password reset email sent. Check your inbox and spam folder.'
      } catch (error) {
        this.error = friendlyAuthError(error)
      } finally {
        this.busy = false
      }
    },
    async signOut() {
      this.busy = true
      try {
        await signOutCurrentUser()
      } finally {
        this.busy = false
      }
    },
    dispose() {
      this.unsubscribe?.()
      this.unsubscribe = null
    },
  },
})

function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('auth/invalid-credential')) {
    return 'Firebase password is incorrect. It may differ from your Gmail password; use Reset password below.'
  }
  if (message.includes('auth/email-already-in-use')) return 'This email already has an account.'
  if (message.includes('auth/weak-password')) return 'Password must contain at least 6 characters.'
  if (message.includes('auth/invalid-email')) return 'Enter a valid email address.'
  if (message.includes('auth/network-request-failed')) return 'Network unavailable. Try again when online.'
  return message
}
