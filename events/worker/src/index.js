// stagebuilder.wyans.net Worker: static site (env.ASSETS) + the async events API (/api/*). See ../../DEPLOY.md.
import { json, HttpError } from './util.js'
import { authRoutes } from './auth.js'
import { eventRoutes } from './events.js'

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' }

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const path = url.pathname
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    // plain HTTP: only the game's upload (BeamNG's Lua has no HTTPS); everything else goes to HTTPS
    if (url.protocol === 'http:' && !local && path !== '/api/game/results') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }
    // cookie-authenticated writes must come from our own pages (a custom header a foreign site cannot send)
    if (!['GET', 'HEAD'].includes(req.method) && path !== '/api/game/results' && req.headers.get('x-rr') !== '1') {
      return json({ error: 'missing X-RR header' }, 403)
    }
    try {
      const r0 = (await authRoutes(env, req, path)) || (await eventRoutes(env, req, path)) || json({ error: 'not found' }, 404)
      const r = new Response(r0.body, r0)          // (redirects have read-only headers)
      for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v)
      return r
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status)
      console.error(e && e.stack || e)
      return json({ error: 'server error' }, 500)
    }
  },
}
