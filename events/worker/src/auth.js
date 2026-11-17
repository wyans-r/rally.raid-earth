// Login: sessions + pluggable providers (AUTH_PROVIDERS="email,discord"; either can be switched off).
//   email   : a 6-digit one-time code by email (mail.js: Resend in production)
//   discord : Discord OAuth2 ("identify" scope only: id + user name, no email, no servers)
// Roles: entrant (everyone), organizer (approved by an admin), admin (ADMIN_EMAILS / ADMIN_DISCORD_IDS: Wyans).
import { now, sha256Hex, randomId, json, fail, readJson, parseCookies, clean, audit, safeEqual } from './util.js'
import { sendMail } from './mail.js'

const COOKIE = 'rr_session'
const SESSION_DAYS = 30
const CODE_MIN = 10, CODE_TRIES = 5, CODES_PER_HOUR = 5

const list = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
export const providers = env => list(env.AUTH_PROVIDERS || 'email,discord')

function cookie(env, req, value, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : ''
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export async function currentUser(env, req) {
  const tok = parseCookies(req)[COOKIE]
  if (!tok) return null
  const id = await sha256Hex('session:' + tok)
  const row = await env.DB.prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').bind(id).first()
  if (!row || row.expires_at < now()) return null
  return row
}
export async function requireUser(env, req) { const u = await currentUser(env, req); if (!u) fail(401, 'please log in'); return u }
export async function requireRole(env, req, ...roles) {
  const u = await requireUser(env, req)
  if (!roles.includes(u.role)) fail(403, 'needs the ' + roles.join(' or ') + ' role')
  return u
}

async function startSession(env, req, user) {
  const tok = randomId(32)
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString()
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256Hex('session:' + tok), user.id, now(), exp).run()
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), user.id).run()
  return cookie(env, req, tok, SESSION_DAYS * 86400)
}

