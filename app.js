/* MagLens — "which magazine should I buy this month?", answered from a live
   reading of what is actually on sale in India right now.
   ---------------------------------------------------------------------------
   There is no built-in magazine database. Every title, every issue, every price
   in this app was read off a publisher or retailer page during a refresh, and
   every one of those readings carries the URL it came from and the timestamp it
   was taken at. That is the whole point: a magazine that was perfect last month
   may be unavailable, dearer, repetitive, or simply carrying a dull issue this
   month, and only a fresh read can tell you which.

   The user profile starts empty. Not "empty apart from a few sensible
   defaults" — empty. No seeded topics, no assumed interests, no demographic
   guess, no starter catalogue. The first shortlist is diverse rather than
   personalised, and it says so. Everything the model believes is derived from
   recorded interaction events and can be inspected, corrected or deleted in the
   Taste view.

   Layering, in dependency order, each section marked with a banner below:
     util → state → persistence → net → connectors → normalise → dedupe →
     issue identification → content understanding → filters → learning →
     ranking → history → views → boot

   Source-specific extraction lives only inside CONNECTORS. Retailer markup
   changes constantly; nothing outside that section may know what a Magzter page
   looks like.                                                                */

const APP_VERSION = 1;

/* ============================================================== constants  */

// Discovery reads pages through a text-extracting reader proxy. A browser
// cannot fetch magzter.com or amazon.in directly — neither sends
// Access-Control-Allow-Origin — so a static page has exactly two options: a
// proxy, or no live data at all. r.jina.ai reflects the Origin header and
// returns readable text rather than raw markup, which also means the extraction
// rules below parse prose instead of chasing CSS classes that change weekly.
//
// The chain is tried in order and the first success wins. Ordering is by
// observed reliability, not preference: allorigins and codetabs both returned
// 522 on the retailer pages this app cares about during development, so they
// are fallbacks for the plain-HTML sources rather than the primary path.
const PROXIES = [
  { id: 'jina',       label: 'r.jina.ai',      kind: 'text',
    url: u => 'https://r.jina.ai/' + u },
  { id: 'allorigins', label: 'allorigins.win', kind: 'html',
    url: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { id: 'codetabs',   label: 'codetabs.com',   kind: 'html',
    url: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
];

// Some hosts do send Access-Control-Allow-Origin and can be read directly from
// the browser. That matters for more than speed: a direct fetch originates in
// India, so prices and availability are the ones actually offered here, while a
// proxied fetch originates wherever the proxy lives and can return another
// store's currency. Direct reads are therefore marked `inRegion: true` and are
// trusted more by the price model.
const DIRECT_OK = [
  'www.autocarindia.com', 'www.theweek.in', 'www.readwhere.com',
  'openthemagazine.com', 'www.sanctuarynaturefoundation.org',
];

// Cache lifetimes. The universe of titles barely moves week to week, so the
// sitemap is cheap to keep; an individual issue page is the thing that goes
// stale, and it goes stale on the magazine's own cadence.
const TTL = {
  universe:  7  * 864e5,   // which magazines exist at all
  detail:    18 * 864e5,   // a magazine's current issue page
  detailHot: 5  * 864e5,   // …when it is in the current shortlist
  search:    3  * 864e5,   // a web-search result page
};

// One page fetch per second is roughly what the reader proxy tolerates
// unauthenticated; ten consecutive fetches at that rate came back 200/200
// during development. AdaptiveLimiter widens or narrows from here on live
// evidence rather than trusting the number.
const PACE_MS = 1000;

const DEFAULT_BUDGET = 90;

// How much louder an action is than passive noticing. Purchases and explicit
// ratings dominate by design (requirement: "weight stronger actions more
// heavily"), and a skip is worth very little because skipping is one flick of a
// thumb over a card that was barely read.
const EVENT_WEIGHT = {
  buy:           3.0,
  rate:          2.2,
  dislike:       1.7,
  like:          1.6,
  notInterested: 1.2,
  alreadyRead:   0.45,
  open:          0.5,
  skip:          0.35,
  // Recorded for the history timeline and for "have I seen this already"; it is
  // not trained on at all. See buildTaste().
  view:          0,
};

// Events that speak against a magazine. `alreadyRead` is neither: it removes an
// issue from consideration without saying anything about taste, so it carries a
// small positive signal on the topic (you read it) and a hard suppression on
// the issue.
const NEGATIVE_EVENTS = new Set(['dislike', 'notInterested', 'skip']);

// Scoring weights. Every one of these is surfaced in the Research view beside
// the component it multiplies, so a strange ranking can be traced to the term
// responsible rather than argued about.
const WEIGHTS = {
  availability:   0.9,
  freshness:      1.1,
  prefFit:        2.6,
  appeal:         0.6,   // partly a measure of how much of the issue could be read, so it is
                         // kept below the taste term rather than able to overrule it
  novelty:        0.5,
  progression:    0.6,
  valueFit:       0.7,
  exploration:    0.5,
  diversity:      0.9,   // applied against the shortlist already chosen
  repetition:    -1.3,   // topic covered too recently
  recentTitle:   -1.6,   // this exact title recommended too recently
  ownedIssue:    -4.0,   // this exact issue already bought or already read
};

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

const REJECT_REASONS = [
  'Subject does not interest me',
  'Too much news / current affairs',
  'Too text-heavy',
  'Too light — I want more depth',
  'Too expensive',
  'Wrong language',
  'Not available where I am',
  'Too similar to something I just read',
  'Wrong audience — too childish',
  'Wrong audience — not suitable for children',
  'I dislike this publisher',
  'Cover / design put me off',
];

/* ================================================================== util  */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clamp  = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const sum    = arr => arr.reduce((a, b) => a + b, 0);
const mean   = arr => (arr.length ? sum(arr) / arr.length : 0);
const uniq   = arr => Array.from(new Set(arr));
const sleep  = ms => new Promise(r => setTimeout(r, ms));

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// FNV-1a. Used for stable ids and for the deterministic jitter that decides
// which unexplored titles a refresh spends its budget on — deterministic so a
// re-run of the same month makes the same choices unless something changed.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function seededRand(seed) {
  let x = (typeof seed === 'string' ? parseInt(hash(seed), 36) : seed) >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    return x / 4294967296;
  };
}

const nowMonth = () => {
  const d = new Date();
  return d.getFullYear() * 12 + d.getMonth();
};
const monthLabel = m => MONTHS[((m % 12) + 12) % 12] + ' ' + Math.floor(m / 12);

function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear();
}

// Prices are shown in the currency they were read in, always. Converting a USD
// figure scraped from an out-of-region page into rupees and printing "₹176"
// would state a price nobody in India is being offered. The conversion exists
// only to make the number comparable for the value-fit score, and the card
// labels it as an estimate whenever the reading was not in-region.
const FX_TO_INR = { INR: 1, USD: 88, GBP: 112, EUR: 96, AUD: 58, CAD: 64, SGD: 65 };
const CURRENCY_SIGN = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AUD: 'A$', CAD: 'C$', SGD: 'S$' };

function fmtPrice(p) {
  if (!p || p.amount == null) return '—';
  const sign = CURRENCY_SIGN[p.currency] || (p.currency + ' ');
  const n = p.amount % 1 ? p.amount.toFixed(2) : String(Math.round(p.amount));
  return sign + n;
}

function toInr(p) {
  if (!p || p.amount == null) return null;
  const rate = FX_TO_INR[p.currency];
  return rate == null ? null : p.amount * rate;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// Cosine over sparse topic maps. Used for every "how similar are these two
// magazines" question in the app — overlap detection, diversity, novelty and
// progression all reduce to this.
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of Object.entries(a)) { na += v * v; if (b[k]) dot += v * b[k]; }
  for (const v of Object.values(b)) nb += v * v;
  return (na && nb) ? dot / Math.sqrt(na * nb) : 0;
}

function normaliseVec(v) {
  const n = Math.sqrt(sum(Object.values(v).map(x => x * x)));
  if (!n) return {};
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = x / n;
  return out;
}

function topEntries(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/* ================================================================== state */

// Everything below persists. `magazines` is keyed by a stable canonical id and
// holds the merged view of every source that has said anything about a title;
// `events` is the append-only interaction log the taste model is rebuilt from.
const state = {
  magazines: new Map(),   // id -> magazine record
  leads: [],              // titles known to exist but not yet read (see DISCOVERY)
  events: [],             // append-only interaction log
  filters: null,          // hard constraints, user-set only
  overrides: {},          // manual corrections to learned inferences
  merges: [],             // manual duplicate decisions: {a, b, verdict}
  meta: {
    onboarded: false,
    lastRefresh: 0,
    lastRefreshMonth: 0,
    budget: DEFAULT_BUDGET,
    jinaKey: '',
    exploreRate: 15,      // percent
    cycles: {},           // month -> {picked:[], shortlist:[], at}
    counters: {},         // discovery telemetry for the Research view
  },
  cache: new Map(),       // url -> {text, at, proxy, status}
  // Transient
  view: 'month',
  busy: false,
  abort: false,
  log: [],                // research log for the current session
  ranked: null,           // last computed ranking (cached per month+filters)
  rankKey: '',
};

function defaultFilters() {
  // Every value here is either "no constraint" or a genuine hard fact about
  // where the user is. Nothing about *taste* is defaulted, because a default
  // taste is an invented taste.
  return {
    maxPrice: null,           // INR per issue; null = no ceiling
    format: 'any',            // any | print | digital
    languages: [],            // empty = any language
    frequency: [],            // empty = any cadence
    topicsWanted: [],         // empty = no constraint (NOT a seeded interest)
    topicsExcluded: [],
    news: 'any',              // any | include | exclude
    audience: 'any',          // any | child | adult | both
    visual: 'any',            // any | visual | balanced | text
    difficulty: 'any',        // any | easy | medium | hard
    indiaOnly: true,          // only titles confirmed purchasable in India
    excludeRecentlyBought: 12,      // months
    excludeRecentSubjects: 2,       // months of subject cool-off
    overlapTolerance: 0.55,         // cosine above which two picks count as duplicates
    minConfidence: 0.25,      // drop candidates whose issue identification is a guess
    // Magazines only, by default. Newspapers, coursebooks and academic journals
    // are all genuinely on sale in India and all genuinely discovered — they
    // are simply not what this question is about. Turning them back on is one
    // click, and the Research view still lists every one of them.
    kinds: ['magazine'],
  };
}

/* ============================================================ persistence */

// IndexedDB fails in three shapes that look identical from here: it throws, it
// errors, or it never fires an event at all (headless Chrome, and a blocked
// upgrade while another tab holds the old version). The third is the dangerous
// one, so the open is raced against a timeout and every failure degrades to the
// same visible place — memory-only, with the header saying so.
const DB_NAME = 'maglens';
const DB_VER = 1;
let dbPromise = null;

function openDb() {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    setTimeout(() => done(null), 4000);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); } catch { return done(null); }
    req.onerror = () => done(null);
    req.onblocked = () => done(null);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      for (const s of ['magazines', 'leads', 'events', 'meta', 'cache']) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => done(req.result);
  });
}

function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function idbPut(store, key, value) {
  const d = await db();
  if (!d) return false;
  return new Promise(res => {
    try {
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
      tx.onabort = () => res(false);
    } catch { res(false); }
  });
}

async function idbGet(store, key) {
  const d = await db();
  if (!d) return undefined;
  return new Promise(res => {
    try {
      const tx = d.transaction(store, 'readonly');
      const r = tx.objectStore(store).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    } catch { res(undefined); }
  });
}

async function idbDel(store, key) {
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
  } catch { /* memory-only session */ }
}

let memoryOnly = false;

async function loadState() {
  const d = await db();
  memoryOnly = !d;
  if (!d) return;

  const mags = await idbGet('magazines', 'all');
  if (Array.isArray(mags)) for (const m of mags) state.magazines.set(m.id, normaliseRecord(m));

  const leads = await idbGet('leads', 'all');
  if (Array.isArray(leads)) state.leads = leads;

  const ev = await idbGet('events', 'all');
  if (Array.isArray(ev)) state.events = ev;

  const meta = await idbGet('meta', 'all');
  if (meta) {
    Object.assign(state.meta, meta.meta || {});
    state.filters = meta.filters ? { ...defaultFilters(), ...meta.filters } : null;
    state.overrides = meta.overrides || {};
    state.merges = meta.merges || [];
  }

  const cache = await idbGet('cache', 'all');
  if (Array.isArray(cache)) for (const [k, v] of cache) state.cache.set(k, v);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 700);
}

async function saveState() {
  await idbPut('magazines', 'all', Array.from(state.magazines.values()));
  await idbPut('leads', 'all', state.leads);
  await idbPut('events', 'all', state.events);
  await idbPut('meta', 'all', {
    meta: state.meta, filters: state.filters,
    overrides: state.overrides, merges: state.merges,
  });
  // The cache is the one store worth trimming: it is pure performance, it is
  // the only thing here that can grow without bound, and losing an entry costs
  // one refetch. Records and events are never evicted — a magazine dropped
  // today may be exactly right after the taste model has moved.
  const entries = Array.from(state.cache.entries())
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 1400);
  state.cache = new Map(entries);
  await idbPut('cache', 'all', entries);
}

/* ==================================================================== net */

// One limiter per upstream host. A fixed sleep between requests is wrong in
// both directions: too slow when the proxy is healthy, and not slow enough the
// moment it starts shedding load. This widens the gap on 429/5xx and narrows it
// again after a run of clean responses, so a refresh finishes as fast as the
// upstream will actually allow on the day.
class AdaptiveLimiter {
  constructor(baseMs) {
    this.gap = baseMs;
    this.base = baseMs;
    this.next = 0;
    this.good = 0;
  }
  async take() {
    const wait = this.next - Date.now();
    if (wait > 0) await sleep(wait);
    this.next = Date.now() + this.gap;
  }
  ok() {
    if (++this.good >= 6) { this.good = 0; this.gap = Math.max(this.base * 0.6, this.gap * 0.85); }
  }
  bad(hard) {
    this.good = 0;
    this.gap = Math.min(15000, this.gap * (hard ? 3 : 1.7));
    this.next = Date.now() + this.gap;
  }
}

const limiters = new Map();
function limiterFor(key) {
  if (!limiters.has(key)) limiters.set(key, new AdaptiveLimiter(PACE_MS));
  return limiters.get(key);
}

function logResearch(entry) {
  state.log.unshift({ at: Date.now(), ...entry });
  if (state.log.length > 700) state.log.length = 700;
}

function bump(counter, n = 1) {
  state.meta.counters[counter] = (state.meta.counters[counter] || 0) + n;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

// Reads a page and returns text plus provenance. Callers never see which proxy
// answered except through `via` and `inRegion`, and they must not care —
// everything downstream treats the result as "text that came from this URL at
// this time, with this much reason to believe it".
async function fetchPage(url, opts = {}) {
  const ttl = opts.ttl ?? TTL.detail;
  const key = url;
  const hit = state.cache.get(key);
  if (hit && !opts.force && Date.now() - hit.at < ttl) {
    return { ...hit, cached: true };
  }

  const host = hostOf(url);
  const direct = DIRECT_OK.includes(host);
  const attempts = [];

  // A direct read is tried first where the host allows it, because it
  // originates in the user's own region and therefore sees the prices actually
  // on offer here.
  if (direct) attempts.push({ id: 'direct', label: 'direct', kind: 'html', url: u => u, inRegion: true });
  for (const p of PROXIES) attempts.push(p);

  let lastErr = '';
  for (const proxy of attempts) {
    if (state.abort) return { text: '', at: Date.now(), error: 'aborted', via: null };
    const lim = limiterFor(proxy.id + ':' + (proxy.id === 'direct' ? host : ''));
    await lim.take();

    const headers = {};
    if (proxy.id === 'jina' && state.meta.jinaKey) {
      headers.Authorization = 'Bearer ' + state.meta.jinaKey;
    }

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeout || 45000);
      const res = await fetch(proxy.url(url), { headers, signal: ctrl.signal });
      clearTimeout(t);

      if (!res.ok) {
        lim.bad(res.status === 429 || res.status === 403);
        lastErr = proxy.label + ' HTTP ' + res.status;
        logResearch({ kind: 'fetch', url, via: proxy.label, status: res.status, ok: false });
        bump('fetchFail');
        continue;
      }

      let text = await res.text();
      if (proxy.kind === 'html') text = htmlToText(text);
      if (text.trim().length < 120) {
        lim.bad(false);
        lastErr = proxy.label + ' returned an empty page';
        logResearch({ kind: 'fetch', url, via: proxy.label, status: 'empty', ok: false });
        continue;
      }

      lim.ok();
      const rec = {
        text, at: Date.now(), via: proxy.label,
        inRegion: !!proxy.inRegion, status: res.status, cached: false,
      };
      state.cache.set(key, rec);
      bump('fetchOk');
      logResearch({ kind: 'fetch', url, via: proxy.label, status: res.status, ok: true, bytes: text.length });
      return rec;
    } catch (err) {
      lim.bad(String(err && err.name) === 'AbortError');
      lastErr = proxy.label + ': ' + (err && err.message || 'failed');
      logResearch({ kind: 'fetch', url, via: proxy.label, status: 'error', ok: false, note: lastErr });
      bump('fetchFail');
    }
  }

  // Every route failed. A stale cache entry is far better than nothing here —
  // it is real data that was true recently — so it is returned with the
  // staleness made explicit rather than discarded.
  if (hit) {
    logResearch({ kind: 'fetch', url, status: 'stale-fallback', ok: false, note: lastErr });
    return { ...hit, cached: true, stale: true, error: lastErr };
  }
  return { text: '', at: Date.now(), via: null, error: lastErr || 'unreachable' };
}

// The plain-HTML proxies hand back markup. Entities are decoded BEFORE tags are
// stripped, because doing it the other way round strips nothing (there are no
// real tags yet) and then decodes raw markup into the body.
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
                  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
                  ndash: '–', mdash: '—', hellip: '…', eacute: 'é' };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[body.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t ]+/g, ' ')
   .replace(/\n{3,}/g, '\n\n')
   .trim();
}

/* ============================================================= connectors */
/* Everything that knows what a particular retailer's page looks like lives in
   this section and nowhere else. Each connector turns one page into a list of
   OBSERVATIONS — a source's claim about a magazine at a moment in time — and
   the layers above merge observations without ever knowing where they came
   from. When a site redesigns, only its connector changes.

   An observation is deliberately not a magazine. Two sources disagreeing about
   this month's issue is normal and informative; collapsing them at read time
   would throw away exactly the signal that should lower confidence.           */

function blankObservation(src, url) {
  return {
    sourceId: src.id, sourceLabel: src.label, url, fetchedAt: 0,
    via: null, inRegion: false, storeRegion: null, sourceKey: null,
    title: null, publisher: null, category: null, language: null, frequency: null,
    issueLabel: null, coverUrl: null,
    issueDescription: null, magazineDescription: null,
    toc: [], recentIssues: [], offers: [],
    formats: [], availability: 'unknown', problems: [],
  };
}

/* ------------------------------------------------------------- magzter.com */
/* The India store (/IN/) is the single richest source this app has: one sitemap
   enumerates every title purchasable in India, and each title page carries the
   current issue label, its cover, the issue's own description, the table of
   contents with per-article reading times, the declared frequency and language,
   and the recent-issue list that lets the declared frequency be checked against
   observed publication dates.

   It is digital-only, which is why it is not the only connector. */

const MAGZTER = {
  id: 'magzter',
  label: 'Magzter (India store)',
  home: 'https://www.magzter.com/',
  sitemap: 'https://www.magzter.com/sitemapxml/magazines_1.xml',

  // The /IN/ path segment is Magzter's own marker for "sells in the India
  // store", so the sitemap doubles as an availability-in-India filter. The
  // sitemap is regenerated rarely, so its own Published Time is captured and
  // shown in Research — a title launched after that date is invisible here and
  // has to arrive through web search instead.
  async universe(ctx) {
    const page = await fetchPage(this.sitemap, { ttl: TTL.universe, timeout: 90000 });
    if (!page.text) {
      return { stubs: [], error: page.error || 'sitemap unreachable', at: page.at };
    }
    const published = /^Published Time:\s*(.+)$/m.exec(page.text);
    const seen = new Set();
    const stubs = [];
    const re = /https:\/\/www\.magzter\.com\/IN\/([^/\s)]+)\/([^/\s)]+)\/([^/\s)]+)\/?(?=[)\s]|$)/g;
    let m;
    while ((m = re.exec(page.text))) {
      const url = 'https://www.magzter.com/IN/' + m[1] + '/' + m[2] + '/' + m[3] + '/';
      if (seen.has(url)) continue;
      seen.add(url);
      stubs.push({
        sourceId: 'magzter',
        url,
        title: unslug(m[2]),
        publisher: unslug(m[1]),
        category: unslug(m[3]),
        region: 'IN',
        formats: ['digital'],
        // Position in the sitemap. Magzter emits it in title-id order, so an
        // early entry is a long-established title and a late one is usually a
        // single self-published book. It is the only quality signal available
        // before a page is read, and using it instead of a random shuffle is
        // the difference between a first run that surfaces India Today and one
        // that surfaces a defunct society newsletter.
        order: stubs.length,
      });
    }
    if (ctx && ctx.note) ctx.note('Magzter sitemap: ' + stubs.length + ' titles in the India store');
    return {
      stubs, at: page.at, cached: page.cached,
      published: published ? Date.parse(published[1]) : null,
    };
  },

  async detail(stub) {
    const page = await fetchPage(stub.url, { ttl: stub.hot ? TTL.detailHot : TTL.detail });
    const obs = blankObservation(this, stub.url);
    obs.fetchedAt = page.at;
    obs.via = page.via;
    obs.inRegion = page.inRegion;
    obs.formats = ['digital'];
    if (!page.text) {
      obs.availability = 'unknown';
      obs.problems.push('page unreachable: ' + (page.error || 'no response'));
      return obs;
    }
    if (page.stale) obs.problems.push('served from a stale cache — every live route failed');
    return parseMagzterPage(page.text, stub, obs);
  },
};

