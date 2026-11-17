// small helpers shared by the Worker modules
export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
export const enc = new TextEncoder()
export async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export function b64url(bytes) {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function randomId(n = 16) { return b64url(crypto.getRandomValues(new Uint8Array(n))) }
export async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}
export function safeEqual(a, b) {
  a = String(a); b = String(b)
  if (a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}
export class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra } }
export const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra) }
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })
}
export async function readJson(req, maxBytes = 1e6) {
  const t = await readText(req, maxBytes)
  try { return JSON.parse(t) } catch { fail(400, 'body is not JSON') }
}
export async function readText(req, maxBytes = 1e6) {
  const len = +req.headers.get('content-length') || 0
  if (len > maxBytes) fail(413, `too large (max ${Math.round(maxBytes / 1e6)} MB)`)
  const t = await req.text()
  if (t.length > maxBytes) fail(413, `too large (max ${Math.round(maxBytes / 1e6)} MB)`)
  return t
}
export function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
export const isoOk = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?(\.\d+)?Z$/.test(s) && !isNaN(Date.parse(s))
export const clean = (s, max = 200) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
export const slugify = s => clean(s, 80).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
export async function audit(env, userId, action, detail) {
  await env.DB.prepare('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)').bind(now(), userId || null, action, typeof detail === 'string' ? detail : JSON.stringify(detail || null)).run()
}