// find or create the user for a verified login; admins come from the env lists (Wyans), others start as entrants
async function upsertUser(env, { email, discordId, name }) {
  let u = email ? await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
    : await env.DB.prepare('SELECT * FROM users WHERE discord_id = ?').bind(discordId).first()
  const isAdmin = (email && list(env.ADMIN_EMAILS).includes(email)) || (discordId && list(env.ADMIN_DISCORD_IDS).includes(String(discordId)))
  if (!u) {
    u = { id: 'u_' + randomId(9), email: email || null, discord_id: discordId || null, display_name: clean(name || (email ? email.split('@')[0] : 'driver'), 40), role: isAdmin ? 'admin' : 'entrant' }
    await env.DB.prepare('INSERT INTO users (id, email, discord_id, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(u.id, u.email, u.discord_id, u.display_name, u.role, now()).run()
    await audit(env, u.id, 'user.created', { via: email ? 'email' : 'discord', role: u.role })
  } else if (isAdmin && u.role !== 'admin') {
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(u.id).run(); u.role = 'admin'
  }
  return u
}

// ---- email one-time code
const validEmail = e => /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[a-z]{2,}$/i.test(e)
async function codeHash(env, email, code) { return sha256Hex(`${env.SESSION_SECRET}|${email}|${code}`) }

async function emailStart(env, req) {
  const b = await readJson(req, 4096)
  const email = clean(b.email, 254).toLowerCase()
  if (!validEmail(email)) fail(400, 'that is not an email address')
  const hourAgo = new Date(Date.now() - 3600e3).toISOString()
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?').bind(email, hourAgo).first()
  if (n.n >= CODES_PER_HOUR) fail(429, 'too many codes asked for this address: wait an hour')
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0')
  await env.DB.prepare('INSERT INTO login_codes (id, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(randomId(), email, await codeHash(env, email, code), now(), new Date(Date.now() + CODE_MIN * 60e3).toISOString()).run()
  await sendMail(env, { to: email, subject: `Rally Raid login code: ${code}`,
    text: `Your Rally Raid events login code is ${code}\n\nIt works for ${CODE_MIN} minutes. If you did not ask for it, ignore this email.\n\n${env.PUBLIC_BASE || ''}/events/` })
  return json({ ok: true, sent: true, minutes: CODE_MIN })
}
async function emailVerify(env, req) {
  const b = await readJson(req, 4096)
  const email = clean(b.email, 254).toLowerCase(), code = clean(b.code, 12).replace(/\D/g, '')
  const row = await env.DB.prepare('SELECT * FROM login_codes WHERE email = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').bind(email).first()
  if (!row || row.expires_at < now()) fail(400, 'no valid code for this address: ask for a new one')
  if (row.attempts >= CODE_TRIES) fail(429, 'too many wrong codes: ask for a new one')
  if (!safeEqual(row.code_hash, await codeHash(env, email, code))) {
    await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run()
    fail(400, 'wrong code')
  }
  await env.DB.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').bind(row.id).run()
  const u = await upsertUser(env, { email })
  return json({ ok: true, user: publicUser(u) }, 200, { 'Set-Cookie': await startSession(env, req, u) })
}

// ---- Discord OAuth2
const dApi = env => env.DISCORD_API_BASE || 'https://discord.com/api'
const dRedirect = (env, req) => (env.PUBLIC_BASE || new URL(req.url).origin) + '/api/auth/discord/callback'
async function discordStart(env, req) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) fail(503, 'Discord login is not set up yet (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET missing)')
  const state = randomId(18)
  await env.DB.prepare('INSERT INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)').bind(state, 'discord', now()).run()
  const u = new URL(env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize')
  u.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify', redirect_uri: dRedirect(env, req), state, prompt: 'none' })
  return Response.redirect(u.toString(), 302)
}
async function discordCallback(env, req) {
  const q = new URL(req.url).searchParams
  const back = (msg) => Response.redirect((env.PUBLIC_BASE || new URL(req.url).origin) + '/events/#/login?error=' + encodeURIComponent(msg), 302)
  if (q.get('error')) return back('Discord login cancelled')
  const st = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(q.get('state') || '').first()
  if (!st || Date.parse(st.created_at) < Date.now() - 10 * 60e3) return back('login expired: try again')
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(st.state).run()
  const tr = await fetch(dApi(env) + '/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code',
      code: q.get('code') || '', redirect_uri: dRedirect(env, req) }),
  })
  if (!tr.ok) return back('Discord did not accept the login (' + tr.status + ')')
  const tok = await tr.json()
  const me = await fetch(dApi(env) + '/users/@me', { headers: { Authorization: 'Bearer ' + tok.access_token } })
  if (!me.ok) return back('could not read the Discord user')
  const d = await me.json()
  const u = await upsertUser(env, { discordId: String(d.id), name: d.global_name || d.username })
  return new Response(null, { status: 302, headers: { Location: (env.PUBLIC_BASE || new URL(req.url).origin) + '/events/#/', 'Set-Cookie': await startSession(env, req, u) } })
}

export const publicUser = u => u && { id: u.id, name: u.display_name, role: u.role, email: u.email || null, discord: !!u.discord_id }