// Reader output is markdown, so any prose lifted out of it can carry link and
// image syntax. Left in, that syntax reaches the issue summary on the card and,
// worse, the text the topic miner reads — which is how "https" and "magzter"
// became topic tags on the first run.
function stripMd(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A line that is mostly link markup is navigation, not prose. The metadata row
// (Publisher/Category/Language) sits immediately under the description heading
// and would otherwise be scraped in as the magazine's description.
function isMarkupLine(line) {
  const t = String(line).trim();
  if (!t) return true;
  return stripMd(t).length < t.length * 0.55;
}

// What KIND of publication this is. The digital newsstand this app reads is not
// a magazine rack: of 10,400 titles on sale in India, roughly 4,500 are academic
// journals and coursebooks and 1,300 are daily newspapers. They are legitimately
// on sale and legitimately discovered, but "which magazine should I buy this
// month" is not a question about a Bihar teacher-recruitment guide or Tuesday's
// Dainik Jagran, and on the first run those were exactly what won.
//
// Kind is inferred, not asserted by the source, because the source's own
// category is only sometimes right — a "Books" frequency is a far better tell
// than a "Children" shelf.
function inferKind(rec) {
  const cat = String(rec.category || '').toLowerCase();
  const freq = String((rec.frequency && rec.frequency.declared) || '').toLowerCase();
  const days = rec.frequency && rec.frequency.days;
  const title = String(rec.title || '').toLowerCase();

  if (/newspaper/.test(cat)) return 'newspaper';
  if (days != null && days <= 2) return 'newspaper';
  if (/\b(daily|dainik|epaper|e-paper|times of|express)\b/.test(title) && days != null && days <= 3) return 'newspaper';
  if (/^book/.test(freq) || /one time|single|once/.test(freq)) return 'book';
  if (/academic/.test(cat)) return 'journal';
  if (rec.content && rec.content.academic) return 'journal';
  if (/\b(journal|proceedings|research)\b/.test(title)) return 'journal';
  return 'magazine';
}

function unslug(s) {
  let t = String(s);
  try { t = decodeURIComponent(t); } catch { /* a literal % in a slug */ }
  return t.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseMagzterPage(text, stub, obs) {
  const lines = text.split('\n');

  // Which store answered. A proxied read lands wherever the proxy lives, so the
  // flag in the page header is the only honest statement about whose prices
  // these are — and printing a US price as though it were the Indian one is
  // exactly the kind of fabricated certainty this app is not allowed to produce.
  const flag = /flag\/new\/([a-z]{2})\.svg/i.exec(text);
  obs.storeRegion = flag ? flag[1].toUpperCase() : null;

  // Breadcrumb. listAllIssues/<id> is Magzter's own stable identifier for the
  // title and is by far the best deduplication key available anywhere: the
  // publisher slug in the URL goes stale when a title changes hands (Autocar
  // India's URL still says Haymarket while its issues say Motowalks) but the id
  // does not move.
  const idm = /\[([^\]]+)\]\(https:\/\/www\.magzter\.com\/magazines\/listAllIssues\/(\d+)\)/.exec(text);
  if (idm) { obs.title = idm[1].trim(); obs.sourceKey = 'magzter:' + idm[2]; }

  const pubm = /\[([^\]]+)\]\(https:\/\/www\.magzter\.com\/publishers\/[^)]+\)/.exec(text);
  if (pubm) obs.publisher = pubm[1].trim();

  // "# Autocar India Magazine- August 2026". The heading is the page's own
  // statement of which issue it is showing, and it is the primary current-issue
  // signal; the bare label under the breadcrumb corroborates it.
  const head = /^#\s+(.*?)\s+Magazine-\s*(.+?)\s*$/m.exec(text);
  if (head) {
    obs.title = obs.title || head[1].trim();
    obs.issueLabel = head[2].trim();
  }
  if (!obs.issueLabel && idm) {
    const at = lines.findIndex(l => l.indexOf('listAllIssues/') >= 0);
    for (let i = at + 1; i < Math.min(at + 5, lines.length); i++) {
      const t = lines[i].trim();
      if (t && parseIssueLabel(t).precision !== 'none') { obs.issueLabel = t; break; }
    }
  }

  const meta = /\[Publisher:\s*([^\]]*)\]\([^)]*\)\[Category:\s*([^\]]*)\]\([^)]*\)\[Language:\s*([^\]]*)\]/.exec(text);
  if (meta) {
    obs.publisher = obs.publisher || unslug(meta[1]);
    obs.category = meta[2].trim();
    obs.language = meta[3].trim();
  }
  const freq = /^Frequency:\s*(.+)$/m.exec(text);
  if (freq) obs.frequency = freq[1].trim();

  // The issue's own description — the single most useful piece of text on the
  // page, because it describes THIS issue rather than the magazine in general.
  const inThis = lines.findIndex(l => /^##\s+In this issue\s*$/i.test(l));
  if (inThis >= 0) {
    const buf = [];
    for (let i = inThis + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^##\s/.test(t) || /^\[Read all Stories/i.test(t)) break;
      if (t && !isMarkupLine(t)) buf.push(stripMd(t));
      if (buf.length >= 6) break;
    }
    obs.issueDescription = buf.join(' ').trim() || null;
  }

  const descHead = lines.findIndex(l => /^##\s+.*Description:\s*$/i.test(l));
  if (descHead >= 0) {
    const buf = [];
    for (let i = descHead + 1; i < lines.length && buf.length < 14; i++) {
      const t = lines[i].trim();
      if (/^##\s/.test(t)) break;
      if (t && !isMarkupLine(t)) buf.push(stripMd(t.replace(/^\*\s*/, '')));
    }
    obs.magazineDescription = buf.join(' ').trim() || null;
  }

  // Cover lines. Each is "## [HEADLINE then blurb ![Image](thumb) 4 mins](url)".
  // These are the strongest content signal in the app: they are what is
  // actually in the issue, in the issue's own words, rather than the shelf the
  // shop files it under.
  const artRe = /^##\s+\[([\s\S]*?)\]\((https:\/\/www\.magzter\.com\/stories\/[^)]+)\)\s*$/gm;
  let a;
  while ((a = artRe.exec(text))) {
    const raw = a[1].replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const mins = /(\d+)\s*mins?\s*$/.exec(raw);
    const body = mins ? raw.slice(0, mins.index).trim() : raw;
    if (!body) continue;
    // The headline runs in caps and the standfirst follows in sentence case, so
    // the first drop out of caps is the boundary. Where there is no caps run at
    // all the whole string is treated as the headline.
    const capRun = /^([A-Z0-9][A-Z0-9 '’&.,:!?()\-–—/]{3,}?)(?=\s+[A-Z][a-z])/.exec(body);
    obs.toc.push({
      title: capRun ? capRun[1].trim() : body.slice(0, 120).trim(),
      blurb: capRun ? body.slice(capRun[1].length).trim() : '',
      mins: mins ? +mins[1] : null,
      url: a[2],
    });
  }

  // Recent issues. Two jobs: confirming that the heading's issue really is the
  // newest one rather than a stale page, and giving the observed gap between
  // issues so the declared frequency can be checked instead of believed.
  const recentAt = lines.findIndex(l => /^##\s+Recent issues\s*$/i.test(l));
  if (recentAt >= 0) {
    for (let i = recentAt + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^##\s/.test(t)) break;
      const m = /^\*\s+\[!\[Image \d+:\s*([^\]]*)\]\((https:\/\/files\.magzter\.com[^)]+)\)\]\((https:\/\/www\.magzter\.com[^)]+)\)/.exec(t);
      if (!m) continue;
      const label = (lines[i + 1] || '').trim() || m[1].trim();
      if (!label) continue;
      obs.recentIssues.push({ label, cover: m[2], url: m[3] });
      if (obs.recentIssues.length >= 14) break;
    }
  }

  obs.coverUrl = pickMagzterCover(text, obs);
  obs.offers = parseMagzterOffers(text, obs);

  // A stale sitemap entry whose page has since been retired redirects to the
  // Magzter front page, which parses as a perfectly valid page about nothing.
  // Detected by the absence of the two things every real title page has.
  if (!obs.title || (!obs.issueLabel && !obs.toc.length && !obs.recentIssues.length)) {
    obs.availability = 'gone';
    // Whatever image was found came off the front page this URL redirected to,
    // so it belongs to some other magazine entirely. A cover from the wrong
    // title is the most convincing lie this app could tell.
    obs.coverUrl = null;
    obs.issueLabel = null;
    obs.problems.push('no title page found at this URL — the listing looks retired');
  } else {
    obs.availability = 'available';
  }
  if (obs.storeRegion && obs.storeRegion !== 'IN' && obs.offers.length) {
    obs.problems.push('prices were read from the ' + obs.storeRegion +
      ' store, not the India store — treat them as indicative');
  }
  return obs;
}

// The current issue's cover is the one bare image on the page: the header
// carousel images are all wrapped in links to other magazines, and the recent
// issue thumbnails are wrapped in links to their own issues. The page serves it
// as an interior preview, /view/N.jpg; /thumb/1.jpg in the same issue folder is
// the front cover.
function pickMagzterCover(text, obs) {
  const bare = /(^|[^(\[])!\[Image \d+:[^\]]*\]\((https:\/\/files\.magzter\.com\/resize\/magazine\/[^)]+)\)/m.exec(text);
  if (bare) return bare[2].replace(/\/view\/\d+\.jpg/i, '/thumb/1.jpg');
  // Fall back to the newest recent-issue thumbnail, but only when its label is
  // the issue we believe is current. A cover from the wrong month is worse than
  // no cover: it is a confident-looking lie about what is on the shelf.
  const first = obs.recentIssues[0];
  if (first && obs.issueLabel && first.label.toLowerCase() === obs.issueLabel.toLowerCase()) return first.cover;
  return null;
}

// The purchase block lists offers in a fixed order — single issue, then short
// subscription, then long — with the price headings following in the same
// order. Pairing them positionally is exact when the page is well-formed, and
// where it is not (the page emits "$NaN" often enough to matter) the offers
// whose price failed to parse are dropped rather than guessed at.
function parseMagzterOffers(text, obs) {
  const start = text.search(/Subscribe only to/i);
  if (start < 0) return [];
  const rest = text.slice(start);
  const endRel = rest.search(/Please choose your subscription plan|Cancel Anytime/i);
  const block = rest.slice(0, endRel > 0 ? endRel : 2600);

  const labels = [];
  const lre = /^(?:Buy this issue:\s*(.+)|(\d+)\s+issues?\s+starting from\s+(.+))$/gim;
  let lm;
  while ((lm = lre.exec(block))) {
    labels.push(lm[2]
      ? { kind: +lm[2] > 6 ? 'annual' : 'short-sub', issues: +lm[2], from: (lm[3] || '').trim() }
      : { kind: 'single', issues: 1, from: (lm[1] || '').trim() });
  }

  const prices = [];
  const pre = /^###\s*([₹$£€])\s*([\d,]+(?:\.\d+)?)\s*$/gim;
  let pm;
  while ((pm = pre.exec(block))) {
    prices.push({
      currency: { '₹': 'INR', '$': 'USD', '£': 'GBP', '€': 'EUR' }[pm[1]],
      amount: parseFloat(pm[2].replace(/,/g, '')),
    });
  }

  const offers = [];
  for (let i = 0; i < labels.length && i < prices.length; i++) {
    if (!Number.isFinite(prices[i].amount)) continue;
    offers.push(Object.assign({}, labels[i], prices[i], {
      seller: 'Magzter', format: 'digital', url: obs.url,
    }));
  }
  // Nothing paired: fall back to the cheapest figure in the block, which for a
  // magazine page is always the single issue, and say that it was inferred.
  if (!offers.length && prices.length) {
    const cheap = prices.filter(p => Number.isFinite(p.amount)).sort((a, b) => a.amount - b.amount)[0];
    if (cheap) {
      offers.push(Object.assign({}, cheap, {
        kind: 'single', issues: 1, seller: 'Magzter',
        format: 'digital', url: obs.url, inferred: true,
      }));
      obs.problems.push('single-issue price inferred as the cheapest offer on the page');
    }
  }
  return offers;
}

/* ------------------------------------------------------------- web search */
/* Open-ended discovery, and the app's only route to anything the retailer
   sitemaps do not list — print-only titles, newsagent listings, and magazines
   launched since a sitemap was last regenerated.

   DuckDuckGo's HTML endpoint is used because it needs no key and no account.
   Its result links are wrapped in a redirector, so the real target has to be
   unwrapped out of the uddg parameter before anything can be done with it. */

const WEBSEARCH = {
  id: 'websearch',
  label: 'Web search',

  async search(query, opts = {}) {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const page = await fetchPage(url, { ttl: opts.ttl ?? TTL.search });
    if (!page.text) return { results: [], error: page.error, query };

    const results = [];
    const seen = new Set();
    const re = /uddg=([^&")\s]+)/g;
    let m;
    while ((m = re.exec(page.text))) {
      let target;
      try { target = decodeURIComponent(m[1]); } catch { continue; }
      // The ad slots redirect through duckduckgo.com/y.js and bing aclick; they
      // are not results and following them would fill discovery with affiliate
      // storefronts for magazines that do not ship to India.
      if (/duckduckgo\.com\/y\.js|bing\.com\/aclick|\/l\/\?uddg/.test(target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      results.push({ url: target, host: hostOf(target) });
      if (results.length >= 40) break;
    }
    logResearch({ kind: 'search', url, query, count: results.length, ok: !!results.length });
    return { results, at: page.at, query, url };
  },

  // Turns a search result on a known retailer into something the rest of the
  // pipeline can pick up. A hit on a host with no connector is still recorded —
  // it is evidence the title exists and is being sold — but it cannot be read
  // for an issue, so it becomes a corroborating source rather than a candidate.
  classify(url) {
    const h = hostOf(url);
    if (h === 'www.magzter.com' && /\/IN\/[^/]+\/[^/]+\/[^/]+\/?$/.test(new URL(url).pathname)) {
      return { connector: 'magzter', role: 'primary' };
    }
    if (h === 'www.readwhere.com') return { connector: 'readwhere', role: 'primary' };
    if (/amazon\.in$/.test(h) || h === 'www.amazon.in') return { connector: null, role: 'retail', seller: 'Amazon.in' };
    if (/flipkart\.com$/.test(h)) return { connector: null, role: 'retail', seller: 'Flipkart' };
    return { connector: null, role: 'mention' };
  },
};

/* -------------------------------------------------------------- readwhere */
/* India's other digital newsstand, and the one that carries the regional-language
   titles Magzter is thinnest on. Its magazine pages are client-rendered, so a
   text proxy sees only boilerplate — which means it can contribute TITLES and
   LANGUAGES from its sitemap but cannot be asked what this month's issue is.
   That asymmetry is the point of separating discovery from issue identification:
   a source is allowed to be good at one and useless at the other. */

const READWHERE = {
  id: 'readwhere',
  label: 'Readwhere',
  sitemap: 'https://www.readwhere.com/sitemap/titles/magazine/sitemap.xml',

  async universe(ctx) {
    const page = await fetchPage(this.sitemap, { ttl: TTL.universe, timeout: 60000 });
    if (!page.text) return { stubs: [], error: page.error || 'sitemap unreachable', at: page.at };
    const seen = new Set();
    const stubs = [];
    const re = /https?:\/\/(?:www\.)?readwhere\.com\/magazine\/([a-z0-9-]+)\/(\d+)/gi;
    let m;
    while ((m = re.exec(page.text))) {
      const url = 'https://www.readwhere.com/magazine/' + m[1] + '/' + m[2];
      if (seen.has(url)) continue;
      seen.add(url);
      stubs.push({
        sourceId: 'readwhere', url, title: unslug(m[1]),
        publisher: null, category: null, region: 'IN',
        formats: ['digital'], titleOnly: true,
      });
    }
    if (ctx && ctx.note) ctx.note('Readwhere sitemap: ' + stubs.length + ' magazine titles');
    return { stubs, at: page.at, cached: page.cached };
  },

  async detail(stub) {
    const obs = blankObservation(this, stub.url);
    obs.fetchedAt = Date.now();
    obs.title = stub.title;
    obs.formats = ['digital'];
    obs.availability = 'unknown';
    obs.problems.push('Readwhere renders issue data in the browser, so no issue could be read from the page');
    return obs;
  },
};

/* -------------------------------------------------------- publisher pages */
/* The primary source, where one exists and will answer. A publisher's own
   current-issue page beats any retailer for freshness and is the only place a
   print cover price is usually printed. There is no shared markup across
   publishers, so this connector is deliberately generic: it reads whatever the
   page says about an issue and reports low confidence when it says little. */

const PUBLISHER = {
  id: 'publisher',
  label: 'Publisher site',

  async detail(stub) {
    const page = await fetchPage(stub.url, { ttl: TTL.detailHot });
    const obs = blankObservation(this, stub.url);
    obs.fetchedAt = page.at;
    obs.via = page.via;
    obs.inRegion = page.inRegion;
    obs.title = stub.title;
    if (!page.text) {
      obs.problems.push('publisher page unreachable: ' + (page.error || 'no response'));
      return obs;
    }
    const text = page.text;

    // The current issue is whatever dated label appears nearest the words that
    // publishers actually use for it. Scanning the whole page instead would
    // reliably pick up an archive list and call a 2019 issue current.
    const anchor = /(current issue|latest issue|this month|in this issue|on sale now)/i.exec(text);
    const window = anchor ? text.slice(Math.max(0, anchor.index - 300), anchor.index + 900) : text.slice(0, 1600);
    const label = findIssueLabel(window);
    if (label) obs.issueLabel = label;

    const inr = /₹\s?([\d,]+(?:\.\d{2})?)/.exec(window) || /\bRs\.?\s?([\d,]+)/i.exec(window);
    if (inr) {
      obs.offers.push({
        kind: 'single', issues: 1, amount: parseFloat(inr[1].replace(/,/g, '')),
        currency: 'INR', seller: stub.publisher || hostOf(stub.url),
        format: 'print', url: stub.url,
      });
      obs.formats.push('print');
    }
    if (/\bprint\b|\bsubscribe\b|\bnewsstand\b/i.test(text)) obs.formats.push('print');
    obs.availability = obs.issueLabel ? 'available' : 'unknown';
    if (!obs.issueLabel) obs.problems.push('no issue label found on the publisher page');
    obs.formats = uniq(obs.formats);
    return obs;
  },
};

const CONNECTORS = { magzter: MAGZTER, readwhere: READWHERE, publisher: PUBLISHER, websearch: WEBSEARCH };

/* ============================================================ normalising */
/* Observations arrive as prose. This section turns prose into the handful of
   comparable facts the rest of the app reasons about — and, crucially, records
   how sure it is about each of them, because "September 2026" and "Issue 47"
   are not equally informative about whether something is this month's issue. */

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const SEASONS = { winter: 0, spring: 3, summer: 6, autumn: 9, fall: 9, monsoon: 6 };

// Turns an issue label into a point in time and says how precise that point is.
// Precision matters more than the date: a magazine labelled "Issue 47" cannot be
// checked for freshness at all, and the confidence model has to know that
// rather than silently treating an unparsed label as old.
function parseIssueLabel(label) {
  const s = String(label || '').trim();
  if (!s) return { precision: 'none' };
  // Ordinal suffixes are common on Indian mastheads ("August 2nd 2026"). Left
  // in, they fall through to the numbered branch, where the issue loses its
  // date and with it every freshness check.
  const low = s.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');

  // "September 14, 2026" / "14 September 2026" / "Sep 14 2026"
  let m = new RegExp('^' + MONTH_RE + '\\s+(\\d{1,2}),?\\s+(\\d{4})$', 'i').exec(low)
       || new RegExp('^(\\d{1,2})\\s+' + MONTH_RE + ',?\\s+(\\d{4})$', 'i').exec(low);
  if (m) {
    const mon = MONTH_INDEX[(m[1].length > 2 && isNaN(+m[1]) ? m[1] : m[2]).slice(0, 3)];
    const day = +(isNaN(+m[1]) ? m[2] : m[1]);
    const yr = +m[3];
    return { precision: 'day', date: Date.UTC(yr, mon, day), month: yr * 12 + mon, text: s };
  }

  // A span: "August 25 - September 07, 2026", "Jul-Sep 2026". The END of the
  // span is what matters for freshness — a fortnightly dated to the 7th is
  // current until the 7th, not from it.
  m = new RegExp('^' + MONTH_RE + '\\s*(\\d{1,2})?\\s*[-–—/to]+\\s*' + MONTH_RE + '\\s*(\\d{1,2})?,?\\s*(\\d{4})$', 'i').exec(low);
  if (m) {
    const mon = MONTH_INDEX[m[3].slice(0, 3)];
    const yr = +m[5];
    return {
      precision: m[4] ? 'day' : 'month', span: true,
      date: Date.UTC(yr, mon, m[4] ? +m[4] : 28), month: yr * 12 + mon, text: s,
    };
  }

  // "September 2026" / "Sept 2026"
  m = new RegExp('^' + MONTH_RE + ',?\\s+(\\d{4})$', 'i').exec(low);
  if (m) {
    const mon = MONTH_INDEX[m[1].slice(0, 3)];
    const yr = +m[2];
    return { precision: 'month', date: Date.UTC(yr, mon, 15), month: yr * 12 + mon, text: s };
  }

  // "Winter 2026", "Monsoon 2026" — quarterlies and seasonal specials.
  m = /^(winter|spring|summer|autumn|fall|monsoon)\s+(\d{4})$/i.exec(low);
  if (m) {
    const mon = SEASONS[m[1].toLowerCase()];
    const yr = +m[2];
    return { precision: 'quarter', date: Date.UTC(yr, mon + 1, 15), month: yr * 12 + mon, text: s };
  }

  // A bare year, or a volume/issue number with no date in it at all.
  m = /(?:issue|no\.?|number|vol(?:ume)?)\s*[.#]?\s*(\d{1,4})/i.exec(low);
  const yr = /\b(19|20)\d{2}\b/.exec(low);
  if (yr) {
    const y = +yr[0];
    return { precision: 'year', date: Date.UTC(y, 6, 1), month: y * 12 + 6, num: m ? +m[1] : null, text: s };
  }
  if (m) return { precision: 'number', num: +m[1], text: s };
  return { precision: 'none', text: s };
}

// Scans a block of prose for the most plausible issue label. Publishers write
// them in a dozen shapes and rarely label them; the ordering here is by how
// unambiguous each shape is, so a full date always beats a bare month.
function findIssueLabel(text) {
  const pats = [
    new RegExp(MONTH_RE + '\\s+\\d{1,2},?\\s+20\\d{2}', 'i'),
    new RegExp('\\d{1,2}\\s+' + MONTH_RE + ',?\\s+20\\d{2}', 'i'),
    new RegExp(MONTH_RE + '\\s*[-–—]\\s*' + MONTH_RE + '\\s+20\\d{2}', 'i'),
    new RegExp(MONTH_RE + '\\s+20\\d{2}', 'i'),
    /(winter|spring|summer|autumn|fall|monsoon)\s+20\d{2}/i,
  ];
  for (const p of pats) {
    const m = p.exec(text);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

// Declared cadence, normalised. The string is what the retailer says; the code
// below checks it against the gaps actually observed between recent issues,
// which is how a "Monthly" that has not published since March gets caught.
const FREQ_DAYS = {
  daily: 1, weekly: 7, fortnightly: 14, biweekly: 14, 'bi-weekly': 14,
  'semi-monthly': 15, monthly: 30, 'bi-monthly': 61, bimonthly: 61,
  quarterly: 91, 'half yearly': 182, 'half-yearly': 182, biannual: 182,
  'semi-annual': 182, annual: 365, yearly: 365, 'one time': 0, irregular: 0,
};

function freqDays(label) {
  if (!label) return null;
  const k = String(label).toLowerCase().trim();
  if (FREQ_DAYS[k] != null) return FREQ_DAYS[k] || null;
  for (const [name, days] of Object.entries(FREQ_DAYS)) {
    if (k.includes(name)) return days || null;
  }
  const n = /(\d+)\s*(issues?|times?)\s*(?:a|per)\s*year/i.exec(k);
  if (n && +n[1] > 0) return Math.round(365 / +n[1]);
  return null;
}

function freqLabelFromDays(d) {
  if (d == null) return null;
  const table = [[2, 'Daily'], [9, 'Weekly'], [18, 'Fortnightly'], [45, 'Monthly'],
                 [80, 'Bi-monthly'], [130, 'Quarterly'], [250, 'Half-yearly'], [1e9, 'Annual']];
  for (const [lim, name] of table) if (d <= lim) return name;
  return null;
}

// Observed cadence from the recent-issue list. Two or more parsed dates give a
// median gap, which is a fact about the magazine rather than a claim on its
// listing page — so where the two disagree, this one wins and the disagreement
// is recorded as a conflict.
function observedCadence(recentIssues) {
  const dates = recentIssues
    .map(r => parseIssueLabel(r.label))
    .filter(p => p.date && (p.precision === 'day' || p.precision === 'month'))
    .map(p => p.date)
    .sort((a, b) => b - a);
  if (dates.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push((dates[i - 1] - dates[i]) / 864e5);
  const med = median(gaps.filter(g => g > 0.5 && g < 500));
  return med ? { days: Math.round(med), samples: gaps.length, newest: dates[0] } : null;
}

// Titles are compared after this, never before. "Autocar India Magazine" and
// "Autocar-India" are the same shelf; "BBC Top Gear" and "Top Gear India" are
// not, and the normaliser must not be so aggressive that it merges them.
function canonTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(magazine|the|digital|edition|india\s+edition)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Language, normalised out of whatever the source called it, plus a fallback
// that reads the script of the title itself. A Devanagari or Tamil title is a
// Hindi or Tamil magazine regardless of what the listing says, and the language
// filter is a hard constraint, so getting it wrong hides things wrongly.
const SCRIPT_RANGES = [
  [/[ऀ-ॿ]/, 'Hindi'], [/[ঀ-৿]/, 'Bengali'],
  [/[਀-੿]/, 'Punjabi'], [/[઀-૿]/, 'Gujarati'],
  [/[଀-୿]/, 'Odia'], [/[஀-௿]/, 'Tamil'],
  [/[ఀ-౿]/, 'Telugu'], [/[ಀ-೿]/, 'Kannada'],
  [/[ഀ-ൿ]/, 'Malayalam'], [/[؀-ۿ]/, 'Urdu'],
];

function normLanguage(declared, title) {
  if (declared) {
    const d = String(declared).trim();
    if (d && !/^n\/?a$/i.test(d)) return d.charAt(0).toUpperCase() + d.slice(1);
  }
  for (const [re, name] of SCRIPT_RANGES) if (re.test(String(title || ''))) return name;
  return null;
}

/* =============================================================== records  */
/* A magazine record is the merge of every observation ever taken about a title.
   Observations are kept whole, in order, forever — the merge is a view over
   them, not a replacement for them, so a later correction can be recomputed and
   the Research view can always show who said what and when.                   */

function normaliseRecord(m) {
  m.observations = m.observations || [];
  m.topics = m.topics || {};
  m.aliases = m.aliases || [];
  m.problems = m.problems || [];
  m.manual = m.manual || {};
  return m;
}

// The identity key. A source that offers its own stable id (Magzter's title id)
// is trusted for it; otherwise identity falls back to the canonical title, and
// the fuzzy pass below catches what that misses.
function recordIdFor(obs, stub) {
  if (obs && obs.sourceKey) return obs.sourceKey;
  const t = canonTitle((obs && obs.title) || (stub && stub.title));
  return t ? 't:' + hash(t) : 'u:' + hash((stub && stub.url) || (obs && obs.url) || String(Math.random()));
}

function upsertObservation(obs, stub) {
  const id = recordIdFor(obs, stub);
  let rec = state.magazines.get(id);
  if (!rec) {
    rec = normaliseRecord({
      id,
      title: obs.title || (stub && stub.title) || 'Untitled',
      createdAt: Date.now(),
      observations: [],
      mergedFrom: [],
    });
    state.magazines.set(id, rec);
    bump('discovered');
  }
  // One observation per source URL: a re-read replaces the previous reading
  // rather than piling up, because the question "what does this page say now"
  // has one answer. History of what it used to say lives in the event log and
  // in the issue timeline, which is where it belongs.
  const at = rec.observations.findIndex(o => o.url === obs.url && o.sourceId === obs.sourceId);
  if (at >= 0) rec.observations[at] = obs; else rec.observations.push(obs);
  rebuildRecord(rec);
  return rec;
}

// Collapses the observations into the merged view. Every derived field records
// which observation it came from so the Research view can attribute it, and any
// field two sources disagree on lands in `conflicts`, which feeds straight into
// the confidence score.
function rebuildRecord(rec) {
  const obs = rec.observations.slice().sort((a, b) => b.fetchedAt - a.fetchedAt);
  const live = obs.filter(o => o.availability !== 'gone');
  const pick = (field, pref) => {
    const src = (pref ? obs.filter(pref) : obs).find(o => o[field] != null && o[field] !== '');
    return src ? { value: src[field], from: src } : null;
  };

  const conflicts = [];
  const disagree = field => {
    const vals = uniq(obs.map(o => o[field]).filter(v => v != null && v !== '')
      .map(v => String(v).toLowerCase().trim()));
    if (vals.length > 1) conflicts.push({ field, values: vals });
  };

  const titleP = pick('title');
  rec.title = (rec.manual.title) || (titleP && titleP.value) || rec.title;
  rec.aliases = uniq(obs.map(o => o.title).filter(Boolean).concat(rec.aliases)).filter(t => t !== rec.title);

  const pubP = pick('publisher');
  rec.publisher = rec.manual.publisher || (pubP && pubP.value) || null;

  const catP = pick('category');
  rec.category = rec.manual.category || (catP && catP.value) || null;

  const langP = pick('language');
  rec.language = rec.manual.language || normLanguage(langP && langP.value, rec.title);

  rec.formats = uniq(obs.flatMap(o => o.formats || []));
  if (rec.manual.formats) rec.formats = rec.manual.formats;

  rec.sellers = uniq(obs.map(o => o.sourceLabel));
  rec.urls = uniq(obs.map(o => o.url));
  rec.lastChecked = obs.length ? obs[0].fetchedAt : 0;

  // Cadence: declared vs observed, with observed winning and the gap recorded.
  const freqP = pick('frequency');
  const declaredDays = freqDays(freqP && freqP.value);
  const cadenceSrc = obs.find(o => o.recentIssues && o.recentIssues.length >= 3);
  const observed = cadenceSrc ? observedCadence(cadenceSrc.recentIssues) : null;
  rec.frequency = {
    declared: (freqP && freqP.value) || null,
    declaredDays,
    observedDays: observed ? observed.days : null,
    samples: observed ? observed.samples : 0,
    days: rec.manual.frequencyDays || (observed ? observed.days : declaredDays),
  };
  rec.frequency.label = rec.manual.frequencyLabel
    || freqLabelFromDays(rec.frequency.days)
    || rec.frequency.declared || null;
  if (declaredDays && observed && Math.abs(declaredDays - observed.days) > Math.max(6, declaredDays * 0.5)) {
    conflicts.push({
      field: 'frequency',
      values: ['declared ' + freqLabelFromDays(declaredDays), 'observed ~' + observed.days + 'd'],
    });
  }

  disagree('issueLabel');
  rec.conflicts = conflicts;

  rec.issue = identifyCurrentIssue(rec, obs);
  rec.offers = mergeOffers(live);
  rec.price = choosePrice(rec.offers);
  rec.coverUrl = rec.manual.coverUrl || (pick('coverUrl', o => o.availability !== 'gone') || {}).value || null;

  const availStates = uniq(live.map(o => o.availability));
  rec.availability =
    rec.manual.availability
    || (live.length === 0 ? 'gone'
      : availStates.includes('available') ? 'available' : 'unknown');

  rec.problems = uniq(obs.flatMap(o => o.problems || []));
  rec.content = analyseContent(rec, obs);
  rec.kind = rec.manual.kind || inferKind(rec);
  rec.topics = rec.manual.topics || rec.content.topics;
  rec.topicVec = normaliseVec(rec.topics);
  return rec;
}

/* ================================================= issue identification  */
/* "Do not mistake old issues still listed online for the current issue" is the
   hardest requirement in the brief, because every retailer page looks equally
   confident about a dead title and a live one. The answer is not to decide, but
   to score: what the page claims, how well that claim agrees with the
   magazine's own cadence, whether a second source says the same thing, and
   how long ago anyone looked.                                                 */

function identifyCurrentIssue(rec, obs) {
  const claims = obs
    .filter(o => o.issueLabel)
    .map(o => ({
      label: o.issueLabel,
      parsed: parseIssueLabel(o.issueLabel),
      source: o.sourceLabel,
      url: o.url,
      at: o.fetchedAt,
      inRegion: o.inRegion,
    }));

  if (!claims.length) {
    return {
      label: null, parsed: { precision: 'none' }, confidence: 0,
      band: 'unknown', reasons: ['no source stated an issue'], claims: [],
    };
  }

  // Where sources disagree the newest DATED claim wins, because an issue label
  // that parses to a real date and is more recent is the stronger evidence. A
  // source that only offers "Issue 47" cannot outrank one that says "September
  // 2026" however recently it was fetched.
  const rank = c => (c.parsed.date || 0) + (c.parsed.precision === 'day' ? 2e8 : 0);
  claims.sort((a, b) => rank(b) - rank(a));
  const best = claims[0];
  const agreeing = claims.filter(c => c.label.toLowerCase() === best.label.toLowerCase());

  const reasons = [];
  let conf = 0.5;

  if (best.parsed.precision === 'day') { conf += 0.15; reasons.push('issue carries a full cover date'); }
  else if (best.parsed.precision === 'month') { conf += 0.1; reasons.push('issue is dated to a month'); }
  else if (best.parsed.precision === 'number') { conf -= 0.2; reasons.push('issue is numbered, not dated — freshness cannot be checked'); }
  else if (best.parsed.precision === 'none') { conf -= 0.3; reasons.push('issue label could not be read as a date'); }

  // Does the date sit where this magazine's cadence says it should? An issue
  // more than two cadence periods old is either a dead title or a stale page,
  // and both deserve the same doubt.
  const days = rec.frequency && rec.frequency.days;
  if (best.parsed.date && days) {
    const ageDays = (Date.now() - best.parsed.date) / 864e5;
    if (ageDays < -45) { conf -= 0.25; reasons.push('cover date is in the future by more than six weeks'); }
    else if (ageDays <= days * 1.35) { conf += 0.2; reasons.push('cover date is within one publication cycle'); }
    else if (ageDays <= days * 2.5) { conf -= 0.05; reasons.push('cover date is a cycle or so behind'); }
    else {
      // Proportional, not flat. A flat penalty rated a 2013 fortnightly as
      // confidently as one issue late, because everything past the threshold
      // was treated identically.
      const cyclesLate = ageDays / days;
      conf -= Math.min(0.8, 0.18 + 0.3 * Math.log2(cyclesLate));
      reasons.push('cover date is ' + Math.round(ageDays) + ' days old — about ' +
        Math.round(cyclesLate) + ' issues behind a ~' + days + ' day schedule');
    }
  } else if (best.parsed.date) {
    const ageDays = (Date.now() - best.parsed.date) / 864e5;
    if (ageDays > 120) { conf -= 0.2; reasons.push('cover date is over four months old and there is no known cadence to judge it against'); }
  }

  // Is it the newest issue the source itself lists? A page that shows August as
  // current while listing a September issue below is showing a cached page.
  const withRecent = obs.find(o => o.recentIssues && o.recentIssues.length);
  if (withRecent && best.parsed.date) {
    const newerListed = withRecent.recentIssues
      .map(r => parseIssueLabel(r.label))
      .filter(p => p.date && p.date > best.parsed.date + 864e5);
    if (newerListed.length) {
      conf -= 0.35;
      reasons.push('the source lists a newer issue than the one it presents as current');
    } else {
      conf += 0.1;
      reasons.push('no newer issue appears in the source’s own back-issue list');
    }
  }

  if (agreeing.length > 1) {
    conf += 0.15;
    reasons.push(agreeing.length + ' independent sources give the same issue');
  } else if (claims.length > 1) {
    conf -= 0.15;
    reasons.push('sources disagree: ' + uniq(claims.map(c => c.label)).slice(0, 3).join(' vs '));
  } else {
    conf = Math.min(conf, 0.72);
    reasons.push('only one source has been read for this title');
  }

  // Staleness of the reading itself, which is separate from staleness of the
  // issue. A four-week-old read of a weekly tells you nothing about today.
  const age = Date.now() - best.at;
  if (days) {
    const readAgeCycles = age / 864e5 / days;
    if (readAgeCycles > 1) {
      conf -= Math.min(0.3, 0.12 * readAgeCycles);
      reasons.push('this reading is ' + Math.round(age / 864e5) + ' days old, over a full cycle');
    }
  } else if (age > 30 * 864e5) {
    conf -= 0.12;
    reasons.push('this reading is over a month old');
  }

  conf = clamp(conf);
  const band = conf >= 0.75 ? 'verified' : conf >= 0.5 ? 'likely' : conf >= 0.28 ? 'uncertain' : 'unknown';
  return {
    label: best.label, parsed: best.parsed, url: best.url, source: best.source,
    checkedAt: best.at, confidence: conf, band, reasons, claims,
    key: rec.id + '|' + (best.parsed.date || best.label),
  };
}

/* ------------------------------------------------------------------ price */

// Offers from every source, deduplicated on seller + kind + amount. Nothing is
// converted or averaged here: two sellers really can charge different prices and
// the app's job is to show which is which, not to invent a market rate.
function mergeOffers(obs) {
  const out = [];
  const seen = new Set();
  for (const o of obs) {
    for (const off of o.offers || []) {
      const k = [off.seller, off.kind, off.currency, off.amount].join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...off, at: o.fetchedAt, inRegion: o.inRegion, storeRegion: o.storeRegion, sourceUrl: o.url });
    }
  }
  return out.sort((a, b) => (a.kind === 'single' ? -1 : 1) - (b.kind === 'single' ? -1 : 1));
}

// The number the card shows. A single-issue price read in-region is the truth;
// everything after that is a fallback with its own honest label, and the last
// fallback is "only a subscription price exists", which is a real situation the
// brief asks to be handled rather than hidden.
function choosePrice(offers) {
  if (!offers.length) return { amount: null, basis: 'none', note: 'no price found on any source read so far' };

  const singles = offers.filter(o => o.kind === 'single');
  const inr = singles.find(o => o.currency === 'INR');
  if (inr) return { ...inr, basis: 'single-issue', confidence: 0.95, note: null };

  const inRegion = singles.find(o => o.inRegion || o.storeRegion === 'IN');
  if (inRegion) return { ...inRegion, basis: 'single-issue', confidence: 0.85, note: null };

  if (singles.length) {
    const s = singles[0];
    return {
      ...s, basis: 'single-issue', confidence: 0.5,
      note: 'read from the ' + (s.storeRegion || 'international') +
            ' store — the India price will differ',
    };
  }

  // Subscription-only. Per-issue is derived and clearly marked as derived: it is
  // not a price anyone will sell you a single copy for.
  const sub = offers.slice().sort((a, b) =>
    (a.amount / Math.max(1, a.issues)) - (b.amount / Math.max(1, b.issues)))[0];
  return {
    ...sub, amount: sub.amount / Math.max(1, sub.issues),
    basis: 'per-issue-from-subscription', confidence: 0.35,
    note: 'no single-issue price was found — this is ' + fmtPrice(sub) +
          ' for ' + sub.issues + ' issues, divided out',
  };
}

/* ============================================================== duplicates */
/* Two questions that look alike and are not: is this the same magazine sold by
   two shops, and are these two different magazines that cover the same ground?
   This section answers only the first. The second is an overlap problem and is
   handled at ranking time, because two good car magazines are not a data error
   — they are a diversity decision.                                            */

function duplicateCandidates() {
  const recs = Array.from(state.magazines.values());
  const byTitle = new Map();
  for (const r of recs) {
    const k = canonTitle(r.title);
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(r);
  }

  const pairs = [];
  const pushPair = (a, b, score, why) => {
    if (a.id === b.id) return;
    const verdict = manualVerdict(a.id, b.id);
    pairs.push({ a, b, score, why, verdict });
  };

  // Exact canonical-title collision. The common real case is the same magazine
  // listed by two sellers under slightly different names.
  for (const group of byTitle.values()) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++)
        pushPair(group[i], group[j], 1, 'identical normalised title');
  }

  // Near-title matches: same publisher and a title that is a prefix or one-token
  // extension of the other. Deliberately conservative — "Top Gear" and "Top Gear
  // India" are different products and must not be merged automatically.
  const keys = Array.from(byTitle.keys());
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      if (a === b) continue;
      const shorter = a.length < b.length ? a : b;
      const longer = a.length < b.length ? b : a;
      if (!longer.startsWith(shorter + ' ')) continue;
      const extra = longer.slice(shorter.length + 1);
      if (extra.includes(' ')) continue;
      for (const ra of byTitle.get(a)) for (const rb of byTitle.get(b)) {
        const samePub = ra.publisher && rb.publisher
          && canonTitle(ra.publisher) === canonTitle(rb.publisher);
        pushPair(ra, rb, samePub ? 0.8 : 0.45,
          'one title extends the other by "' + extra + '"' + (samePub ? ', same publisher' : ''));
      }
    }
  }
  return pairs.filter(p => p.verdict !== 'distinct')
    .sort((x, y) => y.score - x.score);
}

function manualVerdict(a, b) {
  const key = [a, b].sort().join('~');
  const m = state.merges.find(x => x.key === key);
  return m ? m.verdict : null;
}

function setMergeVerdict(a, b, verdict) {
  const key = [a, b].sort().join('~');
  const at = state.merges.findIndex(x => x.key === key);
  if (at >= 0) state.merges[at].verdict = verdict;
  else state.merges.push({ key, a, b, verdict, at: Date.now() });
  if (verdict === 'same') mergeRecords(a, b);
  scheduleSave();
}

// Merging keeps the record with more observations and folds the other's
// observations into it, so nothing that was ever read is lost. The absorbed id
// is remembered in `mergedFrom` because history events reference it.
function mergeRecords(idA, idB) {
  const a = state.magazines.get(idA);
  const b = state.magazines.get(idB);
  if (!a || !b) return;
  const keep = a.observations.length >= b.observations.length ? a : b;
  const drop = keep === a ? b : a;
  keep.observations = keep.observations.concat(drop.observations);
  keep.mergedFrom = uniq((keep.mergedFrom || []).concat(drop.mergedFrom || [], [drop.id]));
  keep.aliases = uniq((keep.aliases || []).concat(drop.aliases || [], [drop.title]));
  keep.manual = Object.assign({}, drop.manual, keep.manual);
  state.magazines.delete(drop.id);
  rebuildRecord(keep);
  bump('merged');
}

// History and preference events reference a record id that may since have been
// absorbed. Resolving through mergedFrom keeps a purchase attached to the title
// after a merge instead of silently detaching it.
function resolveRecord(id) {
  if (state.magazines.has(id)) return state.magazines.get(id);
  for (const r of state.magazines.values()) {
    if ((r.mergedFrom || []).includes(id)) return r;
  }
  return null;
}

/* ==================================================== content understanding */
/* What is actually IN this issue, as opposed to which shelf the shop files the
   magazine on. The distinction is the whole reason this section exists: the
   category says "Automotive" every month, while the cover lines say this month
   it is electric SUVs and a 19,000km road trip, and only the second can tell
   you whether this month is the month to buy it.

   IMPORTANT — this vocabulary describes MAGAZINES, never the user. Nothing here
   is a preference, an assumed interest or a starting profile. The user's taste
   model begins completely empty and is built only from recorded interactions;
   these subjects exist so that when the user does react to something, there is
   a name for what they reacted to.

   Two passes. The ontology names the subjects that recur across a newsstand and
   need to be recognised the same way every time. The mined pass then picks up
   whatever the ontology has no word for — this month's actual preoccupations —
   so the tag set grows with the corpus instead of being capped by this list. */

const SUBJECTS = [
  ['cars',            ['car', 'cars', 'suv', 'sedan', 'hatchback', 'automotive', 'autocar', 'road test', 'test drive', 'horsepower', 'engine', 'ev', 'electric vehicle', 'motoring', 'automobile', 'showroom', 'mileage', 'drivetrain']],
  ['motorcycles',     ['motorcycle', 'bike', 'superbike', 'scooter', 'two wheeler', 'rider', 'motogp', 'ducati', 'royal enfield', 'kawasaki']],
  ['motorsport',      ['formula 1', 'formula one', 'f1', 'rally', 'grand prix', 'motorsport', 'racing', 'circuit', 'lap time']],
  ['science',         ['science', 'scientist', 'physics', 'chemistry', 'biology', 'research', 'experiment', 'quantum', 'genome', 'evolution', 'laboratory', 'discovery', 'neuroscience', 'cosmology', 'particle']],
  ['space',           ['space', 'astronomy', 'nasa', 'isro', 'satellite', 'planet', 'galaxy', 'telescope', 'rocket', 'mars', 'lunar', 'orbit', 'cosmos', 'astronaut']],
  ['technology',      ['technology', 'tech', 'software', 'app', 'digital', 'internet', 'startup', 'silicon', 'cyber', 'data', 'cloud', 'algorithm', 'chip', 'semiconductor', 'robotics']],
  ['ai',              ['artificial intelligence', 'machine learning', ' ai ', 'chatgpt', 'llm', 'neural network', 'generative ai', 'deep learning']],
  ['gadgets',         ['gadget', 'smartphone', 'laptop', 'review', 'headphone', 'wearable', 'tablet', 'camera phone', 'buying guide', 'best phones']],
  ['electronics',     ['electronics', 'circuit', 'arduino', 'raspberry pi', 'microcontroller', 'soldering', 'diy electronics', 'hobby electronics', 'pcb', 'embedded']],
  ['gaming',          ['gaming', 'video game', 'playstation', 'xbox', 'nintendo', 'esports', 'gamer', 'console']],
  ['travel',          ['travel', 'destination', 'itinerary', 'journey', 'trek', 'backpack', 'holiday', 'tourism', 'getaway', 'road trip', 'hotel', 'resort', 'wanderlust', 'expedition']],
  ['nature',          ['wildlife', 'nature', 'forest', 'tiger', 'elephant', 'bird', 'conservation', 'habitat', 'species', 'jungle', 'national park', 'sanctuary', 'biodiversity', 'safari']],
  ['environment',     ['climate', 'environment', 'pollution', 'sustainability', 'carbon', 'renewable', 'ecology', 'global warming', 'green energy', 'waste']],
  ['history',         ['history', 'historical', 'ancient', 'archaeology', 'heritage', 'dynasty', 'empire', 'century', 'medieval', 'civilisation', 'civilization', 'partition', 'freedom struggle']],
  ['mythology',       ['mythology', 'mythological', 'ramayana', 'mahabharata', 'folklore', 'legend', 'epic tale', 'puranas']],
  ['photography',     ['photography', 'photographer', 'camera', 'lens', 'exposure', 'portrait', 'photo essay', 'shutter', 'aperture', 'darkroom', 'photo feature']],
  ['art',             ['art', 'artist', 'painting', 'gallery', 'sculpture', 'exhibition', 'canvas', 'illustration', 'biennale']],
  ['design',          ['design', 'designer', 'typography', 'graphic', 'aesthetic', 'minimalist', 'craft', 'product design']],
  ['architecture',    ['architecture', 'architect', 'building', 'facade', 'urban design', 'structure', 'built form', 'skyline']],
  ['homes',           ['home', 'interior', 'decor', 'furniture', 'kitchen', 'living room', 'renovation', 'apartment', 'villa', 'homes', 'furnishing', 'makeover']],
  ['gardening',       ['garden', 'gardening', 'plant', 'terrace garden', 'horticulture', 'bonsai', 'nursery', 'balcony garden']],
  ['food',            ['food', 'recipe', 'cooking', 'chef', 'cuisine', 'restaurant', 'baking', 'dish', 'kitchen table', 'gourmet', 'street food', 'flavour']],
  ['drink',           ['wine', 'whisky', 'cocktail', 'brewing', 'coffee', 'tea', 'spirits', 'bar', 'distillery']],
  ['health',          ['health', 'wellness', 'medicine', 'doctor', 'disease', 'therapy', 'mental health', 'nutrition', 'diet', 'immunity', 'clinical', 'patient', 'hospital']],
  ['fitness',         ['fitness', 'workout', 'gym', 'exercise', 'yoga', 'running', 'strength', 'muscle', 'training plan', 'marathon']],
  ['parenting',       ['parenting', 'child development', 'toddler', 'motherhood', 'newborn', 'schooling', 'raising children', 'baby']],
  ['business',        ['business', 'company', 'ceo', 'revenue', 'profit', 'industry', 'corporate', 'enterprise', 'entrepreneur', 'boardroom', 'merger', 'valuation', 'ipo', 'unicorn']],
  ['economy',         ['economy', 'gdp', 'inflation', 'fiscal', 'rbi', 'monetary', 'trade deficit', 'budget', 'recession', 'economic growth']],
  ['finance',         ['finance', 'investment', 'stock', 'mutual fund', 'portfolio', 'equity', 'market', 'sensex', 'nifty', 'wealth', 'tax', 'insurance', 'savings']],
  ['management',      ['management', 'leadership', 'strategy', 'workplace', 'productivity', 'hiring', 'organisation', 'culture']],
  ['politics',        ['politics', 'political', 'government', 'election', 'parliament', 'minister', 'party', 'policy', 'bjp', 'congress', 'assembly', 'governance', 'opposition']],
  ['world-affairs',   ['geopolitics', 'diplomacy', 'foreign policy', 'united nations', 'bilateral', 'war', 'conflict', 'treaty', 'sanctions', 'nato', 'brics']],
  ['defence',         ['defence', 'defense', 'army', 'navy', 'air force', 'missile', 'military', 'strategic forces', 'border', 'security forces']],
  ['law',             ['law', 'court', 'supreme court', 'judgment', 'legal', 'constitution', 'judiciary', 'litigation']],
  ['society',         ['society', 'social', 'caste', 'gender', 'inequality', 'community', 'activism', 'migration', 'urban poor', 'rural']],
  ['education',       ['education', 'school', 'student', 'exam', 'university', 'college', 'curriculum', 'teaching', 'entrance test', 'syllabus']],
  ['careers',         ['career', 'job', 'recruitment', 'interview tips', 'upsc', 'competitive exam', 'placement', 'skills']],
  ['sport',           ['cricket', 'football', 'tennis', 'hockey', 'badminton', 'olympics', 'athlete', 'tournament', 'match', 'ipl', 'world cup', 'sport', 'sports']],
  ['film',            ['film', 'movie', 'cinema', 'director', 'actor', 'box office', 'bollywood', 'screenplay', 'ott', 'streaming series', 'web series']],
  ['music',           ['music', 'album', 'song', 'band', 'concert', 'singer', 'raga', 'classical music', 'playlist', 'composer']],
  ['books',           ['book', 'novel', 'author', 'literature', 'poetry', 'publishing', 'literary', 'fiction', 'memoir', 'shortlist']],
  ['comics',          ['comic', 'comics', 'cartoon', 'graphic novel', 'strip', 'panel', 'superhero', 'manga', 'tinkle', 'chacha chaudhary']],
  ['humour',          ['humour', 'humor', 'satire', 'funny', 'joke', 'parody', 'wit', 'laughter', 'comic relief']],
  ['puzzles',         ['puzzle', 'crossword', 'sudoku', 'quiz', 'riddle', 'brain teaser', 'word game']],
  ['fashion',         ['fashion', 'style', 'couture', 'runway', 'wardrobe', 'designer wear', 'trend report', 'streetwear', 'saree', 'accessories']],
  ['beauty',          ['beauty', 'skincare', 'makeup', 'cosmetics', 'grooming', 'hair care', 'fragrance']],
  ['celebrity',       ['celebrity', 'star', 'gossip', 'red carpet', 'paparazzi', 'interview with', 'cover star', 'it girl']],
  ['relationships',   ['relationship', 'marriage', 'dating', 'love', 'family life', 'divorce', 'companionship']],
  ['spirituality',    ['spiritual', 'meditation', 'devotion', 'temple', 'guru', 'philosophy', 'dharma', 'astrology', 'faith', 'bhakti', 'vedanta', 'sufi']],
  ['agriculture',     ['agriculture', 'farming', 'farmer', 'crop', 'harvest', 'irrigation', 'agri', 'dairy', 'seed', 'monsoon crop']],
  ['aviation',        ['aviation', 'aircraft', 'airline', 'pilot', 'airport', 'flight', 'jet', 'aerospace']],
  ['railways',        ['railway', 'train', 'locomotive', 'metro rail', 'rail network']],
  ['military-history',['world war', 'battle of', 'regiment', 'campaign of', 'wartime', 'siege']],
  ['crafts',          ['craft', 'knitting', 'embroidery', 'quilting', 'handmade', 'diy project', 'woodworking', 'origami', 'pottery']],
  ['hobbies',         ['hobby', 'collector', 'model kit', 'philately', 'numismatic', 'aquarium', 'birdwatching', 'astronomy club', 'radio control']],
  ['pets',            ['pet', 'dog', 'cat', 'aquarium fish', 'veterinary', 'breed', 'puppy']],
  ['real-estate',     ['real estate', 'property', 'housing market', 'builder', 'realty', 'rent yield']],
  ['energy',          ['energy', 'solar', 'oil and gas', 'power sector', 'nuclear power', 'grid', 'petroleum', 'wind power']],
  ['manufacturing',   ['manufacturing', 'factory', 'industrial', 'supply chain', 'logistics', 'machinery', 'production line']],
  ['medicine-prof',   ['clinical trial', 'surgeon', 'diagnosis', 'pharma', 'oncology', 'cardiology', 'medical journal', 'pathology']],
  ['engineering',     ['engineering', 'civil engineering', 'mechanical', 'structural', 'infrastructure project', 'construction tech']],
  ['maths',           ['mathematics', 'mathematical', 'geometry', 'algebra', 'theorem', 'statistics']],
  ['news',            ['news', 'current affairs', 'headline', 'this week', 'newsmaker', 'weekly roundup', 'top stories', 'briefing', 'dispatch', 'newsroom']],
];

// Subjects that are inherently about the news cycle. The brief asks for
// news-heaviness to be a dimension of its own rather than one topic among many,
// because "I want a magazine but not more news" is a real and common filter.
const NEWSY_SUBJECTS = new Set(['news', 'politics', 'world-affairs', 'economy', 'defence', 'law', 'society']);

// Words that say who a magazine is for. Kept apart from subjects because
// audience is a filter, not an interest.
// These have to describe who the magazine is FOR, never what it is about. The
// first version listed bare "child" and "children", and Down To Earth — an
// environment fortnightly written for policy readers — came back classified as
// a children's magazine because that issue ran a piece on child nutrition. A
// subject word can appear in any adult magazine; an address to the reader
// cannot.
const CHILD_CUES = ['for kids', 'for children', 'for young readers', 'young readers',
  'children’s magazine', "children's magazine", 'kids magazine', 'for toddlers',
  'age 6', 'age 8', 'ages 5', 'ages 7', 'ages 8', 'juvenile', 'bedtime story',
  'colouring', 'coloring book', 'nursery rhyme', 'moral stories', 'young minds',
  'little readers', 'for schoolchildren'];
const ADULT_CUES = ['erotic', 'adults only', 'explicit', 'nude', 'sexual', '18+',
  'liquor', 'whisky', 'cocktail', 'gambling', 'betting', 'lingerie'];
const MATURE_CUES = ['murder', 'rape', 'violence', 'corruption scandal', 'terror',
  'insurgency', 'assassination', 'drug cartel', 'sexual assault', 'suicide'];

const VISUAL_CUES = ['photo essay', 'photographs', 'gallery', 'pictorial', 'illustrated',
  'comic', 'cartoon', 'infographic', 'photo feature', 'picture story', 'visual', 'portfolio',
  'lookbook', 'shoot', 'in pictures', 'photo story'];
const TEXTUAL_CUES = ['essay', 'analysis', 'commentary', 'long read', 'in depth', 'in-depth',
  'op-ed', 'column', 'treatise', 'dissertation', 'review of literature', 'discourse', 'critique'];

const ACADEMIC_CUES = ['journal', 'peer reviewed', 'peer-reviewed', 'issn', 'abstract',
  'methodology', 'et al', 'research paper', 'volume', 'scholarly', 'proceedings'];

// Words too common across a newsstand to distinguish anything. Mined topics are
// checked against this before they are allowed to become tags.
const STOP = new Set(('the a an and or of for in on at to from with by is are was were be been this that these those it its as but not you your our their his her they we i he she what which who when where how why all any both each more most other some such only own same so than too very can will just now new latest issue magazine special cover story feature article read time mins min india indian also into over after before while about their there here get got make made take took come came go went see saw know knew think thought say said tell told give gave find found use used work works year years month months week weeks day days first last next best top great good big small long short high low right left much many well back down out up off then them him us me my no nor did does do doing done has have had having would could should may might must shall let per via etc vs plus').split(' '));

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9ऀ-෿' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// The text this analysis works from, in descending order of how much it says
// about THIS issue specifically. The weights are the point: a cover line is
// worth several times a line of the publisher's evergreen blurb, because the
// blurb is identical every month and the cover line is not.
function contentSources(rec, obs) {
  const issueObs = obs.filter(o => o.issueDescription || (o.toc && o.toc.length));
  const toc = [];
  for (const o of issueObs) for (const t of o.toc || []) toc.push(t);

  return {
    toc,
    coverLines: toc.map(t => t.title).filter(Boolean),
    blurbs: toc.map(t => t.blurb).filter(Boolean),
    issueDescription: (obs.find(o => o.issueDescription) || {}).issueDescription || null,
    magazineDescription: (obs.find(o => o.magazineDescription) || {}).magazineDescription || null,
    category: rec.category,
    title: rec.title,
  };
}

// Corpus document frequency for mined phrases. Rebuilt lazily whenever the
// number of analysed records has moved enough to matter — a phrase that appears
// on every magazine on the newsstand tells you nothing, and which phrases those
// are can only be known relative to what has actually been discovered.
let dfCache = { size: -1, df: new Map() };

function corpusDf() {
  const analysed = Array.from(state.magazines.values()).filter(r => r.content && r.content.minedRaw);
  if (dfCache.size === analysed.length) return dfCache.df;
  const df = new Map();
  for (const r of analysed) {
    for (const p of Object.keys(r.content.minedRaw)) df.set(p, (df.get(p) || 0) + 1);
  }
  dfCache = { size: analysed.length, df, n: analysed.length };
  return df;
}

function analyseContent(rec, obs) {
  const src = contentSources(rec, obs);

  // Weighted text pool. Repetition is how weight is applied: a cover line
  // counted four times contributes four times as much to every downstream
  // count without any special-casing in the matchers.
  const parts = [];
  const push = (text, weight) => { for (let i = 0; i < weight; i++) if (text) parts.push(String(text)); };
  push(src.coverLines.join(' . '), 4);
  push(src.blurbs.join(' . '), 2);
  push(src.issueDescription, 3);
  push(src.title, 2);
  push(src.category, 2);
  push(src.magazineDescription, 1);
  const pool = parts.join(' \n ').toLowerCase();
  const hasIssueText = !!(src.coverLines.length || src.issueDescription);

  /* ---- ontology pass ---- */
  const topics = {};
  const evidence = {};
  for (const [name, terms] of SUBJECTS) {
    let hits = 0;
    const found = [];
    for (const term of terms) {
      const t = term.trim();
      if (!t) continue;
      // Word-boundary matching, so "art" does not fire on "start" and "ai" does
      // not fire on "said" — the single commonest way a keyword tagger produces
      // nonsense that then looks like a learned preference.
      const re = new RegExp('(^|[^a-z])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])', 'g');
      const n = (pool.match(re) || []).length;
      if (n) { hits += n; found.push(t); }
    }
    if (hits) { topics[name] = hits; evidence[name] = found.slice(0, 6); }
  }

  /* ---- mined pass ---- */
  // Whatever the ontology has no word for. Bigrams from cover lines only: they
  // are five to ten words written to say what a piece is about, with none of the
  // boilerplate that makes body prose useless for this.
  const minedRaw = {};
  const lineTokens = src.coverLines.map(tokenize);
  for (const toks of lineTokens) {
    for (let i = 0; i < toks.length; i++) {
      const a = toks[i], b = toks[i + 1];
      if (a.length > 3 && !STOP.has(a)) minedRaw[a] = (minedRaw[a] || 0) + 1;
      if (b && a.length > 2 && b.length > 2 && !STOP.has(a) && !STOP.has(b)) {
        minedRaw[a + ' ' + b] = (minedRaw[a + ' ' + b] || 0) + 1;
      }
    }
  }

  const df = corpusDf();
  const n = Math.max(12, dfCache.n || 12);
  const mined = {};
  for (const [phrase, count] of Object.entries(minedRaw)) {
    if (count < 2 && !phrase.includes(' ')) continue;
    const docs = df.get(phrase) || 1;
    const ratio = docs / n;
    // Same frequency band a tag has to sit in to be worth anything: below the
    // floor it describes one magazine and cannot generalise, above the ceiling
    // it describes the whole newsstand and cannot discriminate.
    if (ratio > 0.28) continue;
    mined[phrase] = count * (1 + Math.log(1 / Math.max(ratio, 1 / n)) / 6);
  }

  const minedTop = topEntries(mined, 8);
  for (const [p, w] of minedTop) if (!topics[p]) topics[p] = w * 0.7;

  /* ---- normalise topic weights ---- */
  const total = sum(Object.values(topics)) || 1;
  const weighted = {};
  for (const [k, v] of Object.entries(topics)) {
    const w = v / total;
    if (w >= 0.02) weighted[k] = +w.toFixed(4);
  }

  /* ---- news-heaviness ---- */
  const newsWeight = sum(Object.entries(weighted).filter(([k]) => NEWSY_SUBJECTS.has(k)).map(([, v]) => v));
  const cadenceNewsy = rec.frequency && rec.frequency.days && rec.frequency.days <= 9 ? 0.2 : 0;
  const catNewsy = /news|politic|current affair|newspaper/i.test(rec.category || '') ? 0.3 : 0;
  const newsiness = clamp(newsWeight + cadenceNewsy + catNewsy);

  /* ---- visual vs textual ---- */
  const countCues = (arr) => sum(arr.map(c => (pool.split(c).length - 1)));
  const vis = countCues(VISUAL_CUES);
  const txt = countCues(TEXTUAL_CUES);
  const catVisual = /comic|photograph|art|design|architecture|fashion|home|children/i.test(rec.category || '') ? 1.4 : 0;
  const catText = /academic|journal|business|news|politic|literary/i.test(rec.category || '') ? 1.2 : 0;
  // Reading time per piece is the strongest structural signal there is: a
  // magazine of two-minute pieces is a magazine you look at, and a magazine of
  // fifteen-minute pieces is one you sit down with.
  const minsList = src.toc.map(t => t.mins).filter(m => m > 0);
  const avgMins = minsList.length ? mean(minsList) : null;
  // Reading time per piece is the only strong structural evidence available. A
  // magazine of two-minute pieces is one you look at; a magazine of
  // fifteen-minute pieces is one you sit down with.
  let visualness, visualBasis, visualConfidence;
  if (avgMins != null) {
    visualness = clamp(1 - (avgMins - 2) / 10);
    visualness = clamp(visualness * 0.65 + clamp(0.5 + (vis + catVisual - txt - catText) / 8) * 0.35);
    visualBasis = 'average piece runs ' + avgMins.toFixed(1) + ' minutes across ' + minsList.length + ' articles';
    visualConfidence = clamp(0.45 + minsList.length / 25);
  } else {
    // No reading times means no structural evidence, so the estimate stays near
    // the middle and moves only as far as the cue count justifies. The earlier
    // version divided by a fixed 8 and put a Hindi women's monthly at exactly
    // zero on the strength of three English words in its standing blurb.
    const lean = (vis + catVisual - txt - catText);
    visualness = clamp(0.5 + Math.tanh(lean / 4) * 0.32);
    visualBasis = lean === 0
      ? 'no evidence either way — held at the middle'
      : Math.abs(lean).toFixed(1) + ' cue(s) leaning ' + (lean > 0 ? 'visual' : 'textual');
    visualConfidence = clamp(0.12 + Math.abs(lean) / 12);
  }

  /* ---- reading difficulty ---- */
  // Long words and long sentences, plus the academic tell-tales. Deliberately
  // crude and deliberately transparent: the number is only ever used as one
  // component among a dozen, and it is shown to the user as a word rather than
  // a score.
  const proseSample = [src.issueDescription, src.blurbs.join(' '), src.magazineDescription]
    .filter(Boolean).join(' ').slice(0, 4000);
  const words = tokenize(proseSample);
  const longWords = words.filter(w => w.length >= 9).length;
  const sentences = Math.max(1, (proseSample.match(/[.!?]+/g) || []).length);
  const wordsPerSentence = words.length / sentences;
  const academic = sum(ACADEMIC_CUES.map(c => (pool.split(c).length - 1)));
  let difficulty = clamp(
    (words.length ? longWords / words.length : 0.12) * 2.2
    + clamp((wordsPerSentence - 12) / 22) * 0.5
    + clamp(academic / 5) * 0.5
    + (avgMins != null ? clamp((avgMins - 3) / 12) * 0.4 : 0)
  );
  if (/academic|journal/i.test(rec.category || '')) difficulty = Math.max(difficulty, 0.78);
  if (/children|comic/i.test(rec.category || '')) difficulty = Math.min(difficulty, 0.3);

  /* ---- audience ---- */
  // The shelf the magazine is filed on is the strongest and most reliable
  // audience signal there is; the text cues only corroborate it.
  const childShelf = /children|comic|kids/i.test(rec.category || '');
  const childHits = countCues(CHILD_CUES) + (childShelf ? 3 : 0);
  const adultHits = countCues(ADULT_CUES) * 3;
  const matureHits = countCues(MATURE_CUES);

  // Subjects nobody puts in a children's magazine. Without this veto a single
  // stray phrase can flip a business or politics title, and the audience filter
  // is a hard constraint — a false "suits children" is a real-world error, not
  // a ranking nuance.
  const adultSubjectWeight = sum(['politics', 'business', 'finance', 'economy', 'world-affairs',
    'defence', 'law', 'celebrity', 'relationships', 'management', 'real-estate', 'medicine-prof']
    .map(k => weighted[k] || 0));
  const adultSubject = adultSubjectWeight > 0.25;

  let audience, audienceWhy;
  if (adultHits > 0) {
    audience = 'adult';
    audienceWhy = 'adult-only material referenced in the issue text';
  } else if (childShelf && matureHits === 0 && !adultSubject) {
    audience = 'child';
    audienceWhy = 'published for children and nothing mature in this issue';
  } else if (adultSubject) {
    audience = 'adult';
    audienceWhy = 'built around subjects written for adult readers';
  } else if (childHits >= 3 && matureHits === 0) {
    audience = 'child';
    audienceWhy = 'addressed to young readers and nothing mature in this issue';
  } else if (childHits >= 1 && matureHits <= 1 && difficulty < 0.5) {
    audience = 'both';
    audienceWhy = 'accessible and free of mature material — reads for either';
  } else if (matureHits >= 2 || newsiness > 0.5 || difficulty > 0.62) {
    audience = 'adult';
    audienceWhy = matureHits >= 2 ? 'mature subject matter in this issue'
      : newsiness > 0.5 ? 'news and current affairs written for adults'
      : 'demanding reading level';
  } else if (hasIssueText) {
    audience = 'both';
    audienceWhy = 'nothing in this issue rules out either audience';
  } else {
    audience = null;
    audienceWhy = 'not enough was read about this issue to say';
  }

  /* ---- a description of THIS issue ---- */
  const summary = buildIssueSummary(rec, src, weighted);

  return {
    topics: weighted, evidence, minedRaw, mined: Object.fromEntries(minedTop),
    newsiness, visualness, visualBasis, visualConfidence, difficulty, audience, audienceWhy,
    avgMins, articleCount: src.toc.length,
    summary,
    // Most titles never publish a per-article index — only Magzter's "Stories"
    // partners do — so a substantial issue description has to count as knowing
    // what is in the issue, or nine titles in ten would be judged on their
    // shelf category alone.
    depth: (src.coverLines.length >= 5 || (src.issueDescription || '').length > 150) ? 'issue'
      : hasIssueText ? 'partial' : 'title-only',
    academic: academic > 2 || /academic|journal/i.test(rec.category || ''),
  };
}

// One or two sentences describing what is in this particular issue. The issue's
// own description is used verbatim where the source published one, because a
// paraphrase of a good editorial summary is always worse than the summary; the
// generated fallback is clearly the fallback and says what it is built from.
function buildIssueSummary(rec, src, topics) {
  if (src.issueDescription && src.issueDescription.length > 60) {
    return { text: src.issueDescription, basis: 'the issue’s own description' };
  }
  if (src.coverLines.length) {
    const lines = src.coverLines.slice(0, 5).map(l => l.replace(/\s+/g, ' ').trim());
    return {
      text: 'Cover lines this issue: ' + lines.join('; ') + '.',
      basis: src.coverLines.length + ' cover lines read from the issue',
    };
  }
  if (src.magazineDescription) {
    return {
      text: src.magazineDescription.slice(0, 400),
      basis: 'the magazine’s standing description — nothing issue-specific was found',
    };
  }
  const names = topEntries(topics, 3).map(([k]) => k).join(', ');
  return {
    text: names ? 'Nothing issue-specific was readable; the title indexes as ' + names + '.'
                : 'Nothing has been read about this title beyond its listing.',
    basis: 'no issue text available',
  };
}

// A short human phrase for a numeric characteristic. Numbers are for the
// scoring model; the cards say words.
const visualWord = v => v >= 0.68 ? 'Highly visual' : v >= 0.45 ? 'Mixed words and pictures' : 'Text-heavy';
const difficultyWord = d => d >= 0.68 ? 'Demanding' : d >= 0.4 ? 'Moderate' : 'Easy';
const newsWord = n => n >= 0.55 ? 'News-heavy' : n >= 0.25 ? 'Some current affairs' : 'Little or no news';
const audienceWord = a => a === 'child' ? 'For children' : a === 'adult' ? 'For adults'
  : a === 'both' ? 'Suits children and adults' : 'Audience unclear';

/* ================================================================ filters */
/* Hard constraints. These are the user's, always, and the learning model may
   never write to them — that separation is the reason a magazine can be
   excluded for a reason the user can point at, rather than quietly sinking down
   a ranking for a reason nobody can see.

   Failing a filter removes a candidate. It does not reduce its score. */

function evaluateFilters(rec, f) {
  const fails = [];
  const fail = (filter, reason) => fails.push({ filter, reason });

  if (f.indiaOnly && rec.availability === 'gone') {
    fail('availability in India', 'the listing has been retired at every source read');
  }

  if (f.kinds && f.kinds.length && !f.kinds.includes(rec.kind)) {
    fail('publication type', 'this reads as a ' + rec.kind + ', not a ' + f.kinds.join(' or '));
  }

  // Price is checked in rupees, and a candidate whose price could not be read
  // is NOT silently dropped — an unknown price is flagged on the card instead,
  // because dropping it would quietly hide every print title whose publisher
  // does not put a number on the page.
  if (f.maxPrice != null) {
    const inr = toInr(rec.price);
    if (inr != null && inr > f.maxPrice) {
      fail('max price', fmtPrice(rec.price) + ' is over the ₹' + f.maxPrice + ' ceiling');
    }
  }

  if (f.format !== 'any') {
    const have = rec.formats || [];
    if (have.length && !have.includes(f.format)) {
      fail('format', 'only found as ' + have.join('/') + ', not ' + f.format);
    }
  }

  if (f.languages.length) {
    if (rec.language && !f.languages.includes(rec.language)) {
      fail('language', 'published in ' + rec.language);
    }
  }

  if (f.frequency.length) {
    const label = rec.frequency && rec.frequency.label;
    if (label && !f.frequency.includes(label)) fail('frequency', 'published ' + label.toLowerCase());
  }

  const topics = rec.topics || {};
  if (f.topicsWanted.length) {
    const hit = f.topicsWanted.some(t => (topics[t] || 0) >= 0.05);
    if (!hit) fail('topics wanted', 'this issue does not cover ' + f.topicsWanted.join(' or '));
  }
  for (const t of f.topicsExcluded) {
    if ((topics[t] || 0) >= 0.08) fail('topics excluded', 'this issue is substantially about ' + t);
  }

  const c = rec.content || {};
  if (f.news === 'exclude' && c.newsiness > 0.45) {
    fail('no news', 'reads as news and current affairs');
  }
  if (f.news === 'include' && c.newsiness < 0.2) {
    fail('news wanted', 'carries little or no current affairs');
  }

  if (f.audience !== 'any' && c.audience) {
    const ok = f.audience === 'both' ? c.audience === 'both'
      : c.audience === f.audience || c.audience === 'both';
    if (!ok) fail('audience', audienceWord(c.audience).toLowerCase());
  }

  if (f.visual !== 'any' && c.visualness != null) {
    const band = c.visualness >= 0.68 ? 'visual' : c.visualness >= 0.45 ? 'balanced' : 'text';
    if (band !== f.visual) fail('visual content', visualWord(c.visualness).toLowerCase());
  }

  if (f.difficulty !== 'any' && c.difficulty != null) {
    const band = c.difficulty >= 0.68 ? 'hard' : c.difficulty >= 0.4 ? 'medium' : 'easy';
    if (band !== f.difficulty) fail('reading difficulty', difficultyWord(c.difficulty).toLowerCase());
  }

  if (f.minConfidence > 0 && rec.issue && rec.issue.confidence < f.minConfidence) {
    fail('current-issue confidence', 'cannot establish which issue is on sale now');
  }

  return { pass: fails.length === 0, fails };
}

/* ------------------------------------------------- history-derived filters */
/* Recently bought, recently covered subjects and duplicate tolerance are listed
   in the brief as filters, and they behave like filters — but they are computed
   from history rather than typed in, so they live here beside the rest of the
   gate instead of in the deck. */

function historyGate(rec, f, ctx) {
  const fails = [];
  const bought = ctx.boughtByRecord.get(rec.id) || [];

  // Issue-level, not title-level. Buying August does not disqualify September;
  // buying THIS issue does.
  const thisIssue = rec.issue && rec.issue.label;
  if (thisIssue && bought.some(b => sameIssue(b.issueLabel, thisIssue))) {
    fails.push({ filter: 'already bought', reason: 'you bought this exact issue' });
  }
  const read = (ctx.readByRecord.get(rec.id) || []);
  if (thisIssue && read.some(b => sameIssue(b.issueLabel, thisIssue))) {
    fails.push({ filter: 'already read', reason: 'you marked this issue read' });
  }

  if (f.excludeRecentlyBought > 0 && bought.length) {
    const newest = Math.max(...bought.map(b => b.at));
    const months = (Date.now() - newest) / (30.4 * 864e5);
    if (months < f.excludeRecentlyBought) {
      fails.push({
        filter: 'recently bought',
        reason: 'you bought this title ' + Math.max(1, Math.round(months)) + ' month(s) ago',
      });
    }
  }
  return fails;
}

// Two issue labels refer to the same issue. Compared on parsed dates where both
// parse, because "September 2026" and "Sep 2026" are the same issue and a string
// comparison says they are not.
function sameIssue(a, b) {
  if (!a || !b) return false;
  if (String(a).toLowerCase().trim() === String(b).toLowerCase().trim()) return true;
  const pa = parseIssueLabel(a), pb = parseIssueLabel(b);
  if (pa.date && pb.date) return Math.abs(pa.date - pb.date) < 3 * 864e5;
  if (pa.num && pb.num) return pa.num === pb.num;
  return false;
}

/* ====================================================== preference learning */
/* Starts empty. Every number in the model below is derived from the event log
   and nothing else — there is no prior, no seeded interest, no demographic
   guess and no starter catalogue. With no events, every call in this section
   returns "unknown", and the ranking layer is built to behave sensibly when it
   does rather than to invent something to fill the gap.

   The model is rebuilt from the log rather than updated in place, so deleting
   an event or overriding an inference produces exactly the model that would
   have existed had things gone that way. That is what makes the correction
   controls in the Taste view honest. */

// What a rejection reason actually means, in model terms. A bare skip says
// almost nothing; "too text-heavy" says precisely one thing, and acting on that
// one thing is far better than nudging every topic on the card downwards.
const REASON_EFFECTS = {
  'Subject does not interest me':          { topics: -1 },
  'Too much news / current affairs':       { scalar: ['newsiness', 'low'], topics: 0 },
  'Too text-heavy':                        { scalar: ['visualness', 'high'], topics: 0 },
  'Too light — I want more depth':         { scalar: ['difficulty', 'high'], topics: 0 },
  'Too expensive':                         { scalar: ['price', 'low'], topics: 0 },
  'Wrong language':                        { facet: 'language', topics: 0 },
  'Not available where I am':              { topics: 0 },
  'Too similar to something I just read':  { diversity: 1, topics: 0 },
  'Wrong audience — too childish':         { facet: 'audience', value: 'adult', topics: 0 },
  'Wrong audience — not suitable for children': { facet: 'audience', value: 'child', topics: 0 },
  'I dislike this publisher':              { facet: 'publisher', topics: 0 },
  'Cover / design put me off':             { topics: 0 },
};

function newAccumulator() {
  return { pos: 0, neg: 0, evidence: [] };
}

function accFor(map, key) {
  if (!map[key]) map[key] = newAccumulator();
  return map[key];
}

function newScalar() {
  return { posW: 0, posSum: 0, posSq: 0, negW: 0, negSum: 0, samples: [] };
}

function addScalar(s, value, weight, sign, ev) {
  if (value == null || !Number.isFinite(value)) return;
  if (sign > 0) { s.posW += weight; s.posSum += value * weight; s.posSq += value * value * weight; }
  else { s.negW += weight; s.negSum += value * weight; }
  s.samples.push({ value, weight, sign, ...ev });
  if (s.samples.length > 200) s.samples.shift();
}

function scalarView(s, label) {
  if (s.posW < 0.5 && s.negW < 0.5) return { known: false, label };
  const mean_ = s.posW ? s.posSum / s.posW : null;
  const varc = s.posW ? Math.max(0, s.posSq / s.posW - mean_ * mean_) : null;
  const sd = varc == null ? null : Math.sqrt(varc);
  return {
    known: true, label,
    mean: mean_, sd: sd == null ? null : Math.max(sd, 0.08),
    avoid: s.negW ? s.negSum / s.negW : null,
    weight: s.posW + s.negW,
    confidence: clamp(1 - Math.exp(-(s.posW + s.negW) / 3)),
    samples: s.samples.slice(-24).reverse(),
  };
}

// The whole model, rebuilt from the log. Cheap enough to run on every change:
// a year of heavy use is a few thousand events.
function buildTaste() {
  const model = {
    topics: {},          // name -> accumulator
    audience: {}, formats: {}, languages: {}, publishers: {}, frequency: {},
    price: newScalar(), visualness: newScalar(), difficulty: newScalar(), newsiness: newScalar(),
    novelty: { posW: 0, posSum: 0, negW: 0, negSum: 0, samples: [] },
    diversityPressure: 0,
    eventCount: 0, totalWeight: 0, firstAt: 0, lastAt: 0,
  };

  const events = state.events.slice().sort((a, b) => a.at - b.at);
  if (!events.length) return finaliseTaste(model);

  // A running centroid of what the user has liked so far, snapshotted BEFORE
  // each event is applied. That snapshot is what makes progression measurable:
  // the novelty of a choice is its distance from the taste that existed at the
  // moment it was made, not from the taste it went on to create.
  let centroid = {};
  let centroidW = 0;

  for (const ev of events) {
    const rec = resolveRecord(ev.recordId);
    if (!rec) continue;

    // A view is recorded because the history is supposed to show what was put
    // in front of you, and it is deliberately NOT trained on. Being shown
    // something is a fact about what the ranker chose, not about what you like,
    // and feeding it back in makes the ranker learn from its own output: it
    // showed a spiritual monthly, concluded you were drawn to spirituality, and
    // showed it again. That is the preference bubble this app is required to
    // avoid, arriving one render at a time.
    //
    // "Shown and not wanted" is a real signal, and it has its own event —
    // skip — which the user produces deliberately.
    if (ev.kind === 'view') { model.eventCount++; continue; }

    const w = (EVENT_WEIGHT[ev.kind] || 0.2) * (ev.weightMul || 1);
    if (!w) continue;

    let sign = NEGATIVE_EVENTS.has(ev.kind) ? -1 : 1;
    let magnitude = w;

    // A rating is the one event that carries its own sign and strength. 3 is
    // deliberately near-neutral: "it was fine" should not train anything much.
    if (ev.kind === 'rate') {
      const r = +ev.rating || 3;
      sign = r >= 3.5 ? 1 : r <= 2.5 ? -1 : 0;
      magnitude = w * Math.abs(r - 3) / 2;
      if (!sign || magnitude < 0.05) continue;
    }
    if (ev.kind === 'alreadyRead') sign = 1;

    model.eventCount++;
    model.totalWeight += magnitude;
    model.firstAt = model.firstAt || ev.at;
    model.lastAt = ev.at;

    const vec = rec.topicVec || {};
    const noveltyNow = centroidW ? 1 - cosine(centroid, vec) : null;

    const effect = ev.reason ? REASON_EFFECTS[ev.reason] : null;
    const topicMul = effect && effect.topics === 0 ? 0 : 1;

    // Topics. Weighted by how much of the issue the topic actually is, so a
    // magazine that is 60% cars teaches "cars" more than one that mentions a car.
    if (topicMul) {
      for (const [t, share] of Object.entries(rec.topics || {})) {
        const a = accFor(model.topics, t);
        const delta = magnitude * share * 3;
        if (sign > 0) a.pos += delta; else a.neg += delta;
        a.evidence.push({
          at: ev.at, kind: ev.kind, sign, delta: +delta.toFixed(3),
          recordId: rec.id, title: rec.title, issue: ev.issueLabel || null,
          share: +share.toFixed(3), reason: ev.reason || null,
        });
        if (a.evidence.length > 40) a.evidence.shift();
      }
    }

    const evMeta = { at: ev.at, kind: ev.kind, title: rec.title, recordId: rec.id, reason: ev.reason || null };
    const c = rec.content || {};

    // Facets. Unlike topics these are single-valued, so they accumulate as
    // straightforward for/against counts.
    const facet = (map, key) => {
      if (key == null || key === '') return;
      const a = accFor(map, String(key));
      if (sign > 0) a.pos += magnitude; else a.neg += magnitude;
      a.evidence.push(evMeta);
      if (a.evidence.length > 30) a.evidence.shift();
    };
    facet(model.audience, c.audience);
    facet(model.languages, rec.language);
    facet(model.publishers, rec.publisher);
    facet(model.frequency, rec.frequency && rec.frequency.label);
    for (const fm of rec.formats || []) facet(model.formats, ev.format || fm);

    // Scalars. A purchase price is a far better price signal than a listed one,
    // so a buy event's recorded price overrides whatever the listing said.
    const paid = ev.kind === 'buy' && ev.pricePaid != null ? +ev.pricePaid : toInr(rec.price);
    addScalar(model.price, paid, magnitude, sign, evMeta);
    addScalar(model.visualness, c.visualness, magnitude, sign, evMeta);
    addScalar(model.difficulty, c.difficulty, magnitude, sign, evMeta);
    addScalar(model.newsiness, c.newsiness, magnitude, sign, evMeta);

    // A stated reason overrides the passive reading of the same event. "Too
    // text-heavy" is a direct instruction about visualness and is applied as
    // one, at triple weight, rather than being inferred back out of the card.
    if (effect) {
      if (effect.scalar) {
        const [name, dir] = effect.scalar;
        const target = name === 'price' ? (toInr(rec.price) || 0) : (c[name] != null ? c[name] : 0.5);
        if (name === 'price') addScalar(model.price, target, magnitude * 3, -1, evMeta);
        else if (dir === 'high') addScalar(model[name], clamp(target + 0.3), magnitude * 3, 1, evMeta);
        else addScalar(model[name], clamp(target - 0.3), magnitude * 3, 1, evMeta);
      }
      if (effect.facet === 'audience' && effect.value) {
        const a = accFor(model.audience, effect.value);
        a.pos += magnitude * 2;
        a.evidence.push({ ...evMeta, note: 'stated as the audience they wanted' });
      }
      if (effect.facet === 'language' && rec.language) {
        const a = accFor(model.languages, rec.language);
        a.neg += magnitude * 2;
        a.evidence.push({ ...evMeta, note: 'rejected explicitly for its language' });
      }
      if (effect.facet === 'publisher' && rec.publisher) {
        const a = accFor(model.publishers, rec.publisher);
        a.neg += magnitude * 2;
        a.evidence.push({ ...evMeta, note: 'rejected explicitly for its publisher' });
      }
      if (effect.diversity) model.diversityPressure += magnitude;
    }

    // Progression. Recorded for both signs: rejecting distant things is as
    // informative about appetite as accepting them, and a model that only
    // watched acceptances would read a cautious user as adventurous.
    if (noveltyNow != null) {
      if (sign > 0) { model.novelty.posW += magnitude; model.novelty.posSum += noveltyNow * magnitude; }
      else { model.novelty.negW += magnitude; model.novelty.negSum += noveltyNow * magnitude; }
      model.novelty.samples.push({ ...evMeta, novelty: +noveltyNow.toFixed(3), sign });
      if (model.novelty.samples.length > 120) model.novelty.samples.shift();
    }

    if (sign > 0) {
      for (const [k, v] of Object.entries(vec)) centroid[k] = (centroid[k] || 0) + v * magnitude;
      centroidW += magnitude;
    }
  }

  model.centroid = normaliseVec(centroid);
  model.centroidWeight = centroidW;
  return finaliseTaste(model);
}

// Turns accumulators into the numbers the ranker and the Taste view consume,
// then applies the user's manual corrections last so a correction always wins.
function finaliseTaste(model) {
  const ALPHA = 0.7;   // smoothing; with no evidence a topic sits at zero utility
  const view = {
    empty: model.eventCount === 0,
    eventCount: model.eventCount,
    totalWeight: model.totalWeight,
    // How far the model has earned the right to override everything else. At
    // zero it must not: a shortlist built on one skip would be worse than one
    // built on nothing. Near one, a strong mismatch has to be able to sink a
    // magazine that is otherwise excellent, which is the entire point of having
    // learned anything.
    maturity: clamp(1 - Math.exp(-model.totalWeight / 9)),
    firstAt: model.firstAt, lastAt: model.lastAt,
    centroid: model.centroid || {},
    centroidWeight: model.centroidWeight || 0,
    topics: {},
    facets: {},
    scalars: {
      price:      scalarView(model.price, 'price'),
      visualness: scalarView(model.visualness, 'visual content'),
      difficulty: scalarView(model.difficulty, 'reading difficulty'),
      newsiness:  scalarView(model.newsiness, 'news content'),
    },
    overrides: state.overrides,
  };

  for (const [name, a] of Object.entries(model.topics)) {
    const utility = Math.log((a.pos + ALPHA) / (a.neg + ALPHA));
    view.topics[name] = {
      name, utility,
      pos: +a.pos.toFixed(3), neg: +a.neg.toFixed(3),
      weight: a.pos + a.neg,
      confidence: clamp(1 - Math.exp(-(a.pos + a.neg) / 2.2)),
      evidence: a.evidence.slice().reverse(),
      overridden: false,
    };
  }

  for (const [facet, map] of Object.entries({
    audience: model.audience, formats: model.formats,
    languages: model.languages, publishers: model.publishers, frequency: model.frequency,
  })) {
    view.facets[facet] = {};
    for (const [k, a] of Object.entries(map)) {
      view.facets[facet][k] = {
        name: k,
        utility: Math.log((a.pos + ALPHA) / (a.neg + ALPHA)),
        pos: +a.pos.toFixed(3), neg: +a.neg.toFixed(3),
        weight: a.pos + a.neg,
        confidence: clamp(1 - Math.exp(-(a.pos + a.neg) / 2.2)),
        evidence: a.evidence.slice().reverse(),
      };
    }
  }

  // Appetite for the unfamiliar. Above 0.5 means distant things have gone down
  // better than near ones; below means the opposite. With no evidence it sits
  // at exactly 0.5 and the exploration term falls back to the fixed rate in
  // settings — which is the honest thing to do when nothing is known.
  const n = model.novelty;
  const posMean = n.posW ? n.posSum / n.posW : null;
  const negMean = n.negW ? n.negSum / n.negW : null;
  let appetite = 0.5, appetiteBasis = 'nothing recorded yet';
  if (posMean != null && negMean != null) {
    appetite = clamp(0.5 + (posMean - negMean) * 1.6);
    appetiteBasis = 'accepted picks averaged ' + posMean.toFixed(2) +
      ' away from your taste, rejected ones ' + negMean.toFixed(2);
  } else if (posMean != null) {
    appetite = clamp(0.35 + posMean * 0.9);
    appetiteBasis = 'accepted picks averaged ' + posMean.toFixed(2) + ' away from your taste at the time';
  }
  view.progression = {
    appetite,
    basis: appetiteBasis,
    acceptedMean: posMean, rejectedMean: negMean,
    weight: n.posW + n.negW,
    confidence: clamp(1 - Math.exp(-(n.posW + n.negW) / 4)),
    // How far a step is allowed to be. Familiar (< .38) keeps to the centroid,
    // adjacent walks one subject over, exploratory jumps.
    stride: appetite < 0.38 ? 'familiar' : appetite < 0.62 ? 'adjacent' : 'exploratory',
    samples: n.samples.slice().reverse(),
  };

  view.diversityPressure = model.diversityPressure;

  applyOverrides(view);
  return view;
}

// Manual corrections. Three shapes, all reversible, none of them touching the
// event log: mute a topic entirely, pin it to a value, or delete the evidence
// behind it (which is done by removing the events, not by patching the model).
function applyOverrides(view) {
  for (const [key, ov] of Object.entries(state.overrides || {})) {
    const [kind, ...rest] = key.split(':');
    const name = rest.join(':');
    if (kind === 'topic' && view.topics[name]) {
      if (ov.mode === 'mute') { view.topics[name].utility = 0; view.topics[name].muted = true; }
      if (ov.mode === 'set') view.topics[name].utility = +ov.value;
      view.topics[name].overridden = true;
      view.topics[name].overrideNote = ov.note || null;
    } else if (kind === 'topic' && ov.mode === 'set') {
      // A topic the user asserted before any evidence existed for it.
      view.topics[name] = {
        name, utility: +ov.value, pos: 0, neg: 0, weight: 0,
        confidence: 0.5, evidence: [], overridden: true, manualOnly: true,
        overrideNote: ov.note || null,
      };
    } else if (kind === 'scalar' && view.scalars[name]) {
      view.scalars[name] = { ...view.scalars[name], known: true, mean: +ov.value, overridden: true, sd: 0.14 };
    } else if (kind === 'progression') {
      view.progression.appetite = +ov.value;
      view.progression.overridden = true;
      view.progression.stride = ov.value < 0.38 ? 'familiar' : ov.value < 0.62 ? 'adjacent' : 'exploratory';
    }
  }
}

let tasteCache = { key: '', value: null };
function taste() {
  const key = state.events.reduce((a, e) => a + (e.kind === 'view' ? 0 : 1), 0)
    + '|' + JSON.stringify(state.overrides) + '|' + state.magazines.size;
  if (tasteCache.key === key) return tasteCache.value;
  tasteCache = { key, value: buildTaste() };
  return tasteCache.value;
}

/* ------------------------------------------------------------------ events */

function recordEvent(kind, rec, extra = {}) {
  const ev = {
    id: hash(kind + rec.id + Date.now() + Math.random()),
    at: Date.now(),
    kind,
    recordId: rec.id,
    title: rec.title,
    issueLabel: (rec.issue && rec.issue.label) || null,
    issueKey: (rec.issue && rec.issue.key) || null,
    month: nowMonth(),
    topics: topEntries(rec.topics || {}, 5).map(([k]) => k),
    ...extra,
  };
  state.events.push(ev);
  tasteCache.key = '';
  // A passive view is logged during render. Dropping the cached ranking here
  // would make every render recompute the whole board for a signal worth 0.15,
  // so the view is recorded and the ranking left standing until something with
  // an opinion in it arrives.
  if (kind !== 'view') state.ranked = null;
  scheduleSave();
  return ev;
}

function deleteEvent(id) {
  const at = state.events.findIndex(e => e.id === id);
  if (at < 0) return false;
  state.events.splice(at, 1);
  tasteCache.key = '';
  state.ranked = null;
  scheduleSave();
  return true;
}

// Everything the ranker needs to know about history, computed once per ranking
// pass rather than per candidate.
function historyContext() {
  const boughtByRecord = new Map();
  const readByRecord = new Map();
  const recommendedAt = new Map();
  const subjectMonths = new Map();   // topic -> [months it was bought/read in]
  const skipped = new Map();

  for (const ev of state.events) {
    const rec = resolveRecord(ev.recordId);
    const id = rec ? rec.id : ev.recordId;
    if (ev.kind === 'buy') {
      if (!boughtByRecord.has(id)) boughtByRecord.set(id, []);
      boughtByRecord.get(id).push(ev);
    }
    if (ev.kind === 'alreadyRead') {
      if (!readByRecord.has(id)) readByRecord.set(id, []);
      readByRecord.get(id).push(ev);
    }
    if (ev.kind === 'skip' || ev.kind === 'notInterested') {
      skipped.set(id, Math.max(skipped.get(id) || 0, ev.at));
    }
    if (ev.kind === 'buy' || ev.kind === 'alreadyRead' || ev.kind === 'like') {
      for (const t of ev.topics || []) {
        if (!subjectMonths.has(t)) subjectMonths.set(t, []);
        subjectMonths.get(t).push(ev.month);
      }
    }
  }

  // Which titles were put in front of the user, and when. Held separately from
  // the event log because a recommendation the user never touched still counts
  // against repeating it next month.
  //
  // PREVIOUS months only. The current month's cycle record is written by
  // currentCycle() as a side effect of ranking, so including it made the
  // ranking depend on its own output: this month's pick picked up the full
  // "recommended too recently" penalty on the very next recompute and the
  // headline recommendation flipped between two titles on every render.
  const thisMonth = nowMonth();
  for (const [month, cyc] of Object.entries(state.meta.cycles || {})) {
    if (+month >= thisMonth) continue;
    for (const id of [].concat(cyc.picked || [], cyc.shortlist || [])) {
      recommendedAt.set(id, Math.max(recommendedAt.get(id) || 0, +month));
    }
  }

  return { boughtByRecord, readByRecord, recommendedAt, subjectMonths, skipped };
}

/* =============================================================== ranking  */
/* Topic similarity alone would answer a different question — "what is most like
   what you already liked" — and answering that every month is how a
   recommender turns into a rut. What is wanted is "what should I buy THIS
   month", which is a different thing: it has to weigh whether the issue is
   actually current, whether it can be bought, whether it repeats last month,
   whether it is worth the money, and whether it is time to try something else.

   Every component below is a number in [0,1] (penalties are negative), stored
   on the candidate, and rendered term by term in Research. A ranking that looks
   wrong should be traceable to the term responsible in one click.             */

function scoreCandidate(rec, t, ctx, f) {
  const c = rec.content || {};
  const parts = {};
  const notes = {};

  /* ---- availability: can this actually be bought, and do we know it ---- */
  let avail = rec.availability === 'available' ? 0.85 : rec.availability === 'gone' ? 0 : 0.4;
  if (rec.offers && rec.offers.length) avail += 0.1;
  if (rec.price && rec.price.basis === 'single-issue' && rec.price.confidence > 0.8) avail += 0.05;
  if (rec.sellers && rec.sellers.length > 1) avail += 0.05;
  parts.availability = clamp(avail);
  notes.availability = rec.availability === 'available'
    ? 'listed as on sale by ' + (rec.sellers || []).join(', ')
    : 'availability not confirmed';

  /* ---- freshness: is the issue we found the one on the shelf now ---- */
  const iss = rec.issue || {};
  let fresh = iss.confidence || 0;
  const days = rec.frequency && rec.frequency.days;
  if (iss.parsed && iss.parsed.date && days) {
    const age = (Date.now() - iss.parsed.date) / 864e5;
    // Peak at "published within the current cycle", falling away either side.
    fresh = fresh * clamp(1 - Math.max(0, age - days) / (days * 2.5));
  }
  parts.freshness = clamp(fresh);
  notes.freshness = iss.label
    ? iss.label + ' — ' + iss.band + ' (' + Math.round((iss.confidence || 0) * 100) + '% confident)'
    : 'no current issue identified';

  /* ---- preference fit ---- */
  // The raw fit sits in [0,1] around a neutral 0.5, and at that scale a firm
  // mismatch moved the total by less than a missing cover image did. It is
  // stretched about the neutral point in proportion to how much the model
  // knows, so an informed dislike can actually sink a candidate while an
  // uninformed one still cannot. The stretched value is what is stored, so the
  // arithmetic shown in Research is the arithmetic that ran.
  const fit = preferenceFit(rec, t);
  const stretch = 1 + 1.7 * (t.maturity || 0);
  parts.prefFit = clamp(0.5 + (fit.score - 0.5) * stretch);
  notes.prefFit = fit.note + (t.empty ? ''
    : ' · raw fit ' + Math.round(fit.score * 100) + '%, weighted ×' + stretch.toFixed(2)
      + ' for model maturity');

  /* ---- immediate appeal: is this a good issue, independent of taste ---- */
  // Not "is it popular" — nothing here can see sales. It is whether the issue
  // presents itself well enough to be worth a stranger's money: a real cover, a
  // described issue, a substantial contents list.
  // Continuous rather than banded. The banded version put three unrelated
  // magazines on an identical cold-start score and left the tie to be broken by
  // map iteration order, which is not a judgement.
  let appeal = 0.2;
  if (rec.coverUrl) appeal += 0.18;
  appeal += c.depth === 'issue' ? 0.22 : c.depth === 'partial' ? 0.1 : 0;
  appeal += clamp(Math.log1p(c.articleCount || 0) / Math.log(40)) * 0.18;
  appeal += clamp(((c.summary && c.summary.text) || '').length / 900) * 0.12;
  if (c.summary && c.summary.basis && c.summary.basis.indexOf('own description') >= 0) appeal += 0.1;
  // Nothing is confidently known about a title with almost no topic signal.
  appeal *= clamp(0.55 + Object.keys(rec.topics || {}).length / 8, 0.55, 1);
  parts.appeal = clamp(appeal);
  notes.appeal = c.depth === 'issue'
    ? c.articleCount + ' cover lines and a described issue'
    : c.depth === 'partial' ? 'some of this issue was readable' : 'nothing issue-specific was readable';

  /* ---- novelty: distance from what the user already likes ---- */
  const nov = t.centroidWeight ? 1 - cosine(t.centroid, rec.topicVec || {}) : null;
  parts.novelty = nov == null ? 0.5 : nov;
  notes.novelty = nov == null
    ? 'no taste recorded yet, so nothing is familiar or unfamiliar'
    : nov > 0.7 ? 'well outside what you have picked before'
    : nov > 0.4 ? 'adjacent to your usual subjects' : 'close to your usual subjects';

  /* ---- progression: is this the right SIZE of step right now ---- */
  // The stride is learned, never scheduled. A user whose accepted picks have
  // been drifting further out gets a wider target; one whose distant picks keep
  // being rejected gets a narrower one. Nothing here knows that cars come after
  // motorcycles — only that this user's last several steps were about this big.
  if (nov == null) {
    parts.progression = 0.5;
    notes.progression = 'nothing to progress from yet';
  } else {
    const target = t.progression.appetite;
    const tolerance = 0.22 + 0.18 * (1 - t.progression.confidence);
    parts.progression = clamp(1 - Math.abs(nov - target) / (tolerance * 3));
    notes.progression = 'step of ' + nov.toFixed(2) + ' against a learned ' +
      t.progression.stride + ' stride of ' + target.toFixed(2);
  }

  /* ---- value: price against what this user actually pays ---- */
  const inr = toInr(rec.price);
  const pricePref = t.scalars.price;
  if (inr == null) {
    parts.valueFit = 0.45;
    notes.valueFit = 'no price could be read — not penalised, but not credited either';
  } else if (!pricePref.known) {
    // With no purchase history there is no such thing as a good price, only a
    // cheap one. A mild preference for cheap is the least presumptuous thing
    // available, and it is stated as exactly that.
    parts.valueFit = clamp(1 - inr / 900);
    notes.valueFit = 'no spending history yet — cheaper scores slightly higher';
  } else {
    const over = inr - pricePref.mean;
    parts.valueFit = over <= 0 ? clamp(0.75 + (-over) / (pricePref.mean * 4))
                               : clamp(1 - over / Math.max(120, pricePref.mean * 1.6));
    notes.valueFit = fmtPrice(rec.price) + ' against your usual ₹' + Math.round(pricePref.mean);
  }
  if (rec.price && rec.price.confidence != null && rec.price.confidence < 0.6) {
    parts.valueFit *= 0.85;
    notes.valueFit += ' (price uncertain)';
  }

  /* ---- exploration value ---- */
  // Upper-confidence-bound in spirit: the less is known about a region of the
  // newsstand, the more a pick from it is worth beyond its expected value. Two
  // sources of ignorance count — topics with little evidence, and titles never
  // put in front of the user.
  const topicUncertainty = mean(Object.keys(rec.topics || {}).map(k => {
    const tp = t.topics[k];
    return tp ? 1 - tp.confidence : 1;
  })) || 1;
  const neverSeen = ctx.recommendedAt.has(rec.id) ? 0 : 1;
  parts.exploration = clamp(topicUncertainty * 0.7 + neverSeen * 0.3);
  notes.exploration = topicUncertainty > 0.7
    ? 'you have given almost no signal about these subjects'
    : 'these subjects are well covered by your history';

  /* ---- penalties from history ---- */
  const month = nowMonth();
  const lastRec = ctx.recommendedAt.get(rec.id);
  parts.recentTitle = lastRec == null ? 0 : clamp(1 - (month - lastRec) / 4);
  notes.recentTitle = lastRec == null ? 'never recommended before'
    : 'last recommended ' + (month - lastRec) + ' month(s) ago';

  const subjectAge = topEntries(rec.topics || {}, 3).map(([k]) => {
    const months = ctx.subjectMonths.get(k) || [];
    if (!months.length) return null;
    return month - Math.max(...months);
  }).filter(v => v != null);
  const cool = f.excludeRecentSubjects;
  parts.repetition = subjectAge.length && cool > 0
    ? clamp(1 - Math.min(...subjectAge) / Math.max(1, cool))
    : 0;
  notes.repetition = subjectAge.length
    ? 'you last read these subjects ' + Math.min(...subjectAge) + ' month(s) ago'
    : 'these subjects have not come up in your history';

  const bought = ctx.boughtByRecord.get(rec.id) || [];
  const read = ctx.readByRecord.get(rec.id) || [];
  const sameIss = iss.label && [].concat(bought, read).some(b => sameIssue(b.issueLabel, iss.label));
  parts.ownedIssue = sameIss ? 1 : 0;
  notes.ownedIssue = sameIss ? 'you already have this exact issue' : '';

  // Diversity is not computable in isolation — it depends on what else has been
  // chosen — so it is filled in during selection and left at zero here.
  parts.diversity = 0;
  notes.diversity = '';

  const base = sum(Object.entries(parts).map(([k, v]) => (WEIGHTS[k] || 0) * v));
  return { parts, notes, base, score: base, fit };
}

// How common a facet value is across everything discovered. A value carried by
// four magazines in five says nothing about anyone's taste, however much
// evidence has piled up behind it — and evidence piles up on exactly those
// values fastest, because they are on everything the user is ever shown.
//
// This was not a subtlety. A reader taught, with four purchases and three
// explicit "too text-heavy" rejections, to want highly visual easy reading was
// then handed a text-heavy business monthly: the two scalar terms were correctly
// at −1 each, and were outvoted by "likes Monthly", "likes English" and "likes
// adult", which between them described 80% of the newsstand.
let prevalenceCache = { size: -1, map: null };

function facetPrevalence() {
  if (prevalenceCache.size === state.magazines.size) return prevalenceCache.map;
  const map = { audience: {}, languages: {}, publishers: {}, frequency: {}, formats: {} };
  let total = 0;
  for (const rec of state.magazines.values()) {
    total++;
    const bump2 = (facet, key) => {
      if (key == null || key === '') return;
      map[facet][String(key)] = (map[facet][String(key)] || 0) + 1;
    };
    bump2('audience', rec.content && rec.content.audience);
    bump2('languages', rec.language);
    bump2('publishers', rec.publisher);
    bump2('frequency', rec.frequency && rec.frequency.label);
    for (const f of rec.formats || []) bump2('formats', f);
  }
  map.__total = Math.max(1, total);
  prevalenceCache = { size: state.magazines.size, map };
  return map;
}

// 1 for a value unique to one magazine, near 0 for one shared by nearly all.
function discriminativeness(facet, key) {
  const map = facetPrevalence();
  if (!map[facet]) return 1;
  const share = (map[facet][String(key)] || 0) / map.__total;
  return clamp(1 - Math.pow(share, 0.7), 0.05, 1);
}

// How well this magazine matches what has actually been learned. Returns a
// neutral 0.5 with an explicit "nothing learned" note when the model is empty,
// which is the correct answer at that point and not a hedge.
function preferenceFit(rec, t) {
  if (t.empty) {
    return { score: 0.5, note: 'nothing learned yet — this is not a personalised score', terms: [] };
  }
  const terms = [];
  let acc = 0, wsum = 0;

  // Topic utilities, weighted by how much of the issue each topic is and by how
  // much evidence stands behind the utility. A strong opinion from one skip
  // should not outweigh a mild one from four purchases.
  for (const [name, share] of Object.entries(rec.topics || {})) {
    const tp = t.topics[name];
    if (!tp || tp.muted) continue;
    const w = share * (0.35 + 0.65 * tp.confidence);
    acc += Math.tanh(tp.utility) * w;
    wsum += w;
    if (Math.abs(tp.utility) > 0.2) {
      terms.push({ kind: 'topic', name, utility: tp.utility, share, confidence: tp.confidence });
    }
  }

  const facetTerm = (facetName, key, weight) => {
    if (key == null) return;
    const fv = (t.facets[facetName] || {})[String(key)];
    if (!fv || fv.weight < 0.4) return;
    const disc = discriminativeness(facetName, key);
    const w = weight * (0.3 + 0.7 * fv.confidence) * disc;
    if (w < 0.02) return;
    acc += Math.tanh(fv.utility) * w;
    wsum += w;
    if (Math.abs(fv.utility) > 0.25 && disc > 0.3) {
      terms.push({ kind: 'facet', name: String(key), utility: fv.utility * disc, confidence: fv.confidence });
    }
  };
  const c = rec.content || {};
  // A publisher is a real, specific choice; a language and a cadence are mostly
  // background, and the damping above removes what is left of them when they
  // are near-universal.
  facetTerm('publishers', rec.publisher, 0.35);
  facetTerm('audience', c.audience, 0.3);
  facetTerm('languages', rec.language, 0.25);
  facetTerm('frequency', rec.frequency && rec.frequency.label, 0.15);

  // Scalar preferences as a gaussian around the learned mean, plus an explicit
  // repulsion from the mean of what has been rejected.
  const scalarTerm = (name, value, weight) => {
    const s = t.scalars[name];
    if (!s || !s.known || value == null) return;
    const sd = s.sd || 0.2;
    let v = Math.exp(-Math.pow(value - s.mean, 2) / (2 * sd * sd)) * 2 - 1;
    if (s.avoid != null) v -= Math.exp(-Math.pow(value - s.avoid, 2) / (2 * sd * sd)) * 0.6;
    const w = weight * (0.3 + 0.7 * s.confidence);
    acc += v * w;
    wsum += w;
    if (Math.abs(v) > 0.3) {
      terms.push({
        kind: 'scalar', value, target: s.mean, v,
        name: v > 0 ? 'the ' + s.label + ' you go for'
          : 'its ' + s.label + ' (you want ' + (name === 'price'
            ? '≈₹' + Math.round(s.mean) : Math.round(s.mean * 100) + '%') + ')',
      });
    }
  };
  // These carry more than the facets because they are the dimensions people
  // actually state an opinion about — every rejection reason in the list maps
  // onto one of them.
  scalarTerm('visualness', c.visualness, 0.9);
  scalarTerm('difficulty', c.difficulty, 0.8);
  scalarTerm('newsiness', c.newsiness, 0.8);
  scalarTerm('price', toInr(rec.price), 0.35);

  if (!wsum) {
    return { score: 0.5, note: 'nothing this magazine covers overlaps what has been learned so far', terms: [] };
  }
  const raw = acc / wsum;                 // roughly [-1, 1]
  const score = clamp((raw + 1) / 2);
  terms.sort((a, b) => Math.abs(b.utility ?? b.v) - Math.abs(a.utility ?? a.v));
  return { score, raw, note: describeFit(terms), terms: terms.slice(0, 6) };
}

function describeFit(terms) {
  if (!terms.length) return 'no strong signal either way';
  const pos = terms.filter(x => (x.utility ?? x.v) > 0).slice(0, 3);
  const neg = terms.filter(x => (x.utility ?? x.v) < 0).slice(0, 2);
  const bits = [];
  if (pos.length) bits.push('matches ' + pos.map(x => x.name).join(', '));
  if (neg.length) bits.push('but you have pushed back on ' + neg.map(x => x.name).join(', '));
  return bits.join(' ');
}

/* ------------------------------------------------------------- selection */
/* Scoring ranks candidates against the user. Selection ranks them against each
   other, which is where duplicate suppression and diversity live: the second
   pick is not the second-best magazine, it is the best magazine GIVEN the
   first.

   Two different overlap questions are kept apart, as the brief requires. Two
   magazines about the same subject is a diversity decision and is handled by
   the penalty below. One magazine that happens to share a few articles with
   another is a near-duplicate LISTING and is handled by the merge machinery in
   the duplicates section, not here. */

function selectShortlist(scored, t, f, count) {
  const chosen = [];
  const pool = scored.slice();

  // How hard to push for variety. Rising when the user has said "too similar",
  // and high by default when nothing is known — with an empty model, breadth is
  // the only responsible strategy, because it is the only one that does not
  // require having guessed something.
  const pressure = t.empty ? 1.5
    : clamp(0.6 + t.diversityPressure * 0.25 + (1 - t.progression.confidence) * 0.3, 0.4, 1.6);

  while (chosen.length < count && pool.length) {
    let bestIdx = -1, bestScore = -Infinity, bestPenalty = null;

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let worst = 0, worstAgainst = null;
      for (const already of chosen) {
        const sim = cosine(cand.rec.topicVec || {}, already.rec.topicVec || {});
        if (sim > worst) { worst = sim; worstAgainst = already; }
      }
      // Below the tolerance, overlap costs nothing at all; above it the cost
      // rises steeply, so two genuinely different magazines are never punished
      // for sharing one subject while two interchangeable ones are.
      const over = Math.max(0, worst - f.overlapTolerance) / Math.max(0.05, 1 - f.overlapTolerance);
      const penalty = WEIGHTS.diversity * pressure * over;

      // Title-level variety too: the same publisher three times in a shortlist
      // reads as a rut even when the subjects differ.
      const samePub = chosen.filter(x => x.rec.publisher && x.rec.publisher === cand.rec.publisher).length;
      const pubPenalty = samePub * 0.35;

      const s = cand.base - penalty - pubPenalty;
      if (s > bestScore) {
        bestScore = s; bestIdx = i;
        bestPenalty = { overlap: worst, against: worstAgainst, penalty: penalty + pubPenalty, samePub };
      }
    }
    if (bestIdx < 0) break;
    const pick = pool.splice(bestIdx, 1)[0];
    pick.score = bestScore;
    pick.parts.diversity = -(bestPenalty.penalty / Math.max(0.001, WEIGHTS.diversity));
    pick.notes.diversity = bestPenalty.against
      ? 'closest to ' + bestPenalty.against.rec.title + ' at ' + bestPenalty.overlap.toFixed(2) + ' similarity'
      : 'first pick — nothing to overlap with';
    pick.overlap = bestPenalty;
    chosen.push(pick);
  }
  return chosen;
}

/* ---------------------------------------------------------- exploration  */
/* Controlled, labelled, and never disguised. An exploratory pick has to clear
   the same hard filters and the same availability and freshness bars as any
   other — it is a real suggestion, not a wildcard — and it is presented as
   "outside your usual" rather than dressed up as an obvious match. */

function pickExploration(scored, chosen, t, f) {
  const rate = t.empty ? 0 : state.meta.exploreRate / 100;
  if (rate <= 0) return null;

  // Deterministic per month, so the exploratory slot does not shuffle every
  // time the page is re-rendered. It should feel like a choice, not a dice roll.
  const rnd = seededRand('explore:' + nowMonth() + ':' + state.events.length);
  const appetiteAdjusted = rate * (0.5 + t.progression.appetite);
  if (rnd() > appetiteAdjusted) return null;

  const chosenIds = new Set(chosen.map(c => c.rec.id));
  const pool = scored.filter(c =>
    !chosenIds.has(c.rec.id)
    && c.parts.novelty > 0.55
    && c.parts.availability >= 0.7
    && c.parts.freshness >= 0.45
    && c.parts.appeal >= 0.5
    && c.parts.ownedIssue === 0);

  if (!pool.length) return null;
  // Best quality among the genuinely unfamiliar, rather than the most
  // unfamiliar thing available — novelty without quality is just noise.
  pool.sort((a, b) =>
    (b.parts.appeal + b.parts.freshness + b.parts.availability + b.parts.exploration * 0.6)
    - (a.parts.appeal + a.parts.freshness + a.parts.availability + a.parts.exploration * 0.6));
  const pick = pool[0];
  pick.exploratory = true;
  pick.exploreReason = 'Outside your usual subjects — offered deliberately. It clears every filter you set, '
    + 'the issue is ' + (pick.rec.issue.band) + ' and it is ' + Math.round(pick.parts.novelty * 100)
    + '% away from what you have picked before.';
  return pick;
}

/* ------------------------------------------------------------ the ranking */

function rankAll(opts = {}) {
  const f = state.filters || defaultFilters();
  const t = taste();
  const ctx = historyContext();
  const month = nowMonth();

  const eligible = [];
  const excluded = [];

  for (const rec of state.magazines.values()) {
    // A title nobody has read a detail page for is not a candidate — it has no
    // issue, no price and no content. It is a lead, not an offer, and the
    // Research view counts it as exactly that.
    if (!rec.observations.some(o => o.issueLabel || (o.toc && o.toc.length) || o.offers.length)) {
      excluded.push({ rec, fails: [{ filter: 'not yet researched', reason: 'no issue page has been read for this title' }] });
      continue;
    }
    const verdict = evaluateFilters(rec, f);
    const histFails = historyGate(rec, f, ctx);
    const fails = verdict.fails.concat(histFails);
    if (fails.length) { excluded.push({ rec, fails }); continue; }
    eligible.push(rec);
  }

  const scored = eligible.map(rec => {
    const s = scoreCandidate(rec, t, ctx, f);
    return { rec, ...s };
  }).sort((a, b) => b.base - a.base);

  const shortlistSize = opts.size || 6;
  let chosen = selectShortlist(scored, t, f, shortlistSize);

  const explorePick = pickExploration(scored, chosen, t, f);
  if (explorePick) {
    // The exploratory pick goes into the shortlist, never into the primary
    // slot: the headline answer to "what should I buy this month" should be the
    // app's best judgement, not its most interesting gamble.
    chosen = chosen.slice(0, shortlistSize - 1);
    chosen.push(explorePick);
  }

  const primary = chosen[0] || null;
  const alternatives = chosen.slice(1);

  // Why the top one beat the second — computed as the components where they
  // most differ, so the explanation is derived rather than written.
  if (primary && alternatives.length) {
    primary.beats = comparison(primary, alternatives[0]);
  }
  for (let i = 0; i < alternatives.length; i++) {
    const prev = i === 0 ? primary : alternatives[i - 1];
    if (prev) alternatives[i].below = comparison(prev, alternatives[i]);
  }

  return { primary, alternatives, chosen, scored, excluded, t, ctx, f, month };
}

function comparison(better, worse) {
  const diffs = Object.keys(WEIGHTS).map(k => ({
    part: k,
    delta: ((better.parts[k] || 0) - (worse.parts[k] || 0)) * (WEIGHTS[k] || 0),
  })).filter(d => Math.abs(d.delta) > 0.03)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const label = {
    availability: 'is easier to actually buy',
    freshness: 'has a more confidently current issue',
    prefFit: 'fits your recorded tastes better',
    appeal: 'has a stronger issue in front of it',
    novelty: 'is less like what you have already read',
    progression: 'is the right size of step from your last picks',
    valueFit: 'is better value at its price',
    exploration: 'covers ground you have said least about',
    diversity: 'adds more variety to the shortlist',
    repetition: 'repeats your recent subjects less',
    recentTitle: 'has not been recommended as recently',
    ownedIssue: 'is not an issue you already have',
  };
  return {
    against: worse.rec.title,
    reasons: diffs.slice(0, 3).map(d => ({
      part: d.part,
      delta: d.delta,
      text: (d.delta > 0 ? '' : worse.rec.title + ' ') + (label[d.part] || d.part),
      favours: d.delta > 0 ? 'better' : 'worse',
    })),
    diffs,
  };
}

/* ------------------------------------------------------- the monthly cycle */
/* Recomputed from whatever is currently known, every month, with no memory of
   what last month decided beyond the history that should influence it. There is
   no stored schedule to repeat, because a schedule made in August cannot know
   that September's issue is a rerun or that the title has gone out of print. */

function currentCycle() {
  const month = nowMonth();
  const key = String(month);
  const stored = state.meta.cycles[key];
  // Counting only events the model actually learns from. Including views made
  // the cache turn over on every render, and since a re-rank re-reads the taste
  // model, the headline pick changed each time the page was drawn.
  const rankKey = [
    month, state.events.reduce((a, e) => a + (e.kind === 'view' ? 0 : 1), 0), state.magazines.size,
    JSON.stringify(state.filters), JSON.stringify(state.overrides),
    state.meta.exploreRate,
  ].join('|');

  if (state.ranked && state.rankKey === rankKey) return state.ranked;

  const ranking = rankAll();
  state.ranked = ranking;
  state.rankKey = rankKey;

  // The cycle record is written so that NEXT month knows what was shown this
  // month. It is not a cached answer: this month's ranking is recomputed above
  // every time anything it depends on changes.
  state.meta.cycles[key] = {
    at: Date.now(),
    picked: ranking.primary ? [ranking.primary.rec.id] : [],
    shortlist: ranking.alternatives.map(a => a.rec.id),
    stored: stored ? stored.at : null,
  };
  scheduleSave();
  return ranking;
}

/* ============================================================== discovery */
/* The refresh. Three stages, deliberately separated because they have wildly
   different costs: enumerating what exists is one cheap fetch, reading what is
   in a given issue is one fetch per title, and there are ten thousand titles.

   So the budget is the design. A refresh cannot read every magazine on the
   Indian newsstand and pretending otherwise would either take three hours or
   quietly read almost nothing. Instead it spends a fixed number of page reads
   on the titles where a read changes the answer: the ones currently being
   recommended, the ones whose information has gone stale on their own
   publication cycle, and a spread of never-seen titles chosen to widen coverage
   rather than deepen it. Coverage therefore grows month over month, and the
   Research view says exactly how far it has got.                              */

// Leads are titles known to exist but not yet read. Kept apart from records
// because a lead costs about 120 bytes and a record costs a content analysis;
// promoting every sitemap entry to a record would mean analysing ten thousand
// magazines about which nothing whatsoever is known.
function leadId(stub) { return stub.sourceId + ':' + hash(stub.url); }

function mergeLeads(stubs, sourceId) {
  const byId = new Map(state.leads.map(l => [l.id, l]));
  let added = 0;
  for (const s of stubs) {
    const id = leadId(s);
    const existing = byId.get(id);
    if (existing) {
      existing.title = existing.title || s.title;
      existing.category = existing.category || s.category;
      existing.publisher = existing.publisher || s.publisher;
      existing.seenAt = Date.now();
      continue;
    }
    byId.set(id, { ...s, id, order: s.order ?? 1e6, discoveredAt: Date.now(), seenAt: Date.now(), detailAt: 0, fails: 0 });
    added++;
  }
  state.leads = Array.from(byId.values());
  bump('leads:' + sourceId, added);
  return added;
}

// Which leads are worth a page read this month, in priority order. The three
// bands are not a heuristic bolted on afterwards — they are the reason the app
// can claim to be current at all on a budget.
function planFetches(budget) {
  const now = Date.now();
  const f = state.filters || defaultFilters();
  const recommended = new Set();
  const cyc = state.meta.cycles[String(nowMonth())];
  if (cyc) for (const id of [].concat(cyc.picked || [], cyc.shortlist || [])) recommended.add(id);
  const lastCyc = state.meta.cycles[String(nowMonth() - 1)];
  if (lastCyc) for (const id of [].concat(lastCyc.picked || [], lastCyc.shortlist || [])) recommended.add(id);

  const urlToRecord = new Map();
  for (const rec of state.magazines.values()) for (const u of rec.urls || []) urlToRecord.set(u, rec);

  const hot = [], stale = [], fresh = [];

  for (const lead of state.leads) {
    if (lead.fails >= 3) continue;
    const rec = urlToRecord.get(lead.url);

    if (!lead.detailAt) { fresh.push(lead); continue; }

    // Staleness is measured in publication cycles, not days. A four-week-old
    // reading of a quarterly is current; the same reading of a weekly is four
    // issues out of date.
    const cycleDays = (rec && rec.frequency && rec.frequency.days) || 30;
    const ageCycles = (now - lead.detailAt) / 864e5 / cycleDays;
    if (rec && recommended.has(rec.id)) { hot.push({ lead, ageCycles, rec }); continue; }
    if (ageCycles >= 0.8) stale.push({ lead, ageCycles, rec });
  }

  hot.sort((a, b) => b.ageCycles - a.ageCycles);
  stale.sort((a, b) => b.ageCycles - a.ageCycles);

  // Never-read titles, sampled for BREADTH. Taking the first N of the sitemap
  // would read four thousand academic journals and never reach the car
  // magazines; round-robin over categories reaches every shelf on the newsstand
  // within one refresh. Where the user has asked for particular topics, those
  // shelves go first — that is a filter, not a learned taste.
  const byCat = new Map();
  for (const lead of fresh) {
    const cat = (lead.category || 'unfiled').toLowerCase();
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(lead);
  }
  // Established titles first within each shelf, with a small deterministic
  // wobble so that repeated refreshes do not grind through the same hundred
  // entries and never reach the rest.
  const rnd = seededRand('plan:' + nowMonth() + ':' + state.leads.length);
  for (const arr of byCat.values()) {
    for (const l of arr) l._j = (l.order ?? 1e6) + rnd() * 120;
    arr.sort((a, b) => a._j - b._j);
  }

  const wanted = f.topicsWanted.map(t => t.toLowerCase());
  const cats = Array.from(byCat.keys()).sort((a, b) => {
    const aw = wanted.some(w => a.includes(w) || w.includes(a)) ? 1 : 0;
    const bw = wanted.some(w => b.includes(w) || w.includes(b)) ? 1 : 0;
    if (aw !== bw) return bw - aw;
    // Academic is 44% of the Magzter India store and almost none of it is a
    // magazine anyone buys off a shelf, so it goes last when it is not hidden
    // outright.
    if (/academic|journal/.test(a) !== /academic|journal/.test(b)) return /academic|journal/.test(a) ? 1 : -1;
    return (byCat.get(b).length - byCat.get(a).length);
  });
  // Shelves the filters have ruled out are not worth a single fetch.
  if (f.kinds && f.kinds.length && !f.kinds.includes('journal')) {
    for (const c of cats.slice()) if (/academic|journal/.test(c)) cats.splice(cats.indexOf(c), 1);
  }
  if (f.kinds && f.kinds.length && !f.kinds.includes('newspaper')) {
    for (const c of cats.slice()) if (/newspaper/.test(c)) cats.splice(cats.indexOf(c), 1);
  }

  const breadth = [];
  let ci = 0;
  while (breadth.length < budget && cats.length) {
    const cat = cats[ci % cats.length];
    const arr = byCat.get(cat);
    if (arr && arr.length) breadth.push(arr.shift());
    else { cats.splice(ci % cats.length, 1); continue; }
    ci++;
  }

  // Split of the budget. Verification of what is on screen comes first because
  // a wrong headline recommendation is the worst failure this app has; then
  // staleness; the rest goes on widening the map.
  const hotN = Math.min(hot.length, Math.ceil(budget * 0.25));
  const staleN = Math.min(stale.length, Math.ceil(budget * 0.35));
  const breadthN = Math.max(0, budget - hotN - staleN);

  return {
    plan: [].concat(
      hot.slice(0, hotN).map(x => ({ ...x.lead, hot: true, why: 'currently recommended' })),
      stale.slice(0, staleN).map(x => ({ ...x.lead, why: 'reading is ' + x.ageCycles.toFixed(1) + ' cycles old' })),
      breadth.slice(0, breadthN).map(x => ({ ...x, why: 'never read' })),
    ),
    counts: { hot: hotN, stale: staleN, breadth: breadthN, leads: state.leads.length, fresh: fresh.length },
  };
}

// Targeted web search. Two jobs the sitemaps cannot do: reaching titles that
// launched after a sitemap was last regenerated, and reaching print-only
// magazines that no digital newsstand lists at all.
function searchQueries() {
  const f = state.filters || defaultFilters();
  const d = new Date();
  const mon = MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  const qs = [
    'site:magzter.com/IN new magazine ' + mon,
    'Indian magazine ' + mon + ' issue buy online',
  ];
  for (const topic of f.topicsWanted.slice(0, 4)) {
    qs.push('site:magzter.com/IN ' + topic + ' magazine');
    qs.push(topic + ' magazine India ' + mon + ' issue price');
  }
  if (f.format === 'print') {
    qs.push('buy print magazine India ' + mon + ' single issue');
  }
  return qs.slice(0, 8);
}

let refreshing = false;

async function runRefresh(opts = {}) {
  if (refreshing) return;
  refreshing = true;
  state.abort = false;
  state.busy = true;
  const budget = opts.budget || state.meta.budget || DEFAULT_BUDGET;
  const started = Date.now();
  let done = 0, total = budget + 4;

  const setProgress = (msg, extra = 0) => {
    const pct = clamp((done + extra) / total) * 100;
    $('#progress').hidden = false;
    $('#progress .bar i').style.width = pct.toFixed(1) + '%';
    $('#progressText').textContent = msg;
  };
  $('#btnRefresh').hidden = true;
  $('#btnStop').hidden = false;

  const note = msg => { setProgress(msg); logResearch({ kind: 'stage', note: msg }); };

  try {
    /* ---- stage 1: what exists ---- */
    note('Reading the India newsstand index…');
    const uni = await MAGZTER.universe({ note });
    done++;
    if (uni.stubs.length) {
      const added = mergeLeads(uni.stubs, 'magzter');
      state.meta.universeAt = uni.at;
      state.meta.universePublished = uni.published;
      note('Magzter: ' + uni.stubs.length + ' titles on sale in India (' + added + ' new)');
    } else {
      note('Magzter index unavailable — ' + (uni.error || 'no response'));
      state.meta.universeError = uni.error;
    }
    done++;

    if (!state.abort) {
      const rw = await READWHERE.universe({ note });
      if (rw.stubs.length) {
        const added = mergeLeads(rw.stubs, 'readwhere');
        note('Readwhere: ' + rw.stubs.length + ' titles (' + added + ' new)');
      }
      done++;
    }

    /* ---- stage 2: open-ended search ---- */
    if (!state.abort && !opts.skipSearch) {
      const queries = searchQueries();
      let found = 0;
      for (const q of queries) {
        if (state.abort) break;
        setProgress('Searching: ' + q);
        const res = await WEBSEARCH.search(q);
        for (const r of res.results || []) {
          const cls = WEBSEARCH.classify(r.url);
          if (cls.connector !== 'magzter') continue;
          const m = /\/IN\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(new URL(r.url).pathname);
          if (!m) continue;
          const stub = {
            sourceId: 'magzter',
            url: 'https://www.magzter.com/IN/' + m[1] + '/' + m[2] + '/' + m[3] + '/',
            title: unslug(m[2]), publisher: unslug(m[1]), category: unslug(m[3]),
            region: 'IN', formats: ['digital'], viaSearch: q,
          };
          found += mergeLeads([stub], 'websearch');
        }
      }
      if (found) note('Web search turned up ' + found + ' title(s) the index did not list');
      done++;
    }

    /* ---- stage 3: read the issues ---- */
    const { plan, counts } = planFetches(budget);
    total = done + plan.length + 1;
    state.meta.lastPlan = counts;
    note('Reading ' + plan.length + ' issue pages (' + counts.hot + ' to verify, '
      + counts.stale + ' stale, ' + counts.breadth + ' new)');

    for (const lead of plan) {
      if (state.abort) break;
      const connector = CONNECTORS[lead.sourceId] || CONNECTORS.magzter;
      setProgress('(' + (done - 4) + '/' + plan.length + ') ' + (lead.title || lead.url));
      let obs;
      try {
        obs = await connector.detail(lead);
      } catch (err) {
        obs = blankObservation(connector, lead.url);
        obs.problems.push('connector threw: ' + (err && err.message));
      }
      done++;

      const stored = state.leads.find(l => l.id === lead.id);
      if (stored) {
        stored.detailAt = Date.now();
        stored.lastResult = obs.availability;
        if (obs.availability === 'gone' || (!obs.issueLabel && !obs.toc.length)) stored.fails = (stored.fails || 0) + 1;
        else stored.fails = 0;
      }

      if (obs.availability === 'gone' && !obs.title) continue;
      const rec = upsertObservation(obs, lead);
      if (stored) stored.recordId = rec.id;
    }

    /* ---- settle ---- */
    dfCache.size = -1;                 // topic frequencies moved; force a rebuild
  prevalenceCache.size = -1;         // and so did facet prevalence
    for (const rec of state.magazines.values()) rebuildRecord(rec);
    autoMerge();
    state.ranked = null;
    tasteCache.key = '';
    state.meta.lastRefresh = Date.now();
    state.meta.lastRefreshMonth = nowMonth();
    state.meta.lastRefreshSeconds = Math.round((Date.now() - started) / 1000);
    await saveState();
    note(state.abort ? 'Stopped.' : 'Done in ' + state.meta.lastRefreshSeconds + 's');
  } finally {
    refreshing = false;
    state.busy = false;
    $('#btnRefresh').hidden = false;
    $('#btnStop').hidden = true;
    setTimeout(() => { $('#progress').hidden = true; }, 2200);
    render();
  }
}

// Duplicates that are beyond argument get merged without asking: the same
// Magzter title id, or an identical normalised title from the same publisher.
// Everything less certain than that is offered in Research for a human to
// decide, because a wrong automatic merge destroys two records' history and is
// far more expensive than a duplicate left standing.
function autoMerge() {
  for (const pair of duplicateCandidates()) {
    if (pair.verdict === 'same') continue;
    const samePub = pair.a.publisher && pair.b.publisher
      && canonTitle(pair.a.publisher) === canonTitle(pair.b.publisher);
    if (pair.score >= 1 && samePub) {
      mergeRecords(pair.a.id, pair.b.id);
      logResearch({ kind: 'merge', note: 'auto-merged "' + pair.a.title + '" with "' + pair.b.title + '"' });
    }
  }
}

/* ==================================================================== ui  */

// Every option list in the filter deck is built from what has actually been
// discovered. There is no hardcoded list of topics or languages to choose from,
// because a fixed list would be a statement about what magazines exist — and
// that statement is exactly what discovery is for.
function corpusFacets() {
  const topics = new Map(), languages = new Map(), freqs = new Map(), cats = new Map();
  for (const rec of state.magazines.values()) {
    for (const [t, w] of Object.entries(rec.topics || {})) {
      if (w >= 0.05) topics.set(t, (topics.get(t) || 0) + 1);
    }
    if (rec.language) languages.set(rec.language, (languages.get(rec.language) || 0) + 1);
    const fl = rec.frequency && rec.frequency.label;
    if (fl) freqs.set(fl, (freqs.get(fl) || 0) + 1);
    if (rec.category) cats.set(rec.category, (cats.get(rec.category) || 0) + 1);
  }
  const sorted = m => Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  return { topics: sorted(topics), languages: sorted(languages), freqs: sorted(freqs), cats: sorted(cats) };
}

function coverNode(rec, opts = {}) {
  const box = el('div', { class: 'coverBox' });
  if (rec.coverUrl) {
    const img = el('img', {
      src: rec.coverUrl, alt: rec.title + ' cover', loading: 'lazy',
      onerror: e => { e.target.replaceWith(missingCover(rec, 'the cover image would not load')); },
    });
    box.append(img);
  } else {
    box.append(missingCover(rec, 'no cover image was published for this issue'));
  }
  if (opts.caption) box.append(el('div', { class: 'muted small', style: 'margin-top:6px' }, opts.caption));
  return box;
}

// A missing cover is a normal outcome, not an error state, and it is labelled
// with WHY it is missing so that "no cover" and "cover failed to load" are not
// the same box.
function missingCover(rec, why) {
  return el('div', { class: 'coverMissing' },
    el('b', {}, rec.title),
    el('span', {}, (rec.issue && rec.issue.label) || 'issue unknown'),
    el('span', { class: 'muted' }, why));
}

function topicChips(topics, opts = {}) {
  const wrap = el('div', { class: 'chipWrap' });
  const entries = topEntries(topics || {}, opts.limit || 7);
  if (!entries.length) {
    wrap.append(el('span', { class: 'muted small' }, 'no topics could be derived from this issue'));
    return wrap;
  }
  for (const [name, w] of entries) {
    wrap.append(el('span', {
      class: 'topic' + (w >= 0.18 ? ' strong' : '') + (SUBJECT_NAMES.has(name) ? '' : ' mined'),
      title: SUBJECT_NAMES.has(name)
        ? Math.round(w * 100) + '% of this issue indexes as ' + name
        : '"' + name + '" was mined from this issue’s cover lines, not from a fixed list',
    }, name, el('i', {}, Math.round(w * 100) + '%')));
  }
  return wrap;
}
const SUBJECT_NAMES = new Set(SUBJECTS.map(s => s[0]));

function confidenceFact(rec) {
  const iss = rec.issue || {};
  const cls = iss.band === 'verified' ? 'good' : iss.band === 'likely' ? '' :
              iss.band === 'uncertain' ? 'warn' : 'bad';
  const text = {
    verified: 'Confirmed current issue',
    likely: 'Probably the current issue',
    uncertain: 'Current issue uncertain',
    unknown: 'Current issue unknown',
  }[iss.band] || 'Current issue unknown';
  return el('span', {
    class: 'fact ' + cls,
    title: (iss.reasons || []).join('\n'),
  }, text, ' ', el('b', {}, Math.round((iss.confidence || 0) * 100) + '%'));
}

function factRow(rec) {
  const c = rec.content || {};
  const row = el('div', { class: 'factRow' });

  const price = rec.price || {};
  const priceCls = price.basis === 'single-issue' && price.confidence > 0.8 ? ''
    : price.basis === 'none' ? 'warn' : 'warn';
  row.append(el('span', { class: 'fact ' + priceCls, title: price.note || '' },
    price.amount == null ? 'Price unknown' : el('b', {}, fmtPrice(price)),
    price.amount != null && price.basis !== 'single-issue' ? ' per issue (derived)' : ''));

  row.append(el('span', { class: 'fact' }, (rec.formats || []).length
    ? (rec.formats.map(f => f[0].toUpperCase() + f.slice(1)).join(' + '))
    : 'Format unknown'));

  if (rec.frequency && rec.frequency.label) row.append(el('span', { class: 'fact' }, rec.frequency.label));
  if (rec.language) row.append(el('span', { class: 'fact' }, rec.language));
  if (c.audience) row.append(el('span', { class: 'fact', title: c.audienceWhy || '' }, audienceWord(c.audience)));
  if (c.visualness != null) {
    row.append(el('span', {
      class: 'fact' + (c.visualConfidence < 0.25 ? ' warn' : ''),
      title: 'How this was judged: ' + (c.visualBasis || 'unknown'),
    }, visualWord(c.visualness), c.visualConfidence < 0.25 ? el('b', {}, ' ?') : ''));
  }
  if (c.difficulty != null) row.append(el('span', { class: 'fact' }, difficultyWord(c.difficulty) + ' read'));
  if (c.newsiness != null) row.append(el('span', {
    class: 'fact' + (c.newsiness > 0.55 ? ' warn' : ''),
  }, newsWord(c.newsiness)));
  row.append(confidenceFact(rec));
  return row;
}

function actionRow(cand, opts = {}) {
  const rec = cand.rec;
  const row = el('div', { class: 'actions' });
  row.append(el('button', { class: 'primary', onclick: () => openBuy(rec) }, 'I bought this'));
  row.append(el('button', { onclick: () => { recordEvent('like', rec); toast('Noted — more like this'); render(); } }, '👍 Like'));
  row.append(el('button', { onclick: () => { recordEvent('dislike', rec); toast('Noted'); render(); } }, '👎 Dislike'));
  row.append(el('button', { onclick: () => openReject(rec, 'notInterested') }, 'Not interested'));
  row.append(el('button', { onclick: () => { recordEvent('alreadyRead', rec); toast('Marked as already read'); render(); } }, 'Already read'));
  row.append(el('button', { class: 'ghost', onclick: () => openDetail(rec, cand) }, 'Details & sources'));
  if (!opts.noSkip) {
    row.append(el('button', { class: 'ghost', onclick: () => openReject(rec, 'skip') }, 'Skip this month'));
  }
  row.append(ratingWidget(rec));
  return row;
}

function ratingWidget(rec) {
  const wrap = el('span', { class: 'chipWrap', style: 'align-items:center;gap:4px' });
  wrap.append(el('span', { class: 'muted small', style: 'margin-right:2px' }, 'Rate:'));
  const existing = state.events.filter(e => e.kind === 'rate' && e.recordId === rec.id).slice(-1)[0];
  for (let i = 1; i <= 5; i++) {
    wrap.append(el('button', {
      class: 'tiny' + (existing && existing.rating >= i ? ' primary' : ' ghost'),
      title: i + ' of 5',
      onclick: () => {
        recordEvent('rate', rec, { rating: i });
        toast('Rated ' + i + '/5 — this is weighted heavily');
        render();
      },
    }, String(i)));
  }
  return wrap;
}

/* --------------------------------------------------------- the month view */

function viewMonth() {
  const main = $('#main');
  main.replaceChildren();

  if (!state.magazines.size) {
    main.append(emptyState());
    return;
  }

  const r = currentCycle();
  const t = r.t;

  main.append(el('h2', { class: 'sec' }, 'Which magazine should I buy this month?'));

  if (!r.primary) {
    main.append(el('div', { class: 'empty' },
      el('h3', {}, 'Nothing clears your filters this month'),
      el('p', {}, r.excluded.length + ' discovered titles were all excluded. The commonest reasons are '
        + 'listed in Research → Exclusions. Loosening the price ceiling or the current-issue '
        + 'confidence floor usually reopens the field.'),
      el('button', { class: 'primary', onclick: () => toggleDeck(true) }, 'Open filters')));
    return;
  }

  main.append(pickCard(r.primary, r));

  if (t.empty) {
    main.append(el('div', { class: 'panel', style: 'margin-top:14px' },
      el('h3', {}, 'This is not a personalised recommendation yet'),
      el('p', {}, 'MagLens has recorded nothing about your tastes, so it has not pretended to have any. '
        + 'The shortlist below is chosen for BREADTH — the widest spread of subjects, formats and reading '
        + 'levels that clears the filters you set — rather than for fit. Buy something, rate something, or '
        + 'say what you are not interested in, and the next month’s ranking will be built on that instead.')));
  }

  if (r.alternatives.length) {
    main.append(el('h2', { class: 'sec' }, t.empty ? 'Also on the shelf' : 'Ranked alternatives'));
    const grid = el('div', { class: 'grid' });
    r.alternatives.forEach((c, i) => grid.append(rankCard(c, i + 2)));
    main.append(grid);
  }

  main.append(el('h2', { class: 'sec' }, 'How this month was worked out'));
  main.append(cycleSummary(r));
}

function pickCard(cand, r) {
  const rec = cand.rec;
  const card = el('div', { class: 'pick' + (cand.exploratory ? ' exploratory' : '') });

  card.append(el('div', { class: 'pickCover' }, coverNode(rec)));

  const main = el('div', { class: 'pickMain' });
  main.append(el('div', { class: 'kicker' },
    cand.exploratory ? 'Exploratory pick — outside your usual' : 'This month’s pick'));
  main.append(el('h1', {}, rec.title));
  main.append(el('div', { class: 'pickIssue' },
    (rec.issue && rec.issue.label) || 'issue not identified',
    rec.publisher ? ' · ' + rec.publisher : ''));
  main.append(factRow(rec));
  main.append(topicChips(rec.topics));
  main.append(el('p', { class: 'blurb' }, rec.content.summary.text));
  main.append(el('div', { class: 'muted small' }, 'Issue description from ' + rec.content.summary.basis + '.'));

  main.append(whyBox(cand, r));
  main.append(whereBox(rec));
  if (rec.problems.length) main.append(uncertaintyBox(rec));
  main.append(actionRow(cand));

  card.append(main);
  // Being shown a recommendation is itself a weak signal, and it is recorded as
  // one — but only once per issue, so leaving the tab open does not train
  // anything.
  markViewed(rec);
  return card;
}

const viewedThisSession = new Set();
function markViewed(rec) {
  const key = rec.id + '|' + ((rec.issue && rec.issue.label) || '');
  if (viewedThisSession.has(key)) return;
  viewedThisSession.add(key);
  const already = state.events.some(e => e.kind === 'view' && e.recordId === rec.id
    && sameIssue(e.issueLabel, rec.issue && rec.issue.label));
  if (!already) recordEvent('view', rec);
}

function whyBox(cand, r) {
  const box = el('div', { class: 'why' });
  box.append(el('h4', {}, 'Why this one'));
  const ul = el('ul', {});

  const t = r.t;
  if (t.empty) {
    ul.append(el('li', {}, 'You have not taught it anything yet, so this is ',
      el('b', {}, 'not'), ' a taste match — it is the strongest available issue that clears your filters.'));
  } else {
    ul.append(el('li', {}, el('b', {}, 'Fits your tastes: '), cand.fit.note || 'no strong signal either way',
      ' (', Math.round(cand.parts.prefFit * 100), '%)'));
  }

  ul.append(el('li', {}, el('b', {}, 'Current issue: '), cand.notes.freshness));
  ul.append(el('li', {}, el('b', {}, 'Availability: '), cand.notes.availability));
  ul.append(el('li', {}, el('b', {}, 'Price: '), cand.notes.valueFit));
  if (cand.parts.repetition > 0.3) {
    ul.append(el('li', {}, el('b', {}, 'Repetition: '), cand.notes.repetition,
      ' — this counted against it and it still came top.'));
  }
  if (!t.empty && cand.parts.progression != null) {
    ul.append(el('li', {}, el('b', {}, 'Step size: '), cand.notes.progression));
  }
  if (cand.exploratory) ul.append(el('li', {}, el('b', {}, 'Exploratory: '), cand.exploreReason));
  box.append(ul);

  if (cand.beats) {
    box.append(el('h4', {}, 'Why it ranks above ' + cand.beats.against));
    const ul2 = el('ul', {});
    for (const rsn of cand.beats.reasons) {
      ul2.append(el('li', {}, rsn.text, ' ',
        el('span', { class: 'muted mono' }, (rsn.delta > 0 ? '+' : '') + rsn.delta.toFixed(2))));
    }
    if (!cand.beats.reasons.length) {
      ul2.append(el('li', {}, 'The two are within a rounding error of each other — either would do.'));
    }
    box.append(ul2);
  }
  return box;
}

function whereBox(rec) {
  const box = el('div', { class: 'why' });
  box.append(el('h4', {}, 'Where to get it'));
  if (!rec.offers.length) {
    box.append(el('p', { class: 'muted small' },
      'No purchase option was readable. The title is listed at ' +
      (rec.urls || []).length + ' source(s) — open Details to follow them.'));
    return box;
  }
  const list = el('div', { class: 'srcList' });
  for (const o of rec.offers.slice(0, 5)) {
    list.append(el('div', { class: 'srcRow' },
      el('div', {},
        el('a', { href: o.sourceUrl || o.url, target: '_blank', rel: 'noopener' }, o.seller),
        ' — ', el('b', {}, fmtPrice(o)),
        o.kind === 'single' ? ' for this issue' : ' for ' + o.issues + ' issues',
        o.storeRegion && o.storeRegion !== 'IN'
          ? el('span', { class: 'muted' }, ' · read from the ' + o.storeRegion + ' store')
          : null,
        o.inferred ? el('span', { class: 'muted' }, ' · inferred') : null),
      el('span', { class: 'when' }, ago(o.at))));
  }
  box.append(list);
  return box;
}

// Uncertainty is shown, never smoothed over. Everything a source could not
// establish is listed here rather than being allowed to look like a fact.
function uncertaintyBox(rec) {
  const box = el('div', { class: 'why' });
  box.append(el('h4', {}, 'What could not be established'));
  const ul = el('ul', {});
  for (const p of rec.problems.slice(0, 6)) ul.append(el('li', { class: 'muted' }, p));
  for (const c of rec.conflicts || []) {
    ul.append(el('li', { class: 'muted' }, 'Sources disagree on ' + c.field + ': ' + c.values.join(' vs ')));
  }
  box.append(ul);
  return box;
}

function rankCard(cand, n) {
  const rec = cand.rec;
  const card = el('div', { class: 'card' + (cand.exploratory ? ' exploratory' : '') });
  card.append(coverNode(rec));
  const body = el('div', {});
  body.append(el('div', { class: 'chipWrap', style: 'margin-bottom:6px' },
    el('span', { class: 'rankNo' }, '#' + n),
    cand.exploratory ? el('span', { class: 'fact', style: 'border-color:#4b3f7a;color:#b7a9ff' }, 'Exploratory') : null));
  body.append(el('h3', {}, rec.title));
  body.append(el('div', { class: 'sub' },
    ((rec.issue && rec.issue.label) || 'issue unknown')
    + ' · ' + (rec.price.amount == null ? 'price unknown' : fmtPrice(rec.price))
    + ' · ' + ((rec.formats || []).join('/') || 'format unknown')));
  body.append(topicChips(rec.topics, { limit: 4 }));
  body.append(el('div', { class: 'muted small', style: 'margin-top:8px' },
    cand.exploratory ? cand.exploreReason
      : (cand.below ? 'Below #' + (n - 1) + ': ' + (cand.below.reasons[0] ? cand.below.reasons[0].text : 'a hair’s breadth')
        : cand.fit.note)));
  const foot = el('div', { class: 'cardFoot' });
  foot.append(confidenceFact(rec));
  foot.append(el('button', { class: 'tiny', onclick: () => openDetail(rec, cand) }, 'Details'));
  foot.append(el('button', { class: 'tiny', onclick: () => { recordEvent('like', rec); render(); } }, '👍'));
  foot.append(el('button', { class: 'tiny', onclick: () => { recordEvent('dislike', rec); render(); } }, '👎'));
  foot.append(el('button', { class: 'tiny', onclick: () => openBuy(rec) }, 'Bought'));
  body.append(foot);
  card.append(body);
  return card;
}

function cycleSummary(r) {
  const panel = el('div', { class: 'panel' });
  const counts = state.meta.lastPlan || {};
  const researched = Array.from(state.magazines.values()).length;
  panel.append(el('h3', {}, monthLabel(r.month) + ' — recomputed from what is on sale now'));
  panel.append(el('p', {},
    'Nothing here is carried over from a previous month’s schedule. The ranking below was rebuilt from '
    + 'the most recent reading of each title, so a magazine that was suitable last month can drop out '
    + 'because it went up in price, repeated itself, or could not be confirmed as current.'));
  const dl = el('dl', { class: 'kv' });
  const kv = (k, v) => { dl.append(el('dt', {}, k), el('dd', {}, v)); };
  kv('Titles known to exist', String(state.leads.length));
  kv('Titles actually read', researched + ' (' + (state.leads.length ? Math.round(researched / state.leads.length * 100) : 0) + '% coverage)');
  kv('Cleared your filters', String(r.scored.length));
  kv('Excluded', String(r.excluded.length));
  kv('Last refresh', state.meta.lastRefresh ? ago(state.meta.lastRefresh) + ' (' + (state.meta.lastRefreshSeconds || 0) + 's)' : 'never');
  kv('Taste model', r.t.empty ? 'empty — no interactions recorded'
    : r.t.eventCount + ' events, ' + Object.keys(r.t.topics).length + ' topics, '
      + r.t.progression.stride + ' stride');
  panel.append(dl);
  panel.append(el('div', { class: 'btnRow', style: 'margin-top:12px' },
    el('button', { class: 'ghost', onclick: () => setView('research') }, 'Open the research view'),
    el('button', { class: 'ghost', onclick: () => runRefresh({ budget: Math.max(150, state.meta.budget * 2) }) },
      'Deep refresh (double budget)')));
  return panel;
}

function emptyState() {
  return el('div', { class: 'empty' },
    el('h3', {}, 'Nothing discovered yet'),
    el('p', {}, 'MagLens has no built-in list of magazines. It finds out what is on sale in India by '
      + 'reading newsstand indexes and publisher pages live, then reads the current issue of as many '
      + 'titles as the fetch budget allows. The first run takes a couple of minutes.'),
    el('button', { class: 'primary', onclick: () => runRefresh() }, 'Discover magazines'));
}

/* --------------------------------------------------------- the browse view */

function viewBrowse() {
  const main = $('#main');
  main.replaceChildren();

  const r = currentCycle();
  const all = r.scored.slice();

  main.append(el('h2', { class: 'sec' }, 'Everything that clears your filters'));

  const bar = el('div', { class: 'panel' });
  const search = el('input', {
    type: 'search', placeholder: 'title, publisher, topic…',
    oninput: e => { browseQuery = e.target.value.toLowerCase(); drawList(); },
    value: browseQuery,
  });
  const sortSel = el('select', {
    onchange: e => { browseSort = e.target.value; drawList(); },
  },
    el('option', { value: 'score' }, 'Best fit first'),
    el('option', { value: 'fresh' }, 'Most confidently current'),
    el('option', { value: 'price' }, 'Cheapest first'),
    el('option', { value: 'new' }, 'Most recently read'),
    el('option', { value: 'title' }, 'A–Z'));
  sortSel.value = browseSort;
  bar.append(el('div', { class: 'deckGrid' },
    el('label', { class: 'field' }, el('span', {}, 'Search'), search),
    el('label', { class: 'field' }, el('span', {}, 'Sort'), sortSel)));
  main.append(bar);

  const listWrap = el('div', {});
  main.append(listWrap);

  function drawList() {
    let rows = all;
    if (browseQuery) {
      rows = rows.filter(c => (c.rec.title + ' ' + (c.rec.publisher || '') + ' '
        + Object.keys(c.rec.topics || {}).join(' ')).toLowerCase().includes(browseQuery));
    }
    const sorters = {
      score: (a, b) => b.base - a.base,
      fresh: (a, b) => (b.rec.issue.confidence || 0) - (a.rec.issue.confidence || 0),
      price: (a, b) => (toInr(a.rec.price) ?? 1e9) - (toInr(b.rec.price) ?? 1e9),
      new: (a, b) => b.rec.lastChecked - a.rec.lastChecked,
      title: (a, b) => a.rec.title.localeCompare(b.rec.title),
    };
    rows = rows.slice().sort(sorters[browseSort] || sorters.score);
    listWrap.replaceChildren();
    listWrap.append(el('div', { class: 'muted small', style: 'margin:8px 0' },
      rows.length + ' of ' + all.length + ' shown'));
    const grid = el('div', { class: 'grid' });
    rows.slice(0, 180).forEach((c, i) => grid.append(rankCard(c, i + 1)));
    listWrap.append(grid);
    if (rows.length > 180) {
      listWrap.append(el('p', { class: 'muted small' }, 'Showing the first 180.'));
    }
  }
  drawList();
}
let browseQuery = '';
let browseSort = 'score';

/* ---------------------------------------------------------- the taste view */
/* Everything the app believes about the reader, what it believes it FROM, and a
   control to change or delete each belief. An inference with no visible
   evidence behind it is indistinguishable from a guess, and a system that
   cannot be corrected will eventually be wrong in a way that compounds. */

function viewTaste() {
  const main = $('#main');
  main.replaceChildren();
  const t = taste();

  if (t.empty) {
    main.append(el('div', { class: 'empty' },
      el('h3', {}, 'Nothing learned yet — by design'),
      el('p', {}, 'MagLens was not seeded with any topics, interests, categories or example magazines. '
        + 'This page fills itself in from what you actually do: what you buy, rate, like, dismiss and '
        + 'give reasons for. Until then it stays empty rather than guessing, and the monthly shortlist '
        + 'is chosen for breadth instead of fit.'),
      el('button', { class: 'primary', onclick: () => setView('month') }, 'Go and react to something')));
    return;
  }

  main.append(el('h2', { class: 'sec' }, 'What MagLens believes about you'));
  main.append(el('div', { class: 'panel' },
    el('h3', {}, 'Built from ' + t.eventCount + ' interactions'),
    el('p', {}, 'Every line below is derived from the event log and nothing else. Change or delete any '
      + 'of it — the model is rebuilt from scratch each time, so a correction produces exactly the model '
      + 'that would have existed had the evidence been different. Deleting the evidence itself is done '
      + 'from History.'),
    el('p', {}, 'One thing is deliberately excluded: simply being shown a magazine teaches nothing. '
      + 'It is kept in History so you can see what was put in front of you, but training on it would '
      + 'mean learning from the recommender’s own output. Dismissing something you were shown is a '
      + 'different matter and does count.'),
    el('div', { class: 'kv' },
      el('dt', {}, 'First signal'), el('dd', {}, fmtDate(t.firstAt)),
      el('dt', {}, 'Latest signal'), el('dd', {}, fmtDate(t.lastAt)),
      el('dt', {}, 'Total evidence weight'), el('dd', {}, t.totalWeight.toFixed(1)),
      el('dt', {}, 'Model maturity'), el('dd', {}, Math.round(t.maturity * 100) + '% — how much '
        + 'weight the ranking gives these beliefs against everything else it measures'))));

  /* ---- subjects ---- */
  main.append(el('h2', { class: 'sec' }, 'Subjects'));
  const subjects = Object.values(t.topics)
    .filter(x => x.weight > 0.15 || x.overridden)
    .sort((a, b) => Math.abs(b.utility) * b.confidence - Math.abs(a.utility) * a.confidence);

  const subPanel = el('div', { class: 'panel' });
  if (!subjects.length) {
    subPanel.append(el('p', {}, 'No subject has enough evidence behind it to say anything yet.'));
  }
  for (const s of subjects.slice(0, 40)) subPanel.append(inferenceRow(s, 'topic'));
  main.append(subPanel);

  /* ---- how you read ---- */
  main.append(el('h2', { class: 'sec' }, 'How you read'));
  const scalarPanel = el('div', { class: 'panel' });
  const scalarCopy = {
    visualness: ['mostly pictures', 'mostly words'],
    difficulty: ['demanding', 'easy'],
    newsiness: ['news-heavy', 'no news'],
    price: null,
  };
  for (const [key, s] of Object.entries(t.scalars)) {
    if (!s.known) {
      scalarPanel.append(el('div', { class: 'inference' },
        el('div', { class: 'lead' }, el('b', {}, s.label), el('span', { class: 'muted' }, 'not established yet')),
        el('div', { class: 'ev' }, 'Nothing you have done so far says anything about this.')));
      continue;
    }
    scalarPanel.append(scalarRow(key, s, scalarCopy[key]));
  }
  main.append(scalarPanel);

  /* ---- facets ---- */
  const facetTitles = {
    audience: 'Audience', languages: 'Languages', publishers: 'Publishers',
    frequency: 'Publication frequency', formats: 'Format',
  };
  for (const [facet, title] of Object.entries(facetTitles)) {
    const rows = Object.values(t.facets[facet] || {})
      .filter(x => x.weight > 0.3)
      .sort((a, b) => Math.abs(b.utility) - Math.abs(a.utility));
    if (!rows.length) continue;
    main.append(el('h2', { class: 'sec' }, title));
    const p = el('div', { class: 'panel' });
    for (const row of rows.slice(0, 14)) p.append(inferenceRow(row, 'facet:' + facet));
    main.append(p);
  }

  /* ---- progression ---- */
  main.append(el('h2', { class: 'sec' }, 'How far you like to stray'));
  main.append(progressionPanel(t));
}

function inferenceRow(s, kind) {
  const positive = s.utility > 0;
  const strength = Math.abs(s.utility);
  const word = strength < 0.25 ? 'barely registers'
    : strength < 0.7 ? (positive ? 'mildly drawn to' : 'mildly put off by')
    : strength < 1.4 ? (positive ? 'likes' : 'dislikes')
    : (positive ? 'strongly likes' : 'strongly dislikes');

  const row = el('div', { class: 'inference' + (s.overridden ? ' overridden' : '') });
  row.append(el('div', { class: 'lead' },
    el('b', {}, s.name),
    el('span', { class: 'muted' }, word),
    el('span', { class: 'confBar' }, 'confidence',
      el('span', { class: 'meter' }, el('i', { style: 'width:' + Math.round(s.confidence * 100) + '%' })),
      Math.round(s.confidence * 100) + '%'),
    s.muted ? el('span', { class: 'fact bad' }, 'muted') : null,
    s.overridden && !s.muted ? el('span', { class: 'fact warn' }, 'you corrected this') : null));

  const ctrls = el('div', { class: 'ctrls' });
  if (kind === 'topic') {
    ctrls.append(el('button', {
      class: 'tiny ghost', title: 'Stop this subject influencing recommendations at all',
      onclick: () => setOverride('topic:' + s.name, { mode: 'mute' }),
    }, s.muted ? 'Unmute' : 'Mute'));
    ctrls.append(el('button', {
      class: 'tiny ghost', title: 'Assert that you do like this, whatever the evidence says',
      onclick: () => setOverride('topic:' + s.name, { mode: 'set', value: 1.2, note: 'you said you like this' }),
    }, 'I do like it'));
    ctrls.append(el('button', {
      class: 'tiny ghost',
      onclick: () => setOverride('topic:' + s.name, { mode: 'set', value: -1.2, note: 'you said you dislike this' }),
    }, 'I don’t'));
    if (state.overrides['topic:' + s.name]) {
      ctrls.append(el('button', {
        class: 'tiny danger', onclick: () => clearOverride('topic:' + s.name),
      }, 'Undo correction'));
    }
  }
  row.append(ctrls);

  const ev = el('div', { class: 'ev' });
  if (s.manualOnly) {
    ev.append(el('em', {}, 'You asserted this directly. There is no interaction evidence behind it.'));
  } else if (!s.evidence.length) {
    ev.append('No evidence recorded.');
  } else {
    ev.append(el('em', {}, 'Evidence: '));
    const bits = s.evidence.slice(0, 5).map(e =>
      (e.sign > 0 ? '+' : '−') + ' ' + evidenceWord(e.kind) + ' ' + (e.title || '')
      + (e.reason ? ' ("' + e.reason + '")' : '')
      + (e.share ? ' — ' + Math.round(e.share * 100) + '% of that issue' : '')
      + ' · ' + ago(e.at));
    ev.append(bits.join('  ·  '));
    if (s.evidence.length > 5) ev.append('  · and ' + (s.evidence.length - 5) + ' more');
  }
  row.append(ev);
  return row;
}

const evidenceWord = k => ({
  buy: 'bought', rate: 'rated', like: 'liked', dislike: 'disliked',
  notInterested: 'dismissed', skip: 'skipped', open: 'opened',
  view: 'was shown', alreadyRead: 'had already read',
}[k] || k);

function scalarRow(key, s, poles) {
  const row = el('div', { class: 'inference' + (s.overridden ? ' overridden' : '') });
  const value = key === 'price' ? '₹' + Math.round(s.mean)
    : Math.round(s.mean * 100) + '%' + (poles ? ' towards ' + (s.mean > 0.5 ? poles[0] : poles[1]) : '');
  row.append(el('div', { class: 'lead' },
    el('b', {}, s.label),
    el('span', { class: 'muted' }, value),
    key !== 'price' && s.sd != null
      ? el('span', { class: 'muted small' }, '± ' + Math.round(s.sd * 100) + '%')
      : null,
    s.avoid != null
      ? el('span', { class: 'muted small' }, '· avoids ' +
        (key === 'price' ? '₹' + Math.round(s.avoid) : Math.round(s.avoid * 100) + '%'))
      : null,
    el('span', { class: 'confBar' }, 'confidence',
      el('span', { class: 'meter' }, el('i', { style: 'width:' + Math.round(s.confidence * 100) + '%' })),
      Math.round(s.confidence * 100) + '%')));

  const ctrls = el('div', { class: 'ctrls' });
  if (key !== 'price') {
    const slider = el('input', {
      type: 'range', min: 0, max: 100, value: Math.round(s.mean * 100),
      style: 'width:120px',
      onchange: e => setOverride('scalar:' + key, { mode: 'set', value: +e.target.value / 100 }),
    });
    ctrls.append(slider);
  } else {
    ctrls.append(el('input', {
      type: 'number', style: 'width:110px', value: Math.round(s.mean),
      onchange: e => setOverride('scalar:price', { mode: 'set', value: +e.target.value }),
    }));
  }
  if (state.overrides['scalar:' + key]) {
    ctrls.append(el('button', { class: 'tiny danger', onclick: () => clearOverride('scalar:' + key) }, 'Undo'));
  }
  row.append(ctrls);

  const ev = el('div', { class: 'ev' });
  ev.append(el('em', {}, 'From: '));
  ev.append((s.samples || []).slice(0, 6).map(x =>
    (x.sign > 0 ? '+' : '−') + ' ' + evidenceWord(x.kind) + ' ' + x.title
    + ' at ' + (key === 'price' ? '₹' + Math.round(x.value) : Math.round(x.value * 100) + '%')
    + (x.reason ? ' ("' + x.reason + '")' : '')).join('  ·  ') || 'no samples');
  row.append(ev);
  return row;
}

function progressionPanel(t) {
  const p = t.progression;
  const panel = el('div', { class: 'panel' });
  panel.append(el('h3', {}, 'Stride: ' + p.stride));
  panel.append(el('p', {},
    'This is learned from how far each accepted pick sat from your taste AT THE TIME it was offered — '
    + 'not from any built-in idea of which subject follows which. If distant picks keep landing well, the '
    + 'stride widens on its own and recommendations start drifting outward; if they keep being rejected, '
    + 'it narrows.'));
  panel.append(el('div', { class: 'kv' },
    el('dt', {}, 'Appetite'), el('dd', {}, p.appetite.toFixed(2) + ' / 1.00'),
    el('dt', {}, 'Basis'), el('dd', {}, p.basis),
    el('dt', {}, 'Confidence'), el('dd', {}, Math.round(p.confidence * 100) + '%')));

  const slider = el('input', {
    type: 'range', min: 0, max: 100, value: Math.round(p.appetite * 100),
    onchange: e => setOverride('progression:appetite', { mode: 'set', value: +e.target.value / 100 }),
  });
  panel.append(el('label', { class: 'field', style: 'margin-top:12px' },
    el('span', {}, 'Override the stride'), slider,
    el('small', { class: 'muted' }, 'Left keeps to what you know; right pushes further out each month.')));
  if (state.overrides['progression:appetite']) {
    panel.append(el('button', { class: 'tiny danger', onclick: () => clearOverride('progression:appetite') },
      'Go back to the learned value'));
  }

  if (p.samples.length) {
    const wrap = el('div', { class: 'tblWrap', style: 'margin-top:14px' });
    const tbl = el('table', { class: 'tbl' });
    tbl.append(el('thead', {}, el('tr', {},
      el('th', {}, 'When'), el('th', {}, 'Title'), el('th', {}, 'Action'),
      el('th', {}, 'Distance from taste at the time'))));
    const tb = el('tbody', {});
    for (const s of p.samples.slice(0, 25)) {
      tb.append(el('tr', {},
        el('td', {}, fmtDate(s.at)), el('td', {}, s.title),
        el('td', {}, (s.sign > 0 ? '👍 ' : '👎 ') + evidenceWord(s.kind)),
        el('td', { class: 'mono' }, s.novelty.toFixed(2))));
    }
    tbl.append(tb);
    wrap.append(tbl);
    panel.append(wrap);
  }
  return panel;
}

function setOverride(key, ov) {
  if (ov.mode === 'mute' && state.overrides[key] && state.overrides[key].mode === 'mute') {
    delete state.overrides[key];
  } else {
    state.overrides[key] = ov;
  }
  tasteCache.key = '';
  state.ranked = null;
  scheduleSave();
  render();
}

function clearOverride(key) {
  delete state.overrides[key];
  tasteCache.key = '';
  state.ranked = null;
  scheduleSave();
  render();
}

/* -------------------------------------------------------- the history view */
/* Issue-level, not title-level. "You read Autocar India" is not a useful fact;
   "you bought the August 2026 issue for ₹150 and rated it 4" is, and it is what
   the repetition and already-have logic actually needs. */

function viewHistory() {
  const main = $('#main');
  main.replaceChildren();

  const events = state.events.slice().sort((a, b) => b.at - a.at);
  if (!events.length) {
    main.append(el('div', { class: 'empty' },
      el('h3', {}, 'Nothing recorded yet'),
      el('p', {}, 'Every recommendation, view, purchase, rating and dismissal lands here, tied to the '
        + 'specific issue rather than just the magazine.')));
    return;
  }

  main.append(el('h2', { class: 'sec' }, 'Timeline'));
  main.append(el('div', { class: 'panel' },
    el('p', {}, 'Deleting an event removes it from the evidence and the taste model is rebuilt without '
      + 'it — the same model you would have had if it had never happened. Nothing is soft-deleted.'),
    el('div', { class: 'btnRow' },
      el('button', { class: 'ghost', onclick: () => { historyFilter = ''; render(); } }, 'All'),
      ...['buy', 'rate', 'like', 'dislike', 'notInterested', 'skip', 'alreadyRead', 'view'].map(k =>
        el('button', {
          class: 'ghost tiny' + (historyFilter === k ? ' primary' : ''),
          onclick: () => { historyFilter = historyFilter === k ? '' : k; render(); },
        }, evidenceWord(k) + ' (' + events.filter(e => e.kind === k).length + ')')))));

  const shown = historyFilter ? events.filter(e => e.kind === historyFilter) : events;

  let lastMonth = null;
  const tl = el('div', { class: 'tl' });
  for (const ev of shown.slice(0, 500)) {
    if (ev.month !== lastMonth) {
      lastMonth = ev.month;
      tl.append(el('div', { class: 'monthHead' }, el('h3', {}, monthLabel(ev.month)), el('hr', {})));
    }
    const rec = resolveRecord(ev.recordId);
    const item = el('div', { class: 'tlItem ' + ev.kind });
    item.append(el('div', { class: 'tlHead' },
      el('b', {}, ev.title),
      ev.issueLabel ? el('span', { class: 'muted' }, ev.issueLabel) : el('span', { class: 'muted' }, 'issue not recorded'),
      el('span', { class: 'fact' }, evidenceWord(ev.kind) + (ev.kind === 'rate' ? ' ' + ev.rating + '/5' : '')),
      ev.pricePaid != null ? el('span', { class: 'fact good' }, '₹' + ev.pricePaid + ' paid') : null,
      ev.format ? el('span', { class: 'fact' }, ev.format) : null,
      el('span', { class: 'tlWhen' }, fmtDate(ev.at) + ' · ' + ago(ev.at))));
    if (ev.reason) item.append(el('div', { class: 'muted small' }, 'Reason: ' + ev.reason));
    if (ev.note) item.append(el('div', { class: 'muted small' }, '“' + ev.note + '”'));
    if (ev.where) item.append(el('div', { class: 'muted small' }, 'Bought at: ' + ev.where));
    if (ev.topics && ev.topics.length) {
      item.append(el('div', { class: 'muted small' }, 'Subjects: ' + ev.topics.join(', ')));
    }
    item.append(el('div', { class: 'btnRow', style: 'margin-top:6px' },
      rec ? el('button', { class: 'tiny ghost', onclick: () => openDetail(rec) }, 'Open') : null,
      el('button', {
        class: 'tiny danger',
        onclick: () => { deleteEvent(ev.id); toast('Event deleted and the model rebuilt'); render(); },
      }, 'Delete')));
    tl.append(item);
  }
  main.append(tl);
  if (shown.length > 500) main.append(el('p', { class: 'muted small' }, 'Showing the most recent 500.'));
}
let historyFilter = '';

/* ------------------------------------------------------- the research view */
/* The audit trail. Everything the app knows, where it came from, when it was
   read, what it could not establish, what it excluded and why, and the
   component-by-component arithmetic behind every score. It is also where
   metadata gets corrected and duplicates get resolved by hand, because an
   automated pipeline reading a dozen retailer layouts will get things wrong and
   the alternative to a correction button is a wrong answer that persists. */

const RESEARCH_TABS = ['Discovered', 'Scores', 'Exclusions', 'Duplicates', 'Sources', 'Fetch log'];
let researchTab = 'Discovered';
let researchQuery = '';

function viewResearch() {
  const main = $('#main');
  main.replaceChildren();
  const r = currentCycle();

  main.append(el('h2', { class: 'sec' }, 'Research'));

  const head = el('div', { class: 'panel' });
  head.append(el('h3', {}, 'Coverage'));
  const researched = state.magazines.size;
  head.append(el('div', { class: 'kv' },
    el('dt', {}, 'Titles known to exist'), el('dd', {}, String(state.leads.length)),
    el('dt', {}, 'Issue pages read'), el('dd', {}, researched + ' (' +
      (state.leads.length ? (researched / state.leads.length * 100).toFixed(1) : '0') + '%)'),
    el('dt', {}, 'Newsstand index read'), el('dd', {},
      state.meta.universeAt ? ago(state.meta.universeAt) : 'never'),
    el('dt', {}, 'Index last regenerated by the source'), el('dd', {},
      state.meta.universePublished ? fmtDate(state.meta.universePublished)
        + ' — anything launched since then can only arrive through web search'
        : 'not stated'),
    el('dt', {}, 'Last refresh'), el('dd', {},
      state.meta.lastRefresh ? fmtDate(state.meta.lastRefresh) + ' · ' + ago(state.meta.lastRefresh) : 'never'),
    el('dt', {}, 'Fetches this session'), el('dd', {},
      (state.meta.counters.fetchOk || 0) + ' ok, ' + (state.meta.counters.fetchFail || 0) + ' failed')));
  main.append(head);

  const tabs = el('div', { class: 'btnRow', style: 'margin:14px 0' });
  for (const t of RESEARCH_TABS) {
    tabs.append(el('button', {
      class: researchTab === t ? 'primary' : 'ghost',
      onclick: () => { researchTab = t; render(); },
    }, t));
  }
  main.append(tabs);

  const body = el('div', {});
  main.append(body);

  if (researchTab === 'Discovered') body.append(researchDiscovered(r));
  else if (researchTab === 'Scores') body.append(researchScores(r));
  else if (researchTab === 'Exclusions') body.append(researchExclusions(r));
  else if (researchTab === 'Duplicates') body.append(researchDuplicates());
  else if (researchTab === 'Sources') body.append(researchSources());
  else body.append(researchLog());
}

function searchBox(placeholder, onchange) {
  return el('label', { class: 'field', style: 'max-width:340px;margin-bottom:12px' },
    el('span', {}, 'Filter'),
    el('input', { type: 'search', placeholder, value: researchQuery, oninput: e => { researchQuery = e.target.value.toLowerCase(); onchange(); } }));
}

function researchDiscovered() {
  const wrap = el('div', {});
  wrap.append(searchBox('title, publisher, source…', () => render()));

  let recs = Array.from(state.magazines.values());
  if (researchQuery) {
    recs = recs.filter(r => (r.title + ' ' + (r.publisher || '') + ' ' + (r.sellers || []).join(' '))
      .toLowerCase().includes(researchQuery));
  }
  recs.sort((a, b) => b.lastChecked - a.lastChecked);

  const tw = el('div', { class: 'tblWrap' });
  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Magazine'), el('th', {}, 'Latest issue detected'), el('th', {}, 'Evidence'),
    el('th', {}, 'Price'), el('th', {}, 'Availability'), el('th', {}, 'Inferred topics'),
    el('th', {}, 'Sources'), el('th', {}, 'Last checked'), el('th', {}, ''))));
  const tb = el('tbody', {});
  for (const rec of recs.slice(0, 400)) {
    const iss = rec.issue || {};
    tb.append(el('tr', {},
      el('td', {}, el('b', {}, rec.title), rec.publisher ? el('div', { class: 'muted small' }, rec.publisher) : null),
      el('td', {}, iss.label || el('span', { class: 'muted' }, '—'),
        iss.parsed && iss.parsed.date ? el('div', { class: 'muted small' }, fmtDate(iss.parsed.date)) : null),
      el('td', {},
        el('span', { class: 'fact ' + (iss.band === 'verified' ? 'good' : iss.band === 'unknown' ? 'bad' : 'warn') },
          Math.round((iss.confidence || 0) * 100) + '%'),
        el('div', { class: 'muted small' }, (iss.reasons || []).slice(0, 2).join('; '))),
      el('td', {}, fmtPrice(rec.price),
        rec.price && rec.price.note ? el('div', { class: 'muted small' }, rec.price.note) : null),
      el('td', {}, rec.availability),
      el('td', {}, topEntries(rec.topics || {}, 4).map(([k, v]) => k + ' ' + Math.round(v * 100) + '%').join(', ') || '—'),
      el('td', {}, (rec.sellers || []).join(', ')),
      el('td', { class: 'mono' }, ago(rec.lastChecked)),
      el('td', {},
        el('button', { class: 'tiny ghost', onclick: () => openDetail(rec) }, 'Open'),
        el('button', { class: 'tiny ghost', onclick: () => openEdit(rec) }, 'Correct'))));
  }
  tbl.append(tb);
  tw.append(tbl);
  wrap.append(tw);
  if (recs.length > 400) wrap.append(el('p', { class: 'muted small' }, 'Showing 400 of ' + recs.length + '.'));
  return wrap;
}

