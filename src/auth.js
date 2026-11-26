const AGE = 30 * 86_400;
const STATE_AGE = 600;
const encoder = new TextEncoder();

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function secure(request) {
  return new URL(request.url).protocol === 'https:';
}
function name(request, key) {
  return (secure(request) ? '__Host-' : '') + 'showjcr-' + key;
}
function cookie(request, key, value, age) {
  return name(request, key) + '=' + value + '; Path=/; Max-Age=' + age + '; HttpOnly; SameSite=Lax' +
    (secure(request) ? '; Secure' : '');
}
function read(request, key) {
  const prefix = name(request, key) + '=';
  return (request.headers.get('Cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length) || '';
}

function redirect(path, cookies = []) {
  const headers = new Headers({ Location: path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}

export function configured(env) {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}
function callbackUri(request, env) {
  return (env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, '') + '/api/auth/github/callback';
}

export async function startLogin(request, env) {
  if (!configured(env)) return redirect('/?auth=unavailable');
  const state = random();
  const verifier = random();
  const link = new URL('https://github.com/login/oauth/authorize');
  link.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID, redirect_uri: callbackUri(request, env),
    state, code_challenge: await digest(verifier), code_challenge_method: 'S256', scope: '',
  });
  return redirect(link.href, [cookie(request, 'oauth', [state, verifier, Date.now()].join('.'), STATE_AGE)]);
}

export async function finishLogin(request, env, githubFetch = fetch) {
  const params = new URL(request.url).searchParams;
  const [state, verifier, created] = read(request, 'oauth').split('.');
  const clear = cookie(request, 'oauth', '', 0);
  const valid = /^[a-zA-Z0-9_-]{43}$/;
  const elapsed = Date.now() - Number(created);
  if (!configured(env) || !valid.test(state || '') || !valid.test(verifier || '') ||
      !(elapsed >= 0 && elapsed < STATE_AGE * 1000) || params.get('state') !== state || !params.get('code')) {
    return redirect('/?auth=denied', [clear]);
  }
  try {
    const exchanged = await githubFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
        code: params.get('code'), code_verifier: verifier, redirect_uri: callbackUri(request, env),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });
    if (!exchanged.ok) return redirect('/?auth=failed', [clear]);
    const { access_token: token } = await exchanged.json();
    if (typeof token !== 'string' || !token) return redirect('/?auth=failed', [clear]);
    const response = await githubFetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'User-Agent': 'ShowJCR-Web',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return redirect('/?auth=failed', [clear]);
    const user = await response.json();
    if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string' || !user.login) {
      return redirect('/?auth=failed', [clear]);
    }
    const session = random();
    const hash = await digest(session);
    const old = read(request, 'session');
    if (valid.test(old)) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(old)).run();
    await env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
      .bind(hash, String(user.id), user.login, Date.now() + AGE * 1000).run();
    return redirect('/', [clear, cookie(request, 'session', session, AGE)]);
  } catch {
    return redirect('/?auth=failed', [clear]);
  }
}

export async function sessionFor(request, env) {
  const token = read(request, 'session');
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare('SELECT github_id, login FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await digest(token), Date.now()).first();
}

export async function logout(request, env) {
  const token = read(request, 'session');
  if (/^[a-zA-Z0-9_-]{43}$/.test(token)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(token)).run();
  }
  return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie(request, 'session', '', 0), 'Cache-Control': 'no-store' } });
}
