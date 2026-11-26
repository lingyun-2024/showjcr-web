import catalog from '../public/catalog.json' with { type: 'json' };

export const FEED_URL = 'https://ccfddl.com/conference/allconf.json';
const HOUR = 3_600_000;
const pacific = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset',
});
const conferences = catalog.filter((entry) => entry.kind === 'conference');
// Checked against the displayed CCFDDL series descriptions and the directory names.
const seriesAliases = {
  'ACM Asia Conference on Computer and Communications Security': 'AsiaCCS',
  'ACM Conference on Computer and Communications Security': 'CCS',
  'IEEE International Conference on Multimedia& Expo': 'ICME',
  'IEEE International Conference on Program Comprehension': 'ICPC',
  'International Conference on Hardware/Software Co-design and System Synthesis': 'CODES+ISSS',
  'International Conference on Parallel Architectures and Compilation Techniques': 'PACT',
  'ACM Special Interest Group on Spatial Information': 'SIGSPATIAL',
  'IEEE International Conference on AutomaticFace and Gesture Recognition': 'FG',
  'IEEE Pacific Visualization Symposium': 'PacificVis',
  'IFIP Working Group 11.9 International Conference on Digital Forensics': 'IFIP WG 11.9',
  'International Conference on Cryptology in India': 'INDOCRYPT',
  'International Conference on Formal Structures for Computation and Deduction': 'FSCD',
  'International Conference on JointCloud Computing': 'JCC',
  'National Conference on Man-Machine Speech Communication': 'NCMMSC',
  'USENIX Workshop on Hot Topics in Security': 'HotSec',
  'Web Information Systems and Applications': 'WISA',
};

function pacificOffset(timestamp) {
  const zone = pacific.formatToParts(timestamp).find((part) => part.type === 'timeZoneName').value;
  return Number(zone.slice(3));
}

export function deadlineInstant(raw, timezone) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const iso = raw.replace(' ', 'T');
  const wall = Date.parse(iso + 'Z');
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== iso) return null;
  if (timezone === 'PT') {
    for (const offset of [-8, -7]) {
      const instant = wall - offset * HOUR;
      if (pacificOffset(instant) === offset) return instant;
    }
    return null;
  }
  if (timezone === 'AoE') return wall + 12 * HOUR;
  if (timezone === 'UTC') return wall;
  const match = /^UTC([+-])(\d{1,2})(?::([0-5]\d))?$/.exec(timezone || '');
  if (!match || Number(match[2]) > 14) return null;
  const offset = (Number(match[2]) + Number(match[3] || 0) / 60) * (match[1] === '-' ? -1 : 1);
  return wall - offset * HOUR;
}

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function officialLink(value) {
  if (typeof value !== 'string') return '';
  try {
    const link = new URL(value);
    return ['https:', 'http:'].includes(link.protocol) && !link.username && !link.password ? link.href : '';
  } catch {
    return '';
  }
}

function add(index, key, value) {
  if (key) index.set(key, [...(index.get(key) || []), value]);
}