function researchScores(r) {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'panel' },
    el('h3', {}, 'Score components'),
    el('p', {}, 'Total = Σ weight × component. Penalties carry negative weights, so a large value in '
      + 'the last three columns pushes a candidate DOWN. The weights are fixed in the source and shown '
      + 'in the header so a surprising ranking can be attributed to a specific term.')));

  const keys = Object.keys(WEIGHTS);
  const tw = el('div', { class: 'tblWrap' });
  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, '#'), el('th', {}, 'Magazine'), el('th', {}, 'Total'),
    ...keys.map(k => el('th', { title: 'weight ' + WEIGHTS[k] }, k, el('div', { class: 'muted' }, '×' + WEIGHTS[k]))))));
  const tb = el('tbody', {});
  const rows = r.chosen.concat(r.scored.filter(s => !r.chosen.includes(s)).slice(0, 40));
  rows.forEach((c, i) => {
    tb.append(el('tr', {},
      el('td', { class: 'mono' }, String(i + 1)),
      el('td', {}, c.rec.title, c.exploratory ? el('span', { class: 'fact' }, 'explore') : null),
      el('td', { class: 'mono' }, c.score.toFixed(2)),
      ...keys.map(k => {
        const v = c.parts[k] || 0;
        const contrib = v * (WEIGHTS[k] || 0);
        return el('td', { title: c.notes[k] || '' },
          el('div', { class: 'meter' }, el('i', {
            class: contrib < 0 ? 'neg' : '',
            style: 'width:' + Math.round(Math.abs(v) * 100) + '%',
          })),
          el('div', { class: 'mono muted' }, contrib.toFixed(2)));
      })));
  });
  tbl.append(tb);
  tw.append(tbl);
  wrap.append(tw);
  return wrap;
}

