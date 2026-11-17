// Email senders for the one-time login code. Pluggable by MAIL_MODE:
//   resend : https://resend.com HTTP API (needs the secret RESEND_API_KEY and MAIL_FROM on a domain verified at Resend)
//   outbox : dev / tests only: the mail lands in the D1 table dev_outbox (never configure this in production)
import { now, fail } from './util.js'

export async function sendMail(env, { to, subject, text }) {
  const mode = env.MAIL_MODE || 'resend'
  if (mode === 'outbox') {
    if (env.DEV_MODE !== '1') fail(500, 'MAIL_MODE=outbox is only for local tests')
    await env.DB.prepare('INSERT INTO dev_outbox (at, to_addr, subject, body) VALUES (?, ?, ?, ?)').bind(now(), to, subject, text).run()
    return { ok: true, mode }
  }
  if (mode === 'resend') {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) fail(503, 'email login is not set up yet (RESEND_API_KEY / MAIL_FROM missing)')
    const r = await fetch((env.RESEND_API_BASE || 'https://api.resend.com') + '/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
    })
    if (!r.ok) fail(502, 'the email could not be sent (' + r.status + ')')
    return { ok: true, mode }
  }
  fail(500, 'unknown MAIL_MODE ' + mode)
}
