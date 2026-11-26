import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import catalog from '../public/catalog.json' with { type: 'json' };
import { digest, startLogin, finishLogin, sessionFor } from '../src/auth.js';
import { deadlineInstant, projectDeadlines, syncDeadlines } from '../src/deadlines.js';
import worker from '../src/worker.js';

function testDb() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  return {
    sql,
    prepare(statement) {
      const prepared = sql.prepare(statement);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        first() { return prepared.get(...values) || null; },
        run() { return prepared.run(...values); },
        all() { return { results: prepared.all(...values) }; },
      };
    },
  };
}

const now = new Date().getUTCFullYear();
const date = now + '-12-13 23:59:59';

function makeFeed() {
  const seen = new Set();
  const fixture = [];
  for (const venue of catalog.filter((item) => item.kind === 'conference')) {
    const dblp = venue.dblp?.[0];
    if (!dblp || seen.has(dblp) || ['ccs', 'asiaccs'].includes(dblp)) continue;
    seen.add(dblp);
    fixture.push({
      dblp, title: venue.name,
      confs: [{ year: now, id: 'conference-' + fixture.length, link: 'https://example.org/',
        timezone: 'AoE', timeline: [{ deadline: date }, { deadline: 'TBD' }] }],
    });
  }
  fixture.push(...['CCS', 'AsiaCCS'].map((name) => ({
    title: name, dblp: 'ccs', confs: [{ year: now, id: name.toLowerCase() + now, timezone: 'PT',
      timeline: [{ deadline: date, abstract_deadline: now + '-12-11 23:59:59' }, { deadline: 'TBD' }] }],
  })));
  return fixture;
}

function upstreamResponse(json) {
  return Response.json(json, { headers: { etag: '"test-snapshot"' } });
}
function releaseLease(db) {
  db.sql.exec('UPDATE deadline_snapshot SET last_attempt = 0');
}

test('public catalog preserves candidate types, original Chinese tiers and public field allowlist', () => {
  assert.equal(catalog.length, 760);
  assert.equal(catalog.filter((entry) => entry.kind === 'conference').length, 396);
  assert.equal(new Set(catalog.map((entry) => entry.id)).size, 760);
  const allowed = new Set(['id', 'name', 'kind', 'aliases', 'ccf', 'cacr', 'grade', 'international', 'chinese', 'region',
    'regionSources', 'dblp']);
  for (const entry of catalog) {
    assert.ok(entry.ccf || entry.cacr);
    assert.match(entry.grade, /^[ABC]$/);
    const sourceGrades = [entry.ccf, entry.cacr].filter(Boolean).sort();
    assert.ok(entry.grade <= sourceGrades[0]);
    if (entry.kind === 'conference') assert.equal(entry.grade, sourceGrades[0]);
    assert.ok(Object.keys(entry).every((key) => allowed.has(key)));
  }
  const chinese = catalog.find((entry) => entry.name === 'Chinese Journal of Electronics');
  assert.deepEqual(chinese.chinese, ['T1']);
  assert.equal(chinese.ccf, 'A');
  const sciUpgrade = catalog.find((entry) => entry.name === 'Advanced Engineering Informatics');
  assert.equal(sciUpgrade.ccf, 'B');
  assert.equal(sciUpgrade.grade, 'A');
  const cvm = catalog.filter((entry) => entry.name.startsWith('Computational Visual Media'));
  assert.equal(new Set(cvm.map((entry) => entry.kind)).size, 2);
});

test('rounds preserve pending values and timezone conversion handles offsets and DST', () => {
  assert.equal(deadlineInstant('2026-04-11 23:59:59', 'AoE'), Date.parse('2026-04-12T11:59:59Z'));
  assert.equal(deadlineInstant('2026-04-11 23:59:59', 'UTC+5:30'), Date.parse('2026-04-11T18:29:59Z'));
  assert.equal(deadlineInstant('2026-07-11 23:59:59', 'PT'), Date.parse('2026-07-12T06:59:59Z'));
  assert.equal(deadlineInstant('2026-01-11 23:59:59', 'PT'), Date.parse('2026-01-12T07:59:59Z'));
  assert.equal(deadlineInstant('2026-03-08 02:30:00', 'PT'), null);
  assert.equal(deadlineInstant('2026-02-30 12:00:00', 'UTC'), null);
  assert.equal(deadlineInstant('TBD', 'AoE'), null);
  const data = projectDeadlines(makeFeed());
  const ccs = data.editions.find((entry) => entry.short === 'CCS');
  const asia = data.editions.find((entry) => entry.short === 'AsiaCCS');
  assert.notEqual(ccs.venueId, asia.venueId);
  assert.equal(ccs.rounds.length, 2);
  assert.ok(ccs.rounds[0].abstractAt < ccs.rounds[0].submissionAt);
  assert.equal(ccs.rounds[1].submissionAt, null);
});

