const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 24;
const localDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const regionNames = { CN: '中国', foreign: '外国', unknown: '待确认' };
const tabTitles = {
  calendar: ['投稿日历', '查找 CCF、CACR 推荐会议的截稿时间。'],
  catalog: ['期刊与会议', '按推荐等级、类型和地区筛选，查阅期刊或会议的目录记录。'],
  favorites: ['我的截稿', '查看已收藏的会议届次与近期截稿时间。'],
};
const deadlineStatus = { upcoming: '即将截稿', closed: '已截止', tbd: '待公布' };
const fields = ['search', 'kind', 'grade', 'ccf', 'cacr', 'region', 'status'];
const state = {
  tab: 'calendar', count: PAGE_SIZE, catalog: [], byId: new Map(), covered: new Set(),
  editions: [], favorites: [], user: null, loginAvailable: false, catalogLoading: true,
  deadlineLoading: true, catalogError: false, favoritesError: false, pending: new Set(),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
function cleanUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}
const normalize = (str) => str.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const editionKey = (entry) => entry.venueId + '/' + entry.id;

async function api(path, method = 'GET') {
  const response = await fetch(path, { method, credentials: 'same-origin' });
  if (!response.ok) throw new Error(await response.json().then((body) => body.error).catch(() => '请求失败'));
  return response.status === 204 ? null : response.json();
}
function message(value = '') {
  $('message').textContent = value;
  $('message').hidden = !value;
}

function tags(entry, showType = false) {
  const bits = [];
  if (showType) bits.push(entry.kind === 'conference' ? '会议' : '期刊');
  if (entry.grade) bits.push('成果 ' + entry.grade);
  const ccf = [...entry.international, ...entry.chinese].join(' / ');
  if (ccf) bits.push('CCF ' + ccf);
  if (entry.cacr) bits.push('CACR ' + entry.cacr);
  bits.push((entry.kind === 'conference' ? '主办方 · ' : '地区 · ') + regionNames[entry.region]);
  return '<div class="tags">' + bits.map((entry) => '<span class="tag">' + escapeHtml(entry) + '</span>').join('') + '</div>';
}

function instantEntries(edition) {
  const times = [];
  for (const round of edition.rounds) {
    if (round.abstractAt !== null) times.push({ kind: '摘要', at: round.abstractAt });
    if (round.submissionAt !== null) times.push({ kind: '全文', at: round.submissionAt });
  }
  return times.sort((a, b) => a.at - b.at);
}
function deadlineInfo(edition, now) {
  const times = instantEntries(edition);
  const next = times.find((date) => date.at > now);
  if (next) return { status: 'upcoming', time: next };
  if (!times.length || edition.rounds.some((round) => round.submissionAt === null)) return { status: 'tbd' };
  return { status: 'closed', time: times[times.length - 1] };
}
function matches(venue) {
  const query = normalize($('search').value);
  if (query && ![venue.name, ...venue.aliases].some((name) => normalize(name).includes(query))) return false;
  if (state.tab === 'catalog' && $('kind').value && venue.kind !== $('kind').value) return false;
  for (const rank of ['grade', 'ccf', 'cacr']) {
    if ($(rank).value && (venue[rank] || 'none') !== $(rank).value) return false;
  }
  return !$('region').value || $('region').value === venue.region;
}

function card(edition, venue, due) {
  const key = editionKey(edition);
  const saved = state.favorites.some((item) => editionKey(item) === key);
  const short = edition.short ? '<span class="short">' + escapeHtml(edition.short) + ' ' + edition.year + '</span>' : '';
  const title = short + '<span class="' + (short ? 'full' : '') + '">' + escapeHtml(venue.name) + '</span>';
  const action = saved ? '取消收藏' : '收藏';
  let date = '<strong>' + deadlineStatus[due.status] + '</strong>';
  if (due.time) {
    const formatted = escapeHtml(localDate.format(due.time.at));
    if (due.status === 'upcoming') {
      date = '<strong data-countdown="' + due.time.at + '"></strong><span>' + due.time.kind + ' · ' + formatted + '</span>';
    } else {
      date += '<span>' + due.time.kind + ' · ' + formatted + '</span>';
    }
  }
  return '<article class="result"><div><h2><button type="button" data-detail="' + escapeHtml(key) + '">' + title +
    '</button></h2>' + tags(venue) + (edition.place ? '<p>举办地 · ' + escapeHtml(edition.place) + '</p>' : '') +
    '</div><div class="due">' + date + '</div><button class="star" type="button" data-star="' + escapeHtml(key) +
    '" aria-label="' + action + '" title="' + action + '" aria-pressed="' + saved + '"' +
    (state.pending.has(key) ? ' disabled' : '') + '>' + (saved ? '★' : '☆') + '</button></article>';
}
function catalogCard(venue) {
  let note = '';
  if (venue.kind === 'conference') {
    if (!state.sync?.lastSuccess) note = '截稿数据尚未加载';
    else note = state.covered.has(venue.id) ? '查看会议届次' : 'CCFDDL 来源未覆盖';
  } else if (venue.name === 'Science China/中国科学') {
    note = 'CACR 系列条目';
  }
  return '<article class="result catalog"><div><h2><button type="button" data-detail="' + venue.id + '">' +
    escapeHtml(venue.name) + '</button></h2>' + tags(venue, true) + '</div><p>' + escapeHtml(note) + '</p></article>';
}
function empty(text, button = '') {
  return '<div class="empty"><p>' + text + '</p>' + button + '</div>';
}
const loginLink = '<a class="button" href="/api/auth/github">使用 GitHub 登录</a>';