// ---- routes
export async function authRoutes(env, req, path) {
  const m = req.method
  const on = p => providers(env).includes(p)
  if (path === '/api/auth/providers' && m === 'GET') return json({ providers: providers(env) })
  if (path === '/api/auth/email/start' && m === 'POST' && on('email')) return emailStart(env, req)
  if (path === '/api/auth/email/verify' && m === 'POST' && on('email')) return emailVerify(env, req)
  if (path === '/api/auth/discord/start' && m === 'GET' && on('discord')) return discordStart(env, req)
  if (path === '/api/auth/discord/callback' && m === 'GET' && on('discord')) return discordCallback(env, req)
  if (path === '/api/auth/logout' && m === 'POST') {
    const tok = parseCookies(req)[COOKIE]
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex('session:' + tok)).run()
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(env, req, '', 0) })
  }
  if (path === '/api/me' && m === 'GET') {
    const u = await currentUser(env, req)
    let reqStatus = null
    if (u) reqStatus = (await env.DB.prepare('SELECT status FROM organizer_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(u.id).first())?.status || null
    return json({ user: publicUser(u), organizerRequest: reqStatus, providers: providers(env) })
  }
  if (path === '/api/me/name' && m === 'POST') {
    const u = await requireUser(env, req)
    const name = clean((await readJson(req, 2048)).name, 40)
    if (name.length < 2) fail(400, 'name too short')
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, u.id).run()
    return json({ ok: true, name })
  }
  // organizer approval flow
  if (path === '/api/organizer/request' && m === 'POST') {
    const u = await requireUser(env, req)
    if (u.role !== 'entrant') fail(400, 'you are already ' + u.role)
    const open = await env.DB.prepare("SELECT id FROM organizer_requests WHERE user_id = ? AND status = 'pending'").bind(u.id).first()
    if (open) fail(400, 'your request is waiting for the admin')
    const note = clean((await readJson(req, 4096)).note, 500)
    await env.DB.prepare('INSERT INTO organizer_requests (id, user_id, note, created_at) VALUES (?, ?, ?, ?)').bind('or_' + randomId(9), u.id, note, now()).run()
    await audit(env, u.id, 'organizer.requested', note)
    return json({ ok: true, status: 'pending' })
  }
  if (path === '/api/admin/organizer-requests' && m === 'GET') {
    await requireRole(env, req, 'admin')
    const r = await env.DB.prepare(`SELECT r.*, u.display_name, u.email, u.discord_id, u.role FROM organizer_requests r JOIN users u ON u.id = r.user_id
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`).all()
    const orgs = await env.DB.prepare("SELECT id, display_name, email, discord_id, role FROM users WHERE role IN ('organizer', 'admin') ORDER BY role, display_name").all()
    return json({ requests: r.results, organizers: orgs.results })
  }
  let mm
  if ((mm = path.match(/^\/api\/admin\/organizer-requests\/([\w-]+)$/)) && m === 'POST') {
    const a = await requireRole(env, req, 'admin')
    const d = (await readJson(req, 2048)).decision
    if (!['approve', 'reject'].includes(d)) fail(400, 'decision must be approve or reject')
    const r = await env.DB.prepare('SELECT * FROM organizer_requests WHERE id = ?').bind(mm[1]).first()
    if (!r) fail(404, 'no such request')
    await env.DB.prepare('UPDATE organizer_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').bind(d === 'approve' ? 'approved' : 'rejected', a.id, now(), r.id).run()
    if (d === 'approve') await env.DB.prepare("UPDATE users SET role = 'organizer' WHERE id = ? AND role = 'entrant'").bind(r.user_id).run()
    await audit(env, a.id, 'organizer.' + d, r.user_id)
    return json({ ok: true })
  }
  if ((mm = path.match(/^\/api\/admin\/users\/([\w-]+)\/role$/)) && m === 'POST') {
    const a = await requireRole(env, req, 'admin')
    const role = (await readJson(req, 2048)).role
    if (!['entrant', 'organizer'].includes(role)) fail(400, 'role must be entrant or organizer (admins come from the settings)')
    if (mm[1] === a.id) fail(400, 'not your own role')
    await env.DB.prepare("UPDATE users SET role = ? WHERE id = ? AND role != 'admin'").bind(role, mm[1]).run()
    await audit(env, a.id, 'user.role', { user: mm[1], role })
    return json({ ok: true })
  }
  // dev / test only: read the "sent" login emails
  if (path === '/api/dev/outbox' && m === 'GET' && env.DEV_MODE === '1' && env.MAIL_MODE === 'outbox') {
    const r = await env.DB.prepare('SELECT * FROM dev_outbox ORDER BY id DESC LIMIT 20').all()
    return json({ mails: r.results })
  }
  return null
}