test('sync handles ETags, failures and a later changed deadline in the same edition', async () => {
  const db = testDb();
  const feed = makeFeed();
  await syncDeadlines(db, async () => upstreamResponse(feed));
  const select = db.sql.prepare('SELECT * FROM deadline_snapshot WHERE id = 1');
  const original = select.get();
  assert.equal(original.result, 'ok');
  releaseLease(db);
  await assert.rejects(syncDeadlines(db, async () => new Response(null, { status: 502 })), /502/);
  assert.equal(select.get().result, 'failed');
  assert.equal(select.get().last_success, original.last_success);
  assert.equal(select.get().payload, original.payload);
  releaseLease(db);
  await syncDeadlines(db, async (_url, options) => {
    assert.equal(options.headers.get('If-None-Match'), '"test-snapshot"');
    return new Response(null, { status: 304 });
  });
  assert.equal(select.get().result, 'ok');
  assert.equal(select.get().payload, original.payload);
  releaseLease(db);
  feed[0].confs[0].timeline[0].deadline = now + '-12-15 23:59:59';
  await syncDeadlines(db, async () => upstreamResponse(feed));
  const updated = JSON.parse(select.get().payload);
  assert.equal(updated.editions.find((item) => item.id === 'conference-0').rounds[0].submission,
    now + '-12-15 23:59:59');
});

test('OAuth uses state and PKCE, rejects mismatches and stores a hashed session', async () => {
  const db = testDb();
  const env = { DB: db, GITHUB_CLIENT_ID: 'oauth-test', GITHUB_CLIENT_SECRET: 'fake-for-test' };
  const start = await startLogin(new Request('https://showjcr.example/api/auth/github'), env);
  const redirect = new URL(start.headers.get('location'));
  const cookie = start.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(redirect.searchParams.get('scope'), '');
  assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
  const pair = cookie.split(';')[0];
  const mismatch = await finishLogin(new Request('https://showjcr.example/api/auth/github/callback?code=stub&state=wrong',
    { headers: { cookie: pair } }), env, () => assert.fail('Invalid state called GitHub'));
  assert.equal(mismatch.headers.get('location'), '/?auth=denied');
  const callback = new URL('https://showjcr.example/api/auth/github/callback');
  callback.search = new URLSearchParams({ code: 'stub', state: redirect.searchParams.get('state') });
  const login = await finishLogin(new Request(callback, { headers: { cookie: pair } }), env, async (url, opts) => {
    if (url.includes('access_token')) {
      const tokenRequest = JSON.parse(opts.body);
      assert.equal(await digest(tokenRequest.code_verifier), redirect.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'unused-token' });
    }
    assert.equal(opts.headers.Authorization, 'Bearer unused-token');
    return Response.json({ id: 123, login: 'reader' });
  });
  assert.equal(login.headers.get('location'), '/');
  const sessionCookie = login.headers.getSetCookie().find((value) => value.includes('showjcr-session')).split(';')[0];
  const session = await sessionFor(new Request('https://showjcr.example/', { headers: { cookie: sessionCookie } }), env);
  assert.equal(session.github_id, '123');
  assert.equal(session.login, 'reader');
  const stored = db.sql.prepare('SELECT * FROM sessions').get();
  assert.ok(!sessionCookie.includes(stored.token_hash));
  assert.ok(!JSON.stringify(stored).includes('unused-token'));
});

test('favorites survive a second device, isolate accounts, reject cross-origin writes and support logout', async () => {
  const db = testDb();
  await syncDeadlines(db, async () => upstreamResponse(makeFeed()));
  const active = JSON.parse(db.sql.prepare('SELECT payload FROM deadline_snapshot').get().payload).editions[0];
  const save = db.sql.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
  const tokens = { first: 'A'.repeat(43), second: 'B'.repeat(43), other: 'C'.repeat(43) };
  for (const [device, token] of Object.entries(tokens)) {
    const user = device === 'other' ? '2' : '1';
    save.run(await digest(token), user, 'account-' + user, Date.now() + 30_000);
  }
  const request = (path, device, method = 'GET', origin = 'https://showjcr.example') =>
    worker.fetch(new Request('https://showjcr.example' + path, { method, headers: {
      ...(device ? { cookie: '__Host-showjcr-session=' + tokens[device] } : {}), origin,
    } }), { DB: db }, {});
  const endpoint = '/api/favorites/' + active.venueId + '/' + active.id;
  assert.equal((await request('/api/favorites')).status, 401);
  assert.equal((await request(endpoint, 'first', 'PUT', 'https://other.example')).status, 403);
  for (let retry = 0; retry < 2; retry++) {
    assert.deepEqual(await (await request(endpoint, 'first', 'PUT')).json(), { saved: true });
  }
  assert.equal((await (await request('/api/favorites', 'second')).json()).length, 1);
  assert.equal((await (await request('/api/favorites', 'other')).json()).length, 0);
  await request(endpoint, 'other', 'DELETE');
  assert.equal((await (await request('/api/favorites', 'second')).json()).length, 1);
  await request(endpoint, 'second', 'DELETE');
  assert.equal((await (await request('/api/favorites', 'first')).json()).length, 0);
  assert.equal((await request('/api/auth/logout', 'first', 'POST')).status, 204);
  assert.equal((await request('/api/favorites', 'first')).status, 401);
  assert.equal((await request('/api/favorites', 'second')).status, 200);
});