export function projectDeadlines(upstream, year = new Date().getUTCFullYear()) {
  if (!Array.isArray(upstream) || upstream.length < 100 || upstream.length > 2000) {
    throw new Error('Unexpected CCFDDL catalog size');
  }
  const byDblp = new Map();
  const byTitle = new Map();
  for (const series of upstream) {
    if (typeof series?.title !== 'string' || !Array.isArray(series.confs)) continue;
    const dblp = text(series.dblp, 100).toLowerCase();
    if (!['n', 'no dblp', 'events'].includes(dblp)) add(byDblp, dblp, series);
    add(byTitle, series.title, series);
  }
  const covered = [];
  const editions = [];
  const claimed = new Set();
  for (const venue of conferences) {
    const alias = seriesAliases[venue.name];
    const matches = new Set((venue.dblp || []).flatMap((id) => byDblp.get(id) || []));
    const reviewed = alias ? byTitle.get(alias) || [] : [];
    const source = matches.size === 1 ? [...matches][0] : reviewed.length === 1 ? reviewed[0] : null;
    if (!source || claimed.has(source)) continue;
    claimed.add(source);
    covered.push(venue.id);
    const seen = new Set();
    for (const event of source.confs) {
      if (!event || !Number.isInteger(event.year) || event.year < year - 2 || event.year > year + 5) continue;
      if (!/^[a-z0-9][a-z0-9_.-]{0,89}$/i.test(event.id || '') || seen.has(event.id)) continue;
      seen.add(event.id);
      const timezone = text(event.timezone, 40);
      const rounds = (Array.isArray(event.timeline) ? event.timeline : []).slice(0, 40).map((round) => {
        const abstract = text(round?.abstract_deadline, 40);
        const submission = text(round?.deadline, 40);
        return {
          label: text(round?.comment, 220),
          abstract,
          submission,
          abstractAt: deadlineInstant(abstract, timezone),
          submissionAt: deadlineInstant(submission, timezone),
        };
      });
      editions.push({
        venueId: venue.id, id: event.id, year: event.year, short: text(source.title, 90),
        link: officialLink(event.link), place: text(event.place, 160), dates: text(event.date, 120), timezone, rounds,
      });
    }
  }
  if (covered.length < 250 || editions.length < 250) throw new Error('CCFDDL coverage dropped unexpectedly');
  return { covered, editions };
}

const readDb = (db) => db.prepare('SELECT * FROM deadline_snapshot WHERE id = 1').first();
const MAX_PAYLOAD = 1_500_000;

export async function syncDeadlines(db, fetchSource = fetch) {
  const now = Date.now();
  const lease = await db.prepare(
    "INSERT INTO deadline_snapshot (id, last_attempt) VALUES (1, ?) " +
    "ON CONFLICT(id) DO UPDATE SET last_attempt = excluded.last_attempt " +
    "WHERE deadline_snapshot.last_attempt IS NULL OR deadline_snapshot.last_attempt < ? RETURNING id",
  ).bind(now, now - 120_000).first();
  if (!lease) return;
  try {
    const previous = await readDb(db);
    const headers = new Headers({ Accept: 'application/json' });
    if (previous.etag) headers.set('If-None-Match', previous.etag);
    else if (previous.last_modified) headers.set('If-Modified-Since', previous.last_modified);
    const response = await fetchSource(FEED_URL, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status === 304 && previous.payload) {
      await db.prepare("UPDATE deadline_snapshot SET last_success = ?, result = 'ok' WHERE id = 1 AND last_attempt = ?")
        .bind(Date.now(), now).run();
      return;
    }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('CCFDDL HTTP ' + response.status);
    }
    const body = await response.text();
    if (body.length > MAX_PAYLOAD) throw new Error('Unexpected CCFDDL response size');
    const payload = JSON.stringify(projectDeadlines(JSON.parse(body)));
    if (new TextEncoder().encode(payload).length > MAX_PAYLOAD) throw new Error('Snapshot too large');
    await db.prepare(
      "UPDATE deadline_snapshot SET payload = ?, etag = ?, last_modified = ?, last_success = ?, result = 'ok' " +
      "WHERE id = 1 AND last_attempt = ?",
    ).bind(payload, response.headers.get('etag'), response.headers.get('last-modified'), Date.now(), now).run();
  } catch (error) {
    await db.prepare("UPDATE deadline_snapshot SET result = 'failed' WHERE id = 1 AND last_attempt = ?").bind(now).run();
    throw error;
  }
}

export async function deadlineResponse(db, ctx) {
  const record = await readDb(db);
  if (!record?.payload && (!record?.last_attempt || Date.now() - record.last_attempt > 120_000)) {
    ctx.waitUntil(syncDeadlines(db).catch((error) => console.error('Initial deadline sync:', error.message)));
  }
  const payload = record?.payload || '{"covered":[],"editions":[]}';
  const status = record?.payload ? 200 : 503;
  const meta = {
    lastSuccess: record?.last_success || null,
    lastAttempt: record?.last_attempt || null,
    status: record?.result || 'waiting',
  };
  return new Response('{"sync":' + JSON.stringify(meta) + ',' + payload.slice(1), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
