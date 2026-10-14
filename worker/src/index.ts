import { AwsClient } from 'aws4fetch'
import { createRemoteJWKSet, jwtVerify } from 'jose'

interface Env {
  FIREBASE_PROJECT_ID: string
  FILEBASE_ENDPOINT: string
  FILEBASE_REGION: string
  FILEBASE_BUCKET: string
  FILEBASE_ACCESS_KEY_ID: string
  FILEBASE_SECRET_ACCESS_KEY: string
  ALLOWED_ORIGINS: string
}

interface ImageRequest {
  contentHash?: unknown
  byteLength?: unknown
  objectKey?: unknown
}

const firebaseKeys = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)
const HASH_PATTERN = /^[a-f0-9]{64}$/
const MAX_ENCRYPTED_IMAGE_BYTES = 25 * 1024 * 1024
const URL_TTL_SECONDS = 300

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS)
    if (!cors) return json({ error: 'origin_not_allowed' }, 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors)

    try {
      const uid = await authenticatedUserId(request, env.FIREBASE_PROJECT_ID)
      const body = (await request.json()) as ImageRequest
      const url = new URL(request.url)
      const aws = new AwsClient({
        accessKeyId: env.FILEBASE_ACCESS_KEY_ID,
        secretAccessKey: env.FILEBASE_SECRET_ACCESS_KEY,
        service: 's3',
        region: env.FILEBASE_REGION,
      })

      if (url.pathname === '/v1/images/presign-upload') {
        const hash = requireHash(body.contentHash)
        const byteLength = requireByteLength(body.byteLength)
        const objectKey = `users/${uid}/images/${hash}.bin`
        const signedUrl = await signedObjectUrl(aws, env, objectKey, 'PUT')
        return json({ objectKey, signedUrl, byteLength, expiresAt: Date.now() + URL_TTL_SECONDS * 1000 }, 200, cors)
      }

      if (url.pathname === '/v1/images/confirm') {
        const objectKey = requireOwnedObjectKey(body.objectKey, uid)
        const response = await aws.fetch(objectUrl(env, objectKey), { method: 'HEAD' })
        if (response.status === 404) return json({ exists: false }, 200, cors)
        if (!response.ok) throw new Error(`Filebase HEAD failed with ${response.status}`)
        return json({ exists: true }, 200, cors)
      }

      if (url.pathname === '/v1/images/presign-download') {
        const objectKey = requireOwnedObjectKey(body.objectKey, uid)
        const signedUrl = await signedObjectUrl(aws, env, objectKey, 'GET')
        return json({ signedUrl, expiresAt: Date.now() + URL_TTL_SECONDS * 1000 }, 200, cors)
      }

      return json({ error: 'not_found' }, 404, cors)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request_failed'
      const status = message === 'unauthorized' ? 401 : message.startsWith('invalid_') ? 400 : 500
      return json({ error: message }, status, cors)
    }
  },
} satisfies ExportedHandler<Env>

async function authenticatedUserId(request: Request, projectId: string): Promise<string> {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) throw new Error('unauthorized')
  try {
    const { payload } = await jwtVerify(authorization.slice(7), firebaseKeys, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    })
    if (!payload.sub) throw new Error('unauthorized')
    return payload.sub
  } catch {
    throw new Error('unauthorized')
  }
}

function requireHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new Error('invalid_content_hash')
  return value
}

function requireByteLength(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > MAX_ENCRYPTED_IMAGE_BYTES) {
    throw new Error('invalid_byte_length')
  }
  return Number(value)
}

function requireOwnedObjectKey(value: unknown, uid: string): string {
  const prefix = `users/${uid}/images/`
  if (typeof value !== 'string' || !value.startsWith(prefix) || !value.endsWith('.bin')) {
    throw new Error('invalid_object_key')
  }
  const hash = value.slice(prefix.length, -4)
  requireHash(hash)
  return value
}

function objectUrl(env: Env, objectKey: string): string {
  const endpoint = env.FILEBASE_ENDPOINT.replace(/\/$/, '')
  return `${endpoint}/${encodeURIComponent(env.FILEBASE_BUCKET)}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
}

async function signedObjectUrl(
  aws: AwsClient,
  env: Env,
  objectKey: string,
  method: 'GET' | 'PUT',
): Promise<string> {
  const url = new URL(objectUrl(env, objectKey))
  url.searchParams.set('X-Amz-Expires', String(URL_TTL_SECONDS))
  const signed = await aws.sign(url, { method, aws: { signQuery: true } })
  return signed.url
}

function corsHeaders(origin: string | null, allowed: string): Headers | null {
  const origins = new Set(allowed.split(',').map((value) => value.trim()).filter(Boolean))
  if (origin && !origins.has(origin)) return null
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  })
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  return headers
}

function json(body: unknown, status: number, extraHeaders?: Headers): Response {
  const headers = new Headers(extraHeaders)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { status, headers })
}
