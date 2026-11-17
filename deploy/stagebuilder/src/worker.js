/**
 * stagebuilder Worker. Only /api/* is routed here (see wrangler.jsonc run_worker_first).
 * Every other path is a static asset and must not invoke this script (those stay free).
 */
import { handleOverpass } from './overpass-proxy.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/overpass') return handleOverpass(request, env, ctx);
    if (path === '/api' || path.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }
    // Safety net if run_worker_first is ever widened: still try static assets.
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};