function researchExclusions(r) {
  const wrap = el('div', {});
  const byReason = new Map();
  for (const ex of r.excluded) {
    for (const f of ex.fails) {
      if (!byReason.has(f.filter)) byReason.set(f.filter, []);
      byReason.get(f.filter).push({ rec: ex.rec, reason: f.reason });
    }
  }
  const sorted = Array.from(byReason.entries()).sort((a, b) => b[1].length - a[1].length);

  wrap.append(el('div', { class: 'panel' },
    el('h3', {}, r.excluded.length + ' titles excluded'),
    el('p', {}, 'Grouped by which constraint removed them. A filter at the top of this list is the one '
      + 'most narrowing your field — worth loosening first if the month looks thin.')));

  for (const [filter, items] of sorted) {
    const p = el('div', { class: 'panel' });
    p.append(el('h3', {}, filter + ' — ' + items.length));
    const list = items.slice(0, 25).map(i => i.rec.title + ' (' + i.reason + ')').join('; ');
    p.append(el('div', { class: 'muted small' }, list + (items.length > 25 ? ' … and ' + (items.length - 25) + ' more' : '')));
    wrap.append(p);
  }
  return wrap;
}

function researchDuplicates() {
  const wrap = el('div', {});
  const pairs = duplicateCandidates().slice(0, 120);
  wrap.append(el('div', { class: 'panel' },
    el('h3', {}, 'Possible duplicates'),
    el('p', {}, 'The same magazine listed twice — usually two sellers, or a title that changed publisher. '
      + 'Certain matches were merged during the refresh; these are the ones that needed a judgement. '
      + 'Two DIFFERENT magazines about the same subject are not duplicates and should be marked distinct — '
      + 'the ranking handles subject overlap separately.')));

  if (!pairs.length) {
    wrap.append(el('p', { class: 'muted' }, 'No unresolved candidates.'));
    return wrap;
  }
  const tw = el('div', { class: 'tblWrap' });
  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, 'A'), el('th', {}, 'B'), el('th', {}, 'Match'), el('th', {}, 'Why'),
    el('th', {}, 'Topic overlap'), el('th', {}, ''))));
  const tb = el('tbody', {});
  for (const p of pairs) {
    const sim = cosine(p.a.topicVec || {}, p.b.topicVec || {});
    tb.append(el('tr', {},
      el('td', {}, p.a.title, el('div', { class: 'muted small' }, (p.a.publisher || '—') + ' · ' + (p.a.sellers || []).join(', '))),
      el('td', {}, p.b.title, el('div', { class: 'muted small' }, (p.b.publisher || '—') + ' · ' + (p.b.sellers || []).join(', '))),
      el('td', { class: 'mono' }, p.score.toFixed(2)),
      el('td', { class: 'muted small' }, p.why),
      el('td', { class: 'mono' }, sim.toFixed(2)),
      el('td', {},
        el('button', { class: 'tiny primary', onclick: () => { setMergeVerdict(p.a.id, p.b.id, 'same'); toast('Merged'); render(); } }, 'Same — merge'),
        el('button', { class: 'tiny ghost', onclick: () => { setMergeVerdict(p.a.id, p.b.id, 'distinct'); toast('Marked distinct'); render(); } }, 'Different'))));
  }
  tbl.append(tb);
  tw.append(tbl);
  wrap.append(tw);
  return wrap;
}

