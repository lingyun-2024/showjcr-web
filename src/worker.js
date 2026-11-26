import { configured, finishLogin, logout, sessionFor, startLogin } from './auth.js';
import { deadlineResponse, syncDeadlines } from './deadlines.js';

function json(data, status = 200) {
  return Response.json(data, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
function sameOrigin(request, url) {
  return request.headers.get('Origin') === url.origin;
}

async function favorites(request, env, url, identity) {
  if (!identity) return json({ error: '需要登录' }, 401);
  const userId = identity.github_id;
  if (request.method === 'GET' && url.pathname === '/api/favorites') {
    const result = await env.DB.prepare(
      'SELECT venue_id AS venueId, edition_id AS id, year FROM favorites WHERE github_id = ? ORDER BY created_at DESC',
    ).bind(userId).all();
    return json(result.results);
  }
  const target = /^\/api\/favorites\/([a-f0-9]{16})\/([a-z0-9][a-z0-9_.-]{0,89})$/i.exec(url.pathname);
  if (!target) return json({ error: '找不到该会议届次' }, 404);
  if (!['PUT', 'DELETE'].includes(request.method)) return json({ error: '请求方式不支持' }, 405);
  if (!sameOrigin(request, url)) return json({ error: '请从本站发起请求' }, 403);
  const [, venue, edition] = target;
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM favorites WHERE github_id = ? AND venue_id = ? AND edition_id = ?')
      .bind(userId, venue, edition).run();
    return json({ saved: false });
  }
  const match = await env.DB.prepare(
    "SELECT json_extract(editions.value, '$.year') AS year " +
    "FROM deadline_snapshot, json_each(payload, '$.editions') AS editions " +
    "WHERE deadline_snapshot.id = 1 AND json_extract(editions.value, '$.venueId') = ? " +
    "AND json_extract(editions.value, '$.id') = ? LIMIT 1",
  ).bind(venue, edition).first();
  if (!match) return json({ error: '来源已更新，请刷新后重试' }, 404);
  await env.DB.prepare(
    'INSERT INTO favorites (github_id, venue_id, edition_id, year, created_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT (github_id, venue_id, edition_id) DO NOTHING',
  ).bind(userId, venue, edition, match.year, Date.now()).run();
  return json({ saved: true });
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isGet = request.method === 'GET';
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (path === '/api/deadlines' && isGet) return deadlineResponse(env.DB, ctx, request);
  if (path === '/api/auth/github' && isGet) return startLogin(request, env);
  if (path === '/api/auth/github/callback' && isGet) return finishLogin(request, env);
  if (path === '/api/me' && isGet) {
    const user = await sessionFor(request, env);
    return json({ user: user ? { login: user.login } : null, loginAvailable: configured(env) });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    return sameOrigin(request, url) ? logout(request, env) : json({ error: '请从本站发起请求' }, 403);
  }
  if (path === '/api/favorites' || path.startsWith('/api/favorites/')) {
    return favorites(request, env, url, await sessionFor(request, env));
  }
  return json({ error: '找不到该接口' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error('ShowJCR request failed:', error.message);
      return json({ error: '服务暂不可用' }, 500);
    }
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(syncDeadlines(env.DB));
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil(env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()).run());
    }
  },
};
