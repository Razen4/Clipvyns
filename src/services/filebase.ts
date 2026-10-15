import { AwsClient } from 'aws4fetch'

const endpoint = import.meta.env.VITE_FILEBASE_ENDPOINT?.replace(/\/$/, '')
const bucket = import.meta.env.VITE_FILEBASE_BUCKET
const accessKeyId = import.meta.env.VITE_FILEBASE_ACCESS_KEY
const secretAccessKey = import.meta.env.VITE_FILEBASE_SECRET_KEY
const region = import.meta.env.VITE_FILEBASE_REGION || 'us-east-1'

const missing = [
  ['VITE_FILEBASE_ENDPOINT', endpoint],
  ['VITE_FILEBASE_BUCKET', bucket],
  ['VITE_FILEBASE_ACCESS_KEY', accessKeyId],
  ['VITE_FILEBASE_SECRET_KEY', secretAccessKey],
].filter(([, value]) => !value).map(([name]) => name)

export const filebaseConfigured = missing.length === 0
export const filebaseConfigurationError = filebaseConfigured
  ? null
  : `Missing Filebase configuration: ${missing.join(', ')}`

function client(): AwsClient {
  if (!filebaseConfigured || !accessKeyId || !secretAccessKey) {
    throw new Error(filebaseConfigurationError ?? 'Filebase is not configured')
  }
  return new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region })
}

function objectUrl(objectKey: string): string {
  if (!endpoint || !bucket) throw new Error(filebaseConfigurationError ?? 'Filebase is not configured')
  return `${endpoint}/${encodeURIComponent(bucket)}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
}

export function imageObjectKey(uid: string, contentHash: string): string {
  return `users/${uid}/images/${contentHash}.png`
}

export async function uploadImage(objectKey: string, pngBase64: string): Promise<void> {
  const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0))
  const response = await client().fetch(objectUrl(objectKey), {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
  })
  if (!response.ok) throw new Error(`Filebase upload failed (${response.status})`)
}

export async function downloadImage(objectKey: string): Promise<string> {
  const response = await client().fetch(objectUrl(objectKey), { method: 'GET' })
  if (!response.ok) throw new Error(`Filebase download failed (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