function researchSources() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'panel' },
    el('h3', {}, 'Connectors'),
    el('p', {}, 'Each connector owns the extraction rules for one kind of site. When a retailer '
      + 'redesigns, only its connector needs changing — nothing above this layer knows what any '
      + 'particular page looks like.')));

  const rows = [
    ['magzter', 'Magzter (India store)', MAGZTER.sitemap, 'sitemap enumeration + issue page', 'digital, India store, 10k+ titles'],
    ['readwhere', 'Readwhere', READWHERE.sitemap, 'sitemap enumeration only', 'titles and languages; issue data is client-rendered and unreadable'],
    ['websearch', 'Web search', 'https://html.duckduckgo.com/html/', 'open-ended discovery', 'reaches titles no sitemap lists'],
    ['publisher', 'Publisher sites', '—', 'generic current-issue reader', 'primary source; used where a publisher URL is known'],
  ];
  const tw = el('div', { class: 'tblWrap' });
  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, el('tr', {}, el('th', {}, 'Connector'), el('th', {}, 'Entry point'),
    el('th', {}, 'Role'), el('th', {}, 'Notes'), el('th', {}, 'Leads contributed'))));
  const tb = el('tbody', {});
  const counters = state.meta.counters || {};
  for (const [id, name, url, role, note] of rows) {
    const key = 'leads:' + id;
    tb.append(el('tr', {},
      el('td', {}, name),
      el('td', { class: 'mono small' }, url === '—' ? '—' : el('a', { href: url, target: '_blank', rel: 'noopener' }, url)),
      el('td', {}, role), el('td', { class: 'muted small' }, note),
      el('td', { class: 'mono' }, String(counters[key] || 0))));
  }
  tbl.append(tb);
  tw.append(tbl);
  wrap.append(tw);

  wrap.append(el('div', { class: 'panel', style: 'margin-top:14px' },
    el('h3', {}, 'How pages are fetched'),
    el('p', {}, 'A browser cannot read most retailer sites directly — they send no CORS header. '
      + 'Hosts that do are read directly, which also means they are read from India and their prices '
      + 'are the ones actually offered here. Everything else goes through a reader proxy, which lands '
      + 'in another country; where that happens the store region is captured off the page and the price '
      + 'is labelled accordingly rather than being presented as an Indian one.'),
    el('div', { class: 'kv' },
      el('dt', {}, 'Proxy chain'), el('dd', {}, PROXIES.map(p => p.label).join(' → ')),
      el('dt', {}, 'Direct-fetch hosts'), el('dd', {}, DIRECT_OK.join(', ')),
      el('dt', {}, 'Pace'), el('dd', {}, 'adaptive, from ' + PACE_MS + 'ms, widening on 429/5xx'))));
  return wrap;
}