function render() {
  const [title, subtitle] = tabTitles[state.tab];
  $('title').textContent = title;
  $('subtitle').textContent = subtitle;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    if (tab.dataset.tab === state.tab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('kind-filter').hidden = state.tab !== 'catalog';
  $('status-filter').hidden = state.tab !== 'calendar';
  $('timezone').textContent = state.tab === 'catalog' ? '' : '本地时间 · ' + new Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('results').setAttribute('aria-busy', state.catalogLoading || (state.tab !== 'catalog' && state.deadlineLoading));
  $('more').hidden = true;
  $('count').textContent = '';
  let cards;
  if (state.catalogLoading) {
    $('results').innerHTML = empty('正在读取期刊与会议目录。');
    return;
  }
  if (state.catalogError) {
    $('results').innerHTML = empty('目录暂时无法加载。', '<button class="button" data-retry="catalog">重试</button>');
    return;
  }
  if (state.tab === 'catalog') {
    cards = state.catalog.filter(matches).map(catalogCard);
  } else {
    if (state.tab === 'favorites' && !state.user) {
      $('results').innerHTML = empty('登录后可以跨设备查看收藏的会议。', state.loginAvailable ? loginLink : '');
      return;
    }
    if (state.tab === 'favorites' && state.favoritesError) {
      $('results').innerHTML = empty('暂时无法读取收藏。', '<button class="button" data-retry="favorites">重试</button>');
      return;
    }
    if (state.deadlineLoading) {
      $('results').innerHTML = empty('正在读取会议截稿时间。');
      return;
    }
    const now = Date.now();
    const filter = state.tab === 'calendar' ? $('status').value : '';
    const order = { upcoming: 0, tbd: 1, closed: 2 };
    const visible = state.editions.filter((edition) => {
      const venue = state.byId.get(edition.venueId);
      return venue && matches(venue) && (state.tab === 'calendar' ||
        state.favorites.some((item) => editionKey(item) === editionKey(edition)));
    }).map((edition) => ({ edition, due: deadlineInfo(edition, now) }));
    visible.sort((a, b) => order[a.due.status] - order[b.due.status] ||
      (a.due.status === 'closed' ? (b.due.time?.at || 0) - (a.due.time?.at || 0) :
        (a.due.time?.at || Infinity) - (b.due.time?.at || Infinity)) || b.edition.year - a.edition.year ||
      a.edition.short.localeCompare(b.edition.short));
    cards = visible.filter(({ due }) => !filter || due.status === filter)
      .map(({ edition, due }) => card(edition, state.byId.get(edition.venueId), due));
    if (state.tab === 'favorites' && state.sync?.lastSuccess) {
      const current = new Set(state.editions.map(editionKey));
      for (const item of state.favorites) {
        const venue = state.byId.get(item.venueId);
        if (current.has(editionKey(item)) || !venue || !matches(venue)) continue;
        cards.push('<article class="result catalog"><div><h2>' + escapeHtml(venue.name) + ' ' + item.year +
          '</h2><p>来源暂无此届次数据</p></div><button type="button" class="button secondary" data-star="' +
          escapeHtml(editionKey(item)) + '">取消收藏</button></article>');
      }
    }
  }
  $('count').textContent = state.tab === 'catalog'
    ? cards.length + ' 项结果 · 共 ' + state.catalog.length + ' 项候选'
    : cards.length + ' 个会议届次';
  $('more').hidden = cards.length <= state.count;
  if (!cards.length) {
    const blank = state.tab === 'catalog' ? '没有符合条件的期刊或会议。'
      : !state.sync?.lastSuccess ? '截稿数据暂未同步。' : state.tab === 'favorites' && !state.favorites.length
        ? '还没有收藏会议。' : '没有符合条件的会议届次。';
    const link = state.tab === 'favorites' && !state.favorites.length ? '<a href="#calendar">浏览投稿日历</a>' : '';
    $('results').innerHTML = empty(blank, link);
    return;
  }
  $('results').innerHTML = '<div class="results-list">' + cards.slice(0, state.count).join('') + '</div>';
  tick();
}

function tick() {
  const now = Date.now();
  for (const label of document.querySelectorAll('[data-countdown]')) {
    const delta = Number(label.dataset.countdown) - now;
    if (delta <= 0) {
      label.textContent = '已截止';
      continue;
    }
    const total = Math.ceil(delta / 1000);
    const parts = [Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60];
    const days = Math.floor(total / 86400);
    label.textContent = (days ? days + ' 天 ' : '') + parts.map((part) => String(part).padStart(2, '0')).join(':');
  }
}

function dateDetail(raw, at, timezone) {
  return at === null ? (raw && raw !== 'TBD' ? escapeHtml(raw + ' ' + timezone) + '（待核对时区）' : '待公布')
    : escapeHtml(localDate.format(at)) + '<small>原始时间 · ' + escapeHtml(raw + ' ' + timezone) + '</small>';
}
function openDetail(key) {
  const [venueId, editionId] = key.split('/');
  const venue = state.byId.get(venueId);
  if (!venue) return;
  const edition = editionId && state.editions.find((item) => editionKey(item) === key);
  let html = '<h2 id="detail-title">' + escapeHtml(venue.name) + (edition ? ' ' + edition.year : '') + '</h2>' + tags(venue, true);
  if (venue.aliases.length) html += '<p>简称及别名 · ' + escapeHtml(venue.aliases.join(' / ')) + '</p>';
  const sources = (venue.regionSources || []).map(cleanUrl).filter(Boolean);
  if (sources.length) html += '<p>地区依据 · ' + sources.map((url, i) =>
    '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">来源 ' + (i + 1) + '</a>').join(' · ') + '</p>';
  if (edition) {
    if (edition.place) html += '<p>当届举办地 · ' + escapeHtml(edition.place) + '</p>';
    if (edition.dates) html += '<p>会议日期 · ' + escapeHtml(edition.dates) + '</p>';
    const link = cleanUrl(edition.link);
    if (link) html += '<p><a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">查看当届会议官网</a></p>';
    html += '<h3>投稿时间</h3>';
    html += edition.rounds.map((round, index) => '<div class="round"><strong>' +
      escapeHtml(round.label || '第 ' + (index + 1) + ' 轮') + '</strong>' +
      (round.abstract ? '<p>摘要 · ' + dateDetail(round.abstract, round.abstractAt, edition.timezone) + '</p>' : '') +
      '<p>全文 · ' + dateDetail(round.submission, round.submissionAt, edition.timezone) + '</p></div>').join('')
      || '<p>截止时间待公布。</p>';
  } else if (venue.kind === 'conference') {
    const editions = state.editions.filter((item) => item.venueId === venue.id).sort((a, b) => b.year - a.year);
    html += '<h3>会议届次</h3>';
    if (!editions.length) html += '<p>' + (!state.sync?.lastSuccess ? '截稿数据尚未加载。' :
      state.covered.has(venue.id) ? '近期届次待公布。' : 'CCFDDL 来源未覆盖。') + '</p>';
    for (const item of editions) {
      html += '<p><button type="button" class="link-button" data-detail="' + escapeHtml(editionKey(item)) +
        '">' + item.year + ' · ' + deadlineStatus[deadlineInfo(item, Date.now()).status] + '</button></p>';
    }
  } else if (venue.name === 'Science China/中国科学') {
    html += '<p>CACR 将本条列为系列。分刊单独显示各自有依据的评级。</p>';
  }
  $('detail-body').innerHTML = html;
  if (!$('details').open) $('details').showModal();
  else $('close-details').focus();
}

async function loadCatalog() {
  state.catalogLoading = true;
  state.catalogError = false;
  render();
  try {
    state.catalog = await api('/catalog.json');
    state.byId = new Map(state.catalog.map((entry) => [entry.id, entry]));
  } catch {
    state.catalogError = true;
  } finally {
    state.catalogLoading = false;
    render();
  }
}
async function loadDeadlines() {
  try {
    const response = await fetch('/api/deadlines');
    const data = await response.json();
    if (!data.sync) throw new Error('Invalid deadline response');
    state.sync = data.sync;
    state.editions = data.editions;
    state.covered = new Set(data.covered);
  } catch {
    state.sync = { ...state.sync, status: 'failed' };
  } finally {
    state.deadlineLoading = false;
    const marker = $('sync');
    marker.dataset.state = state.sync?.status || 'waiting';
    const when = state.sync?.lastSuccess ? localDate.format(state.sync.lastSuccess) : '';
    const stale = state.sync?.status === 'failed' ||
      (state.sync?.lastSuccess && Date.now() - state.sync.lastSuccess > 35 * 60000);
    marker.textContent = when ? (stale ? '截稿数据更新延迟 · 上次成功 ' : '截稿数据上次同步 · ') + when
      : stale ? '截稿数据暂未同步' : '等待首次同步';
    if (stale) marker.dataset.state = 'failed';
    if (!$('results').contains(document.activeElement) && !$('details').open) render();
  }
}
async function loadFavorites() {
  if (!state.user) return;
  try {
    state.favorites = await api('/api/favorites');
    state.favoritesError = false;
  } catch {
    state.favoritesError = true;
  }
  render();
}
function renderAccount() {
  const name = state.user?.login;
  $('account').innerHTML = name ? '<span class="account-name">' + escapeHtml(name) +
    '</span><button type="button" class="button secondary" id="logout">退出</button>' :
    state.loginAvailable ? loginLink : '<span>GitHub 登录待启用</span>';
}
async function loadAccount() {
  try {
    const account = await api('/api/me');
    state.user = account.user;
    state.loginAvailable = account.loginAvailable;
    renderAccount();
    await loadFavorites();
  } catch {
    $('account').textContent = '账号服务暂不可用';
  }
}
async function updateStar(key, button) {
  if (!state.user) {
    if (state.loginAvailable) location.assign('/api/auth/github');
    else message('GitHub 登录尚未启用。');
    return;
  }
  if (state.pending.has(key)) return;
  const saved = state.favorites.some((item) => editionKey(item) === key);
  state.pending.add(key);
  button.disabled = true;
  try {
    await api('/api/favorites/' + key, saved ? 'DELETE' : 'PUT');
    const found = state.editions.find((edition) => editionKey(edition) === key);
    if (saved) state.favorites = state.favorites.filter((item) => editionKey(item) !== key);
    else state.favorites.push({ venueId: found.venueId, id: found.id, year: found.year });
    message();
  } catch (error) {
    message(error.message || '收藏暂时未能更新。');
  } finally {
    state.pending.delete(key);
    render();
    const replacement = [...document.querySelectorAll('[data-star]')].find((entry) => entry.dataset.star === key);
    if (replacement) replacement.focus();
  }
}

function resetFilters() {
  for (const id of fields) $(id).value = id === 'status' ? 'upcoming' : '';
  state.count = PAGE_SIZE;
}
function changeTab() {
  const requested = location.hash.slice(1);
  const next = Object.hasOwn(tabTitles, requested) ? requested : 'calendar';
  if (next !== state.tab) {
    state.tab = next;
    resetFilters();
  }
  render();
}
window.addEventListener('hashchange', changeTab);
for (const id of fields) $(id).addEventListener('input', () => { state.count = PAGE_SIZE; render(); });
$('reset').addEventListener('click', () => { resetFilters(); render(); });
$('show-more').addEventListener('click', () => { state.count += PAGE_SIZE; render(); });
$('close-details').addEventListener('click', () => $('details').close());
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.detail) openDetail(button.dataset.detail);
  if (button.dataset.star) await updateStar(button.dataset.star, button);
  if (button.dataset.retry === 'catalog') await loadCatalog();
  if (button.dataset.retry === 'favorites') await loadFavorites();
  if (button.id === 'logout') {
    try {
      await api('/api/auth/logout', 'POST');
      state.user = null;
      state.favorites = [];
      renderAccount();
      render();
    } catch (error) {
      message(error.message);
    }
  }
});
const url = new URL(location.href);
if (url.searchParams.has('auth')) {
  message(url.searchParams.get('auth') === 'unavailable' ? 'GitHub 登录尚未启用。' : '未完成 GitHub 登录，可重新尝试。');
  url.searchParams.delete('auth');
  history.replaceState(null, '', url);
}
changeTab();
await Promise.all([loadCatalog(), loadDeadlines(), loadAccount()]);
setInterval(tick, 1000);
setInterval(loadDeadlines, 60_000);