function researchLog() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'panel' },
    el('h3', {}, 'Fetch log — this session'),
    el('p', {}, 'Every page read, with the route it took and whether it worked.')));
  const tw = el('div', { class: 'tblWrap' });
  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Kind'),
    el('th', {}, 'URL / note'), el('th', {}, 'Via'), el('th', {}, 'Status'))));
  const tb = el('tbody', {});
  for (const e of state.log.slice(0, 300)) {
    tb.append(el('tr', {},
      el('td', { class: 'mono' }, new Date(e.at).toLocaleTimeString()),
      el('td', {}, e.kind),
      el('td', { class: 'small' }, e.url
        ? el('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.url.slice(0, 110))
        : (e.note || e.query || '')),
      el('td', {}, e.via || '—'),
      el('td', { class: e.ok ? '' : 'mono' },
        el('span', { class: 'fact ' + (e.ok ? 'good' : 'bad') }, String(e.status || (e.ok ? 'ok' : 'fail'))))));
  }
  tbl.append(tb);
  tw.append(tbl);
  wrap.append(tw);
  return wrap;
}

/* ------------------------------------------------------------ detail sheet */

function openDetail(rec, cand) {
  const body = $('#detailBody');
  body.replaceChildren();
  recordEvent('open', rec);

  const head = el('div', { class: 'detailHead' });
  head.append(coverNode(rec));
  const info = el('div', {});
  info.append(el('h2', {}, rec.title));
  info.append(el('div', { class: 'muted' },
    ((rec.issue && rec.issue.label) || 'issue unknown')
    + (rec.publisher ? ' · ' + rec.publisher : '')
    + (rec.category ? ' · ' + rec.category : '')));
  info.append(factRow(rec));
  info.append(topicChips(rec.topics, { limit: 12 }));
  head.append(info);
  body.append(head);

  body.append(el('h2', { class: 'sec' }, 'This issue'));
  body.append(el('p', { class: 'blurb' }, rec.content.summary.text));
  body.append(el('div', { class: 'muted small' }, 'Source: ' + rec.content.summary.basis + '.'));

  if (rec.content.articleCount) {
    body.append(el('h2', { class: 'sec' }, 'Contents read from the issue'));
    const toc = [];
    for (const o of rec.observations) for (const item of o.toc || []) toc.push(item);
    const ul = el('ul', { class: 'tocList' });
    for (const item of toc.slice(0, 40)) {
      ul.append(el('li', {},
        el('div', {}, el('b', {}, item.title), item.blurb ? el('div', { class: 'muted small' }, item.blurb) : null),
        el('span', { class: 'mins' }, item.mins ? item.mins + ' min' : '')));
    }
    body.append(ul);
  }

  body.append(el('h2', { class: 'sec' }, 'Is this really the current issue?'));
  const iss = rec.issue || {};
  const ev = el('div', { class: 'panel' });
  ev.append(el('div', { class: 'chipWrap' }, confidenceFact(rec)));
  const ul = el('ul', { style: 'margin:10px 0 0;padding-left:18px;color:var(--fg2)' });
  for (const rsn of iss.reasons || []) ul.append(el('li', {}, rsn));
  ev.append(ul);
  if ((iss.claims || []).length > 1) {
    ev.append(el('div', { class: 'muted small', style: 'margin-top:8px' },
      'Claims: ' + iss.claims.map(c => c.source + ' says "' + c.label + '" (' + ago(c.at) + ')').join('; ')));
  }
  body.append(ev);

  body.append(el('h2', { class: 'sec' }, 'Sources'));
  const src = el('div', { class: 'srcList' });
  for (const o of rec.observations) {
    src.append(el('div', { class: 'srcRow' },
      el('div', {},
        el('a', { href: o.url, target: '_blank', rel: 'noopener' }, o.sourceLabel),
        el('div', { class: 'muted small' }, o.url),
        el('div', { class: 'muted small' },
          'via ' + (o.via || 'unknown route')
          + (o.storeRegion ? ' · ' + o.storeRegion + ' store' : '')
          + (o.inRegion ? ' · read from India' : '')
          + (o.issueLabel ? ' · issue "' + o.issueLabel + '"' : '')),
        (o.problems || []).length ? el('div', { class: 'muted small' }, '⚠ ' + o.problems.join('; ')) : null),
      el('span', { class: 'when' }, ago(o.fetchedAt))));
  }
  body.append(src);

  if (cand) {
    body.append(el('h2', { class: 'sec' }, 'Score for this month'));
    const tbl = el('table', { class: 'scoreTable' });
    for (const k of Object.keys(WEIGHTS)) {
      const v = cand.parts[k] || 0;
      const contrib = v * WEIGHTS[k];
      tbl.append(el('tr', {},
        el('td', {}, k),
        el('td', {}, el('div', { class: 'meter' },
          el('i', { class: contrib < 0 ? 'neg' : '', style: 'width:' + Math.round(Math.abs(v) * 100) + '%' }))),
        el('td', { class: 'num' }, contrib.toFixed(2)),
        el('td', { class: 'muted small' }, cand.notes[k] || '')));
    }
    tbl.append(el('tr', {}, el('td', {}, el('b', {}, 'total')), el('td', {}), el('td', { class: 'num' },
      el('b', {}, cand.score.toFixed(2))), el('td', {})));
    body.append(tbl);
  }

  body.append(el('div', { class: 'modalActions' },
    el('button', { class: 'primary', onclick: () => { closeModal('#detailModal'); openBuy(rec); } }, 'I bought this'),
    el('button', { onclick: () => { recordEvent('like', rec); closeModal('#detailModal'); render(); } }, '👍 Like'),
    el('button', { onclick: () => { recordEvent('dislike', rec); closeModal('#detailModal'); render(); } }, '👎 Dislike'),
    el('button', { class: 'ghost', onclick: () => openEdit(rec) }, 'Correct metadata'),
    el('button', { class: 'ghost', onclick: () => closeModal('#detailModal') }, 'Close')));

  openModal('#detailModal');
}

/* ---------------------------------------------------- manual metadata edit */

function openEdit(rec) {
  const body = $('#mergeBody');
  body.replaceChildren();
  body.append(el('h2', {}, 'Correct: ' + rec.title));
  body.append(el('p', { class: 'muted' },
    'A correction is stored separately from the observations and always wins over them, so a later '
    + 'refresh will not overwrite it. Clear a field to go back to what the sources say.'));

  const fields = [
    ['title', 'Title', rec.title],
    ['publisher', 'Publisher', rec.publisher],
    ['category', 'Category', rec.category],
    ['language', 'Language', rec.language],
    ['coverUrl', 'Cover image URL', rec.coverUrl],
    ['frequencyLabel', 'Frequency', rec.frequency && rec.frequency.label],
    ['availability', 'Availability (available / unknown / gone)', rec.availability],
  ];
  const grid = el('div', { class: 'deckGrid' });
  const inputs = {};
  for (const [key, label, value] of fields) {
    const input = el('input', { type: 'text', value: value || '' });
    inputs[key] = input;
    grid.append(el('label', { class: 'field' }, el('span', {}, label), input,
      rec.manual[key] != null ? el('small', { class: 'muted' }, 'currently overridden') : null));
  }
  body.append(grid);

  body.append(el('div', { class: 'modalActions' },
    el('button', {
      class: 'primary',
      onclick: () => {
        for (const [key] of fields) {
          const v = inputs[key].value.trim();
          if (v) rec.manual[key] = v; else delete rec.manual[key];
        }
        if (rec.manual.frequencyLabel) {
          rec.manual.frequencyDays = freqDays(rec.manual.frequencyLabel);
        }
        rebuildRecord(rec);
        state.ranked = null;
        scheduleSave();
        closeModal('#mergeModal');
        toast('Correction saved');
        render();
      },
    }, 'Save correction'),
    el('button', {
      class: 'danger',
      onclick: () => { rec.manual = {}; rebuildRecord(rec); scheduleSave(); closeModal('#mergeModal'); render(); },
    }, 'Clear all corrections'),
    el('button', { class: 'ghost', onclick: () => closeModal('#mergeModal') }, 'Cancel')));

  openModal('#mergeModal');
}

/* ------------------------------------------------------------- filter deck */
/* Hard constraints only. The deck is built from the corpus, so the topic and
   language lists grow as discovery does — there is no fixed menu of subjects,
   because a fixed menu would quietly define what the app thinks magazines are
   about before it has read a single one. */

function multiSelect(label, options, selected, onchange, hint) {
  const sel = el('select', { multiple: true, size: Math.min(6, Math.max(3, options.length)) });
  for (const [value, count] of options) {
    const o = el('option', { value }, value + (count ? ' (' + count + ')' : ''));
    if (selected.includes(value)) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () =>
    onchange(Array.from(sel.selectedOptions).map(o => o.value)));
  return el('label', { class: 'field' }, el('span', {}, label), sel,
    hint ? el('small', { class: 'muted' }, hint) : null);
}

function selectField(label, options, value, onchange, hint) {
  const sel = el('select', { onchange: e => onchange(e.target.value) });
  for (const [v, text] of options) {
    const o = el('option', { value: v }, text);
    if (String(v) === String(value)) o.selected = true;
    sel.append(o);
  }
  return el('label', { class: 'field' }, el('span', {}, label), sel,
    hint ? el('small', { class: 'muted' }, hint) : null);
}

function numberField(label, value, onchange, hint, attrs = {}) {
  return el('label', { class: 'field' }, el('span', {}, label),
    el('input', { type: 'number', value: value ?? '', ...attrs, onchange: e => onchange(e.target.value === '' ? null : +e.target.value) }),
    hint ? el('small', { class: 'muted' }, hint) : null);
}

function renderDeck(target, opts = {}) {
  const f = state.filters;
  const facets = corpusFacets();
  const set = (k, v) => {
    f[k] = v;
    state.ranked = null;
    scheduleSave();
    if (!opts.quiet) render();
  };

  target.replaceChildren();

  target.append(numberField('Max price per issue (₹)', f.maxPrice, v => set('maxPrice', v),
    'Blank means no ceiling. A magazine whose price could not be read is never hidden by this — it is flagged instead.',
    { min: 0, step: 10, placeholder: 'no limit' }));

  target.append(selectField('Print or digital', [
    ['any', 'Either'], ['print', 'Print only'], ['digital', 'Digital only'],
  ], f.format, v => set('format', v),
    'Digital newsstands are far easier to read reliably than print listings, so "print only" will show fewer titles.'));

  target.append(multiSelect('Languages', facets.languages, f.languages, v => set('languages', v),
    'Nothing selected means any language.'));

  target.append(multiSelect('Frequency', facets.freqs, f.frequency, v => set('frequency', v),
    'Nothing selected means any cadence.'));

  target.append(multiSelect('Topics wanted', facets.topics.slice(0, 60), f.topicsWanted, v => set('topicsWanted', v),
    'A hard requirement, not an interest — it removes everything that does not cover these. Leave empty unless you mean it.'));

  target.append(multiSelect('Topics excluded', facets.topics.slice(0, 60), f.topicsExcluded, v => set('topicsExcluded', v),
    'Removes anything substantially about these.'));

  target.append(selectField('News and current affairs', [
    ['any', 'No preference'], ['exclude', 'Keep news out'], ['include', 'Only news-carrying titles'],
  ], f.news, v => set('news', v)));

  target.append(selectField('Audience', [
    ['any', 'No preference'], ['child', 'Suitable for children'],
    ['adult', 'For adults'], ['both', 'Must suit both'],
  ], f.audience, v => set('audience', v),
    'Applied only where the audience could be inferred from the issue.'));

  target.append(selectField('Visual content', [
    ['any', 'No preference'], ['visual', 'Highly visual'],
    ['balanced', 'Mixed words and pictures'], ['text', 'Text-heavy'],
  ], f.visual, v => set('visual', v)));

  target.append(selectField('Reading difficulty', [
    ['any', 'No preference'], ['easy', 'Easy'], ['medium', 'Moderate'], ['hard', 'Demanding'],
  ], f.difficulty, v => set('difficulty', v)));

  target.append(selectField('Availability in India', [
    [true, 'Only titles on sale in India'], [false, 'Include anything found'],
  ], f.indiaOnly, v => set('indiaOnly', v === 'true')));

  target.append(multiSelect('Publication type', [
    ['magazine', 0], ['newspaper', 0], ['journal', 0], ['book', 0],
  ], f.kinds, v => set('kinds', v),
    'Of 10,400 titles on sale in India, about 4,500 are academic and 1,300 are newspapers. Magazines only, by default.'));

  target.append(numberField('Do not repeat a title bought within (months)', f.excludeRecentlyBought,
    v => set('excludeRecentlyBought', v ?? 0),
    'Issue-level: buying August never blocks September, only the same issue does.', { min: 0, max: 36 }));

  target.append(numberField('Cool-off on subjects recently read (months)', f.excludeRecentSubjects,
    v => set('excludeRecentSubjects', v ?? 0),
    'Softens rather than removes: a recently-read subject is penalised, not banned.', { min: 0, max: 12 }));

  target.append(selectField('Tolerance for overlapping subjects', [
    [0.35, 'Low — insist on very different magazines'],
    [0.55, 'Medium'],
    [0.75, 'High — depth in one subject is fine'],
    [0.95, 'None — repeat the same ground freely'],
  ], f.overlapTolerance, v => set('overlapTolerance', +v),
    'Controls how hard near-identical shortlist entries are suppressed.'));

  target.append(selectField('Minimum current-issue confidence', [
    [0, 'Show everything, however unverified'],
    [0.25, 'Drop titles whose issue is a guess'],
    [0.5, 'Only probable-or-better current issues'],
    [0.75, 'Only confirmed current issues'],
  ], f.minConfidence, v => set('minConfidence', +v),
    'Raising this shrinks the field fast, because confirming an issue takes two independent readings.'));
}

function activeFilterPills() {
  const f = state.filters;
  const d = defaultFilters();
  const pills = [];
  const add = (label, reset) => pills.push({ label, reset });
  if (f.maxPrice != null) add('≤ ₹' + f.maxPrice, () => f.maxPrice = null);
  if (f.format !== 'any') add(f.format, () => f.format = 'any');
  for (const l of f.languages) add(l, () => f.languages = f.languages.filter(x => x !== l));
  for (const l of f.frequency) add(l, () => f.frequency = f.frequency.filter(x => x !== l));
  for (const t of f.topicsWanted) add('+' + t, () => f.topicsWanted = f.topicsWanted.filter(x => x !== t));
  for (const t of f.topicsExcluded) add('−' + t, () => f.topicsExcluded = f.topicsExcluded.filter(x => x !== t));
  if (f.news !== 'any') add(f.news === 'exclude' ? 'no news' : 'news only', () => f.news = 'any');
  if (f.audience !== 'any') add(f.audience, () => f.audience = 'any');
  if (f.visual !== 'any') add(f.visual, () => f.visual = 'any');
  if (f.difficulty !== 'any') add(f.difficulty, () => f.difficulty = 'any');
  if (JSON.stringify(f.kinds) !== JSON.stringify(d.kinds)) {
    add(f.kinds.length ? f.kinds.join('/') : 'all types', () => f.kinds = d.kinds.slice());
  }
  if (f.minConfidence !== d.minConfidence) add('confidence ≥ ' + f.minConfidence, () => f.minConfidence = d.minConfidence);
  return pills;
}

function toggleDeck(open) {
  const deck = $('#deck');
  const want = open == null ? deck.hidden : open;
  deck.hidden = !want;
  $('#btnFilters').setAttribute('aria-expanded', String(want));
  if (want) renderDeck($('#deckGrid'));
}

/* -------------------------------------------------------------- onboarding */
/* Five hard constraints, all optional, and not one question about taste. The
   brief is explicit that the profile must not be seeded, and a questionnaire
   asking "which subjects interest you?" is seeding by another name — the
   answers would become the model's starting beliefs before a single magazine
   had been seen. Interests are collected from behaviour instead. */

function showOnboarding() {
  state.filters = state.filters || defaultFilters();
  const grid = $('#onboardGrid');
  grid.replaceChildren();
  const f = state.filters;
  const set = (k, v) => { f[k] = v; };

  grid.append(numberField('Most you would spend on one issue (₹)', f.maxPrice,
    v => set('maxPrice', v), 'Leave blank if you would rather not cap it.', { min: 0, step: 10, placeholder: 'no limit' }));
  grid.append(selectField('Print or digital', [
    ['any', 'Either'], ['print', 'Print only'], ['digital', 'Digital only'],
  ], f.format, v => set('format', v)));
  grid.append(selectField('Do you want news and current affairs?', [
    ['any', 'Do not mind'], ['exclude', 'Keep it out'], ['include', 'Yes, I want it'],
  ], f.news, v => set('news', v)));
  grid.append(selectField('Who is reading?', [
    ['any', 'Just me — no constraint'], ['child', 'Must suit a child'],
    ['both', 'Must suit a child and an adult'], ['adult', 'Adults only'],
  ], f.audience, v => set('audience', v)));
  grid.append(selectField('Language', [
    ['any', 'Any language'], ['English', 'English only'],
  ], f.languages.length ? 'English' : 'any',
    v => set('languages', v === 'any' ? [] : [v])));

  openModal('#onboardModal');
}

/* ----------------------------------------------------------------- modals */

function openModal(sel) { $(sel).hidden = false; }
function closeModal(sel) { $(sel).hidden = true; }

let rejectTarget = null;
let rejectKind = 'notInterested';

function openReject(rec, kind) {
  rejectTarget = rec;
  rejectKind = kind;
  $('#rejectTitle').textContent = (kind === 'skip' ? 'Skip: ' : 'Not interested: ') + rec.title;
  const wrap = $('#rejectReasons');
  wrap.replaceChildren();
  let chosen = null;
  for (const reason of REJECT_REASONS) {
    const b = el('button', {
      class: 'tiny ghost',
      onclick: () => {
        chosen = chosen === reason ? null : reason;
        for (const child of wrap.children) child.className = 'tiny ghost';
        if (chosen) b.className = 'tiny primary';
        wrap.dataset.chosen = chosen || '';
      },
    }, reason);
    wrap.append(b);
  }
  wrap.dataset.chosen = '';
  $('#rejectNote').value = '';
  openModal('#rejectModal');
}

function saveReject(withReason) {
  if (!rejectTarget) return;
  const reason = withReason ? ($('#rejectReasons').dataset.chosen || null) : null;
  const note = withReason ? ($('#rejectNote').value.trim() || null) : null;
  recordEvent(rejectKind, rejectTarget, { reason, note });
  closeModal('#rejectModal');
  toast(reason ? 'Noted — "' + reason + '" is acted on directly' : 'Noted');
  rejectTarget = null;
  render();
}

let buyTarget = null;
function openBuy(rec) {
  buyTarget = rec;
  $('#buyTitle').textContent = 'Bought: ' + rec.title
    + ((rec.issue && rec.issue.label) ? ' — ' + rec.issue.label : '');
  const inr = toInr(rec.price);
  $('#buyPrice').value = inr != null ? Math.round(inr) : '';
  $('#buyFormat').value = (rec.formats || []).includes('print') ? 'print' : 'digital';
  $('#buyWhere').value = (rec.offers[0] && rec.offers[0].seller) || '';
  openModal('#buyModal');
}

function saveBuy() {
  if (!buyTarget) return;
  const price = $('#buyPrice').value;
  recordEvent('buy', buyTarget, {
    pricePaid: price === '' ? null : +price,
    format: $('#buyFormat').value,
    where: $('#buyWhere').value.trim() || null,
  });
  closeModal('#buyModal');
  toast('Recorded. Purchases are the strongest signal the model has.');
  buyTarget = null;
  render();
}

/* ------------------------------------------------------------------ render */

const VIEWS = { month: viewMonth, browse: viewBrowse, taste: viewTaste, history: viewHistory, research: viewResearch };

const VIEW_HINTS = {
  month: 'One pick, a ranked shortlist, and the reasoning behind both. Recomputed from live data every month.',
  browse: 'Everything that currently clears your hard filters.',
  taste: 'What the app believes about you, the evidence for it, and the controls to correct it.',
  history: 'Issue-level record of everything recommended, seen, bought, rated and dismissed.',
  research: 'Sources, timestamps, extracted metadata, score arithmetic and exclusion reasons.',
};

function setView(v) {
  state.view = v;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function render() {
  for (const tab of $$('#tabs .tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === state.view));
  }
  $('#viewHint').textContent = VIEW_HINTS[state.view] || '';

  const pills = activeFilterPills();
  $('#filterCount').hidden = !pills.length;
  $('#filterCount').textContent = String(pills.length);
  const pillBox = $('#activePills');
  pillBox.replaceChildren();
  for (const p of pills) {
    pillBox.append(el('span', { class: 'pill' }, p.label,
      el('button', {
        title: 'Remove',
        onclick: () => { p.reset(); state.ranked = null; scheduleSave(); render(); },
      }, '×')));
  }

  $('#headline').textContent = headlineText();
  if (!$('#deck').hidden) renderDeck($('#deckGrid'));

  (VIEWS[state.view] || viewMonth)();
}

function headlineText() {
  const researched = state.magazines.size;
  const bits = [];
  bits.push(state.leads.length.toLocaleString('en-IN') + ' titles found on sale in India');
  bits.push(researched.toLocaleString('en-IN') + ' issues read');
  const t = taste();
  bits.push(t.empty ? 'no tastes learned yet' : t.eventCount + ' interactions learned from');
  if (state.meta.lastRefresh) bits.push('refreshed ' + ago(state.meta.lastRefresh));
  if (memoryOnly) bits.push('⚠ storage unavailable — this session will not be saved');
  return bits.join(' · ');
}

/* -------------------------------------------------------------------- wire */

function wire() {
  $('#versionBadge').textContent = 'v' + APP_VERSION;

  for (const tab of $$('#tabs .tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  $('#btnFilters').addEventListener('click', () => toggleDeck());
  $('#btnRefresh').addEventListener('click', () => runRefresh());
  $('#btnStop').addEventListener('click', () => { state.abort = true; toast('Stopping after the current fetch…'); });
  $('#btnClearFilters').addEventListener('click', () => {
    state.filters = defaultFilters();
    state.ranked = null;
    scheduleSave();
    render();
  });
  $('#btnCollapse').addEventListener('click', () => {
    const open = $('#barStats').hidden;
    $('#barStats').hidden = !open;
    if (!open) $('#deck').hidden = true;
    $('#btnCollapse').setAttribute('aria-expanded', String(open));
  });
  $('#btnTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => { $('#btnTop').hidden = window.scrollY < 700; });

  $('#onboardStart').addEventListener('click', () => {
    state.meta.onboarded = true;
    closeModal('#onboardModal');
    scheduleSave();
    render();
    runRefresh();
  });
  $('#onboardSkip').addEventListener('click', () => {
    state.filters = defaultFilters();
    state.meta.onboarded = true;
    closeModal('#onboardModal');
    scheduleSave();
    render();
    runRefresh();
  });

  $('#btnSettings').addEventListener('click', () => {
    $('#setBudget').value = state.meta.budget;
    $('#setJinaKey').value = state.meta.jinaKey || '';
    $('#setExplore').value = state.meta.exploreRate;
    $('#setExploreOut').textContent = exploreCopy(state.meta.exploreRate);
    openModal('#settingsModal');
  });
  $('#settingsClose').addEventListener('click', () => closeModal('#settingsModal'));
  $('#setBudget').addEventListener('change', e => { state.meta.budget = clamp(+e.target.value, 10, 600); scheduleSave(); });
  $('#setJinaKey').addEventListener('change', e => { state.meta.jinaKey = e.target.value.trim(); scheduleSave(); });
  $('#setExplore').addEventListener('input', e => {
    state.meta.exploreRate = +e.target.value;
    $('#setExploreOut').textContent = exploreCopy(state.meta.exploreRate);
    state.ranked = null;
    scheduleSave();
  });

  $('#btnExport').addEventListener('click', exportAll);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importAll);
  $('#btnClearCache').addEventListener('click', async () => {
    state.cache.clear();
    await idbDel('cache', 'all');
    toast('Discovery cache cleared — the next refresh reads everything fresh');
  });
  $('#btnResetTaste').addEventListener('click', () => {
    if (!confirm('Delete every recorded interaction? Filters and discovered magazines are kept. This cannot be undone.')) return;
    state.events = [];
    state.overrides = {};
    state.meta.cycles = {};
    tasteCache.key = '';
    state.ranked = null;
    scheduleSave();
    closeModal('#settingsModal');
    toast('Taste model erased — back to a clean profile');
    render();
  });

  $('#rejectSave').addEventListener('click', () => saveReject(true));
  $('#rejectSkip').addEventListener('click', () => saveReject(false));
  $('#buySave').addEventListener('click', saveBuy);
  $('#buyCancel').addEventListener('click', () => closeModal('#buyModal'));

  for (const modal of $$('.modal')) {
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') for (const m of $$('.modal')) m.hidden = true;
  });
}

const exploreCopy = v => v === 0
  ? 'Off — recommendations stay inside what you have shown you like.'
  : v + '% of months will carry one clearly-labelled pick from outside your usual subjects.';

async function exportAll() {
  const blob = new Blob([JSON.stringify({
    version: APP_VERSION, at: Date.now(),
    magazines: Array.from(state.magazines.values()),
    leads: state.leads, events: state.events,
    filters: state.filters, overrides: state.overrides,
    merges: state.merges, meta: state.meta,
  }, null, 1)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'maglens-' + new Date().toISOString().slice(0, 10) + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function importAll(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    state.magazines = new Map((data.magazines || []).map(m => [m.id, normaliseRecord(m)]));
    state.leads = data.leads || [];
    state.events = data.events || [];
    state.filters = { ...defaultFilters(), ...(data.filters || {}) };
    state.overrides = data.overrides || {};
    state.merges = data.merges || [];
    Object.assign(state.meta, data.meta || {});
    tasteCache.key = '';
    state.ranked = null;
    dfCache.size = -1;
    await saveState();
    toast('Imported');
    render();
  } catch (err) {
    toast('Import failed: ' + (err && err.message));
  }
  e.target.value = '';
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  wire();
  await loadState();
  if (!state.filters) state.filters = defaultFilters();
  for (const rec of state.magazines.values()) rebuildRecord(rec);
  render();

  if (!state.meta.onboarded) {
    showOnboarding();
    return;
  }

  // A new calendar month means the answer is stale by definition, whatever the
  // cache says: the issue on the shelf has changed even if nothing else has.
  const monthChanged = state.meta.lastRefreshMonth !== nowMonth();
  const old = Date.now() - (state.meta.lastRefresh || 0) > 6 * 864e5;
  if (!state.magazines.size) {
    runRefresh();
  } else if (monthChanged || old) {
    toast(monthChanged
      ? 'New month — refreshing to see what is actually on sale now'
      : 'Data is over a week old — refreshing');
    runRefresh();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
