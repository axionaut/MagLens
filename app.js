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

   It learns two ways, both of them one click:

     - A PAIRWISE CHOICE, at the top of the month view: two magazines drawn from
       opposite ends of the newsstand, "which would you rather read". This is the
       primary signal. Everything the two share cancels out and only what makes
       them different is recorded (applyPair), which is why a single answer
       separates a dozen dimensions at once and why near-universal facets like
       "English" or "Monthly" can never accumulate spurious evidence.

     - UP AND DOWN ARROWS on every card in the ranked list. An arrow beside a
       ranked row means "this one beats the one above it", so that is what it
       records: a `prefer` between the two ADJACENT rows, the same event the duel
       produces. The title moves about a place, pressing again compares it with
       its new neighbour, and the list is always re-ranked from the model rather
       than from a stored position.

   Hard constraints — language, price, format, whether to show pornography, and
   the list of BLOCKED titles — are never learned and never written by the model.
   They live in the filter deck and only the user sets them. A block is the
   bluntest of them: it removes a title from the app for good and teaches the
   taste model nothing, because people block for reasons that say nothing about
   taste (they already subscribe, it is not sold near them).

   Layering, in dependency order, each section marked with a banner below:
     util → state → persistence → net → connectors → normalise → dedupe →
     issue identification → content understanding → filters → learning →
     ranking → history → views → boot

   Source-specific extraction lives only inside CONNECTORS. Retailer markup
   changes constantly; nothing outside that section may know what a Magzter page
   looks like.                                                                */

const APP_VERSION = 10;

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
// In a browser, the plain-HTML fallbacks are unusable because they reject
// cross-origin requests with no Access-Control-Allow-Origin. The app therefore
// only uses the reader proxy in browser mode; the original fallbacks remain in
// the list for non-browser tooling, but they are never attempted in the shipped
// static app.
const BASE_PROXIES = [
  { id: 'jina',       label: 'r.jina.ai',      kind: 'text',
    url: u => 'https://r.jina.ai/' + u },
];

const FALLBACK_PROXIES = [
  { id: 'allorigins', label: 'allorigins.win', kind: 'html',
    url: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { id: 'codetabs',   label: 'codetabs.com',   kind: 'html',
    url: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
];

const PROXIES = typeof window !== 'undefined' ? BASE_PROXIES : [...BASE_PROXIES, ...FALLBACK_PROXIES];

// Some hosts do send Access-Control-Allow-Origin and can be read directly from
// the browser. That matters for more than speed: a direct fetch originates in
// India, so prices and availability are the ones actually offered here, while a
// proxied fetch originates wherever the proxy lives and can return another
// store's currency. Direct reads are therefore marked `inRegion: true` and are
// trusted more by the price model.
// Each of these was checked for Access-Control-Allow-Origin before being listed.
// That check is the entire membership rule, and getting it wrong is not a
// harmless optimism: readwhere.com was listed here on assumption, sends no such
// header, and so would have failed in the browser — while in a Node harness,
// where nothing enforces CORS, it "worked" and quietly returned raw markup to a
// parser expecting reader output. Every Readwhere title came back with no
// issue, no price and no cover, and the harness reported success.
//
// openthemagazine.com and frontline.thehindu.com answer but send no header, so
// they are NOT here and go through the proxy like everything else.
const DIRECT_OK = [
  'query.wikidata.org',
  'www.autocarindia.com',
  'www.theweek.in',
  'www.sanctuarynaturefoundation.org',
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

// Requests are paced by TWO numbers, not one, because the reader proxy turns
// out to care far more about how many requests are open at once than about how
// closely spaced they are. Measured: eight parallel reads of the same page
// completed in 6.6s where the same eight in series took 35s, and sixteen
// parallel all returned 200 in 8s. Serialising was costing a factor of five for
// nothing.
const PACE_MS = 90;        // minimum spacing between two starts
const CONCURRENCY = 12;    // how many may be in flight at once

// Nearly all of a page read is spent waiting, and the wait has a long tail:
// measured across eight parallel reads, seven returned in 3.3–4.4s and one took
// 17s. A straggler holding a slot for the full timeout is what actually caps
// throughput, so the per-attempt timeout is short and a request that overruns
// it is abandoned to the next proxy rather than allowed to block the queue.
// Nothing is lost by giving up early — the fallbacks exist for precisely this.
const ATTEMPT_TIMEOUT_MS = 20000;
const SITEMAP_TIMEOUT_MS = 90000;   // several megabytes, once a week

// Raised from 90 now that a refresh is roughly five times faster; a first run
// still lands inside a couple of minutes and reads far more of the newsstand.
const DEFAULT_BUDGET = 150;

// How much louder an action is than passive noticing. Purchases and explicit
// ratings dominate by design (requirement: "weight stronger actions more
// heavily"), and a skip is worth very little because skipping is one flick of a
// thumb over a card that was barely read.
const EVENT_WEIGHT = {
  buy:           3.0,
  // A forced choice between two real magazines. Stronger than a like because it
  // is comparative: "this one, not that one" fixes a direction, where a like
  // only says "not nothing". See applyPair() for why that makes it cheap to
  // learn from — everything the two share cancels out and only the differences
  // survive, which is exactly the prevalence problem the facet damping in
  // discriminativeness() was invented to paper over.
  prefer:        2.6,
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
  // Also zero, and for a stronger reason: see the blocking section. A block is
  // a statement about one magazine's place in this app, not about taste.
  block:         0,
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
  // Already in score units — see scoreCandidate.
  nudge:          1.0,
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

// A toast with a single action on it. Used by anything instant and reversible,
// so the reversal is offered where the action happened rather than filed away
// in a settings screen the user has to go looking for.
function toastAction(msg, label, fn, ms = 7000) {
  const t = $('#toast');
  t.replaceChildren();
  t.append(el('span', {}, msg));
  t.append(el('button', {
    class: 'tiny',
    style: 'margin-left:12px',
    onclick: () => { t.hidden = true; clearTimeout(toast._t); fn(); },
  }, label));
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
  merges: [],             // manual duplicate decisions: {a, b, verdict}
  // Titles the user never wants to see again. A hard gate, not a preference:
  // kept OUT of `filters` deliberately, so that "Reset filters" cannot silently
  // unblock a magazine somebody took the trouble to block. Entries carry the
  // canonical title as well as the record id, because a record can be merged,
  // split or rediscovered under a new id and a block that leaks in those cases
  // is worse than useless.
  blocked: [],            // [{ id, canon, title, at, note }]
  // Manual ranking adjustments from the up/down arrows: recordId -> score
  // delta. The learning half of a vote cannot be trusted to move the title
  // itself — boosting "finance" lifted the finance magazine ABOVE the one being
  // voted up and the voted title went DOWN a place, which is indefensible from
  // a button with an arrow on it. So the vote does two things: it teaches
  // (applyPair, from the adjacent pair) and it asserts a position. This is the
  // assertion: an explicit, visible, reversible user correction that wins.
  nudges: {},             // recordId -> additive score delta
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
    // English by default. This is a hard constraint and a statement about what
    // the reader can read, not a taste — an English-only reader handed a Hindi
    // monthly has been handed nothing, however well it scores.
    languages: ['English'],
    // When an English-only filter is on, what to do with a title whose language
    // could not be established. 'latin' keeps it if its name is in Latin script
    // and flags it; 'strict' drops everything not positively identified.
    unknownLanguage: 'latin',
    hideExplicit: true,       // pornography and erotica, never a taste question
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

let migratedFilters = false;

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

    // v3 added an English-only default, a strictness setting for titles whose
    // language cannot be read, and a pornography filter. Spreading the stored
    // filters over the defaults preserves the old values, which for `languages`
    // means the old "any language" empty array wins and the new default never
    // arrives. These three are therefore migrated explicitly, once, and only
    // where the user had not already made a choice of their own.
    if (state.filters && (state.meta.filterVersion || 0) < 3) {
      if (!state.filters.languages || !state.filters.languages.length) {
        state.filters.languages = ['English'];
      }
      if (state.filters.hideExplicit == null) state.filters.hideExplicit = true;
      if (!state.filters.unknownLanguage) state.filters.unknownLanguage = 'latin';
      state.meta.filterVersion = 3;
      migratedFilters = true;
    }
    state.merges = meta.merges || [];
    state.blocked = meta.blocked || [];
    state.nudges = meta.nudges || {};
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
    merges: state.merges,
    blocked: state.blocked, nudges: state.nudges,
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

// One limiter per upstream. A fixed sleep between requests is wrong in both
// directions: too slow when the proxy is healthy, and not slow enough the moment
// it starts shedding load. This holds a concurrency semaphore AND a minimum
// spacing, and moves both on live evidence rather than trusting either number.
//
// Concurrency is the one that matters for throughput and the one that gets a
// proxy annoyed, so it is what gets cut first and hardest when the upstream
// complains: a 429 halves the slots outright, and they are earned back one at a
// time over runs of clean responses.
class AdaptiveLimiter {
  constructor(baseMs, slots) {
    this.gap = baseMs;
    this.base = baseMs;
    this.next = 0;
    this.good = 0;
    this.slots = slots;
    this.maxSlots = slots;
    this.inFlight = 0;
    this.queue = [];
  }

  async take() {
    // Wait for a slot.
    if (this.inFlight >= this.slots) {
      await new Promise(res => this.queue.push(res));
    }
    this.inFlight++;
    // …then for the minimum spacing, so a freed batch does not all leave together.
    const wait = this.next - Date.now();
    if (wait > 0) await sleep(wait);
    this.next = Date.now() + this.gap;
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    // Re-check against the current limit rather than waking blindly: bad() may
    // have cut the slots while this request was in flight.
    while (this.queue.length && this.inFlight < this.slots) {
      const res = this.queue.shift();
      res();
      break;
    }
  }

  ok() {
    if (++this.good >= 6) {
      this.good = 0;
      this.gap = Math.max(this.base * 0.6, this.gap * 0.85);
      if (this.slots < this.maxSlots) {
        this.slots++;
        while (this.queue.length && this.inFlight < this.slots) this.queue.shift()();
      }
    }
  }

  bad(hard) {
    this.good = 0;
    this.gap = Math.min(15000, this.gap * (hard ? 3 : 1.7));
    this.next = Date.now() + this.gap;
    if (hard) this.slots = Math.max(1, Math.floor(this.slots / 2));
    else this.slots = Math.max(1, this.slots - 1);
  }
}

const limiters = new Map();
// How many requests one END SITE may have open, regardless of how they get
// there. This is a separate question from what the proxy will carry, and
// ignoring it cost real data: twelve simultaneous reads of readwhere.com all
// returned HTTP 200 carrying the site's generic page instead of the requested
// title, so the app saw twelve titles with no issue, no price and no cover and
// no error anywhere to explain it. A shared CDN shrugs off a burst; one
// publisher's server answers it with a shrug of its own.
// Per-host allowances. Magzter is a large commercial CDN and returned 16/16
// parallel reads cleanly when measured, so throttling it to three made a
// refresh SLOWER than the sequential version it replaced — 120 pages went from
// ~120s to 205s. Readwhere is a smaller operation and is the one that answered
// a burst with its generic page, so it keeps the low allowance.
const HOST_SLOTS = {
  'www.magzter.com': 12,
  'files.magzter.com': 12,
  'html.duckduckgo.com': 4,
};
const HOST_CONCURRENCY = 3;   // anything not named above

function limiterFor(key) {
  if (!limiters.has(key)) {
    const host = key.startsWith('host:');
    const direct = key.startsWith('direct:');
    limiters.set(key,
      host ? new AdaptiveLimiter(120, HOST_SLOTS[key.slice(5)] || HOST_CONCURRENCY)
      : direct ? new AdaptiveLimiter(250, 3)
      : new AdaptiveLimiter(PACE_MS, CONCURRENCY));
  }
  return limiters.get(key);
}

// Runs `worker` over `items` with at most `n` outstanding at a time. The
// limiter above already caps real concurrency per upstream; this exists so the
// refresh loop can keep that many requests queued rather than feeding them one
// at a time, and so progress can be reported as they land rather than in order.
async function pooled(items, n, worker) {
  const queue = items.slice();
  let done = 0;
  const runners = [];
  for (let i = 0; i < Math.min(n, queue.length); i++) {
    runners.push((async () => {
      while (queue.length) {
        if (state.abort) return;
        const item = queue.shift();
        try { await worker(item, ++done); } catch { done++; }
      }
    })());
  }
  await Promise.all(runners);
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

  // Browser-side fetches cannot use the plain-HTML fallback proxies because they
  // reject CORS outright. Keeping them in the fallback list only avoids a false
  // sense of resilience in non-browser tooling; the shipped app never reaches
  // them here.

  let lastErr = '';
  for (const proxy of attempts) {
    if (state.abort) return { text: '', at: Date.now(), error: 'aborted', via: null };
    // Both gates, proxy then end site. Taken in a fixed order so two callers
    // can never hold one each and wait on the other.
    const lim = limiterFor(proxy.id + ':' + (proxy.id === 'direct' ? host : ''));
    const hostLim = limiterFor('host:' + host);
    await lim.take();
    await hostLim.take();
    const release = () => { lim.release(); hostLim.release(); };

    const headers = {};
    if (proxy.id === 'jina' && state.meta.jinaKey) {
      headers.Authorization = 'Bearer ' + state.meta.jinaKey;
    }

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeout || ATTEMPT_TIMEOUT_MS);
      const res = await fetch(proxy.url(url), { headers, signal: ctrl.signal });
      clearTimeout(t);

      if (!res.ok) {
        lim.bad(res.status === 429 || res.status === 403 || res.status === 451);
        release();
        lastErr = proxy.label + ' HTTP ' + res.status;
        logResearch({ kind: 'fetch', url, via: proxy.label, status: res.status, ok: false });
        bump('fetchFail');
        continue;
      }

      let text = await res.text();
      if (proxy.kind === 'html') text = htmlToText(text);
      if (text.trim().length < 120) {
        lim.bad(false);
        release();
        lastErr = proxy.label + ' returned an empty page';
        logResearch({ kind: 'fetch', url, via: proxy.label, status: 'empty', ok: false });
        continue;
      }

      lim.ok();
      release();
      const rec = {
        text, at: Date.now(), via: proxy.label,
        inRegion: !!proxy.inRegion, status: res.status, cached: false,
      };
      state.cache.set(key, rec);
      bump('fetchOk');
      logResearch({ kind: 'fetch', url, via: proxy.label, status: res.status, ok: true, bytes: text.length });
      return rec;
    } catch (err) {
      // A timeout says the upstream is slow, not that it is refusing us; only a
      // rate-limit or a block deserves the concurrency being halved. Treating
      // every straggler as hostile meant one 17-second response cut the pool in
      // half and the rest of the refresh crawled.
      lim.bad(false);
      release();
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
    issueLabel: null, coverUrl: null, publishedAt: null,
    issueDescription: null, magazineDescription: null,
    // Prose lifted from an actual article in this issue, plus who wrote it. The
    // first text in the app written BY the magazine rather than about it.
    articleProse: null, byline: null,
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
    const page = await fetchPage(this.sitemap, { ttl: TTL.universe, timeout: SITEMAP_TIMEOUT_MS });
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

  // One article from the issue, read in full. Deliberately one and not ten: the
  // story page carries a "more from this issue" block of about ten siblings with
  // their standfirsts, so a single request buys the prose of one piece AND a
  // summary of the rest. Ten requests would buy almost nothing more and would
  // cost ten times the budget.
  //
  // The longest piece is chosen rather than the first. A two-minute front-of-book
  // item is a caption; the long read is what the magazine is actually for, and it
  // is the piece that says what kind of magazine this is.
  async readOneStory(obs) {
    const withUrl = (obs.toc || []).filter(t => t.url);
    if (!withUrl.length) return;
    withUrl.sort((a, b) => (b.mins || 0) - (a.mins || 0));
    const page = await fetchPage(withUrl[0].url, { ttl: TTL.detail });
    if (!page.text) { obs.problems.push('article text unavailable'); return; }
    const st = parseMagzterStory(page.text);
    obs.articleProse = st.prose || null;
    obs.byline = st.byline;
    if (st.publishedAt && !obs.publishedAt) obs.publishedAt = st.publishedAt;
    // Siblings join the contents list, which is what the topic miner reads. They
    // are marked so their origin stays visible.
    const have = new Set((obs.toc || []).map(t => (t.title || '').toLowerCase()));
    for (const sib of st.siblings) {
      if (have.has(sib.title.toLowerCase())) continue;
      obs.toc.push({ ...sib, url: null, viaStory: true });
    }
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
    parseMagzterPage(page.text, stub, obs);
    await this.readOneStory(obs);
    return obs;
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
// as an interior preview. See COVER_TIER below for what the number means.
// The trailing number on a Magzter cover URL is a RESOLUTION TIER, not a page
// number, and mistaking it for one cost this app every cover it has ever shown.
// Measured against a live issue folder:
//
//   thumb/1.jpg    160 x 200     11 KB
//   view/1.jpg     320 x 400     34 KB
//   view/2.jpg     640 x 800    105 KB   <- same image, sixteen times the pixels
//   view/3.jpg     960 x 1200   194 KB
//   view/4.jpg    1280 x 1600   285 KB
//   view/5.jpg    1600 x 2000   379 KB
//
// Every one of them is the front cover; nothing above 5 exists, and a
// non-existent tier answers 400 rather than redirecting. pickMagzterCover was
// rewriting /view/N.jpg DOWN to /thumb/1.jpg, on the assumption that N was a
// page index and that view/2 would be page two of the magazine. So a 160x200
// image was being stretched across a card 215 CSS pixels wide, and twice that
// again on any modern display. It was never a resolution limit — the app was
// asking for the smallest file on offer.
const COVER_TIER = { card: 2, large: 3 };
const MAGZTER_SIZE_RE = /\/(?:thumb|view)\/\d+\.jpg/i;

function magzterTier(url, tier) {
  if (!url || url.indexOf('files.magzter.com') < 0) return url;
  return String(url).replace(MAGZTER_SIZE_RE, '/view/' + tier + '.jpg');
}

// The smallest tier, kept as the fallback for titles whose issue folder carries
// no view/ variants at all.
function magzterThumb(url) {
  if (!url || url.indexOf('files.magzter.com') < 0) return url;
  return String(url).replace(MAGZTER_SIZE_RE, '/thumb/1.jpg');
}

/* ------------------------------------------------------- reading the issue */
/* Until now the app judged a magazine on its cover lines and a shelf category —
   what the issue ADVERTISES about itself. A story page carries what it actually
   says, and two things are on it:

     1. the opening paragraphs of a real article, before the paywall cut. This is
        the first prose in the app written by the magazine rather than about it,
        and it is what makes "does this align with my interests" answerable on
        evidence instead of on keywords in a headline;
     2. a "more from this issue" block of roughly ten sibling articles, each with
        a headline and a full standfirst.

   The second is what makes this affordable. One request yields ten more article
   summaries, so reading an issue properly costs one fetch, not ten — which is
   why every issue the budget touches can have one rather than only the
   shortlist. */

function parseMagzterStory(text) {
  const out = { prose: '', byline: null, publishedAt: null, siblings: [] };

  const pub = /^Published Time:\s*(.+)$/m.exec(text);
  if (pub) { const d = Date.parse(pub[1]); if (!isNaN(d)) out.publishedAt = d; }

  const by = /^-\s*([A-Z][A-Z.\s]{2,40})$/m.exec(text);
  if (by) out.byline = by[1].trim();

  // The body runs to the paywall line; everything after it is promotional.
  const cut = text.indexOf('This story is from the');
  const body = cut > 0 ? text.slice(0, cut) : text;
  out.prose = body.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 90)
    .filter(l => !l.startsWith('[') && !l.startsWith('!') && !l.startsWith('#'))
    .filter(l => l.indexOf('](') < 0)
    .join(' ')
    .slice(0, 6000);

  // Siblings. The headline and its reading-time marker sit in one run of text,
  // so this has to be matched across the whole page rather than per block.
  const re = /##\s+([^\n]+?)\s+!\[Image \d+: time to read\]\([^)]*\)\s*(\d+)\s*mins?/g;
  let m;
  while ((m = re.exec(text))) {
    const whole = m[1].trim();
    const capRun = /^([A-Z0-9][A-Z0-9 '’&.,:!?()\-–—/]{3,}?)(?=\s+[A-Z][a-z])/.exec(whole);
    const title = capRun ? capRun[1].trim() : whole.slice(0, 120).trim();
    const blurb = capRun ? whole.slice(capRun[1].length).trim() : '';
    if (title) out.siblings.push({ title, blurb, mins: +m[2] });
    if (out.siblings.length >= 14) break;
  }
  return out;
}


function pickMagzterCover(text, obs) {
  const bare = /(^|[^(\[])!\[Image \d+:[^\]]*\]\((https:\/\/files\.magzter\.com\/resize\/magazine\/[^)]+)\)/m.exec(text);
  if (bare) return magzterTier(bare[2], COVER_TIER.card);
  // Fall back to the newest recent-issue thumbnail, but only when its label is
  // the issue we believe is current. A cover from the wrong month is worse than
  // no cover: it is a confident-looking lie about what is on the shelf.
  const first = obs.recentIssues[0];
  if (first && obs.issueLabel && first.label.toLowerCase() === obs.issueLabel.toLowerCase()) return magzterTier(first.cover, COVER_TIER.card);
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

/* --------------------------------------------------------------- wikidata */
/* The catalogue. Everything else in this file reads a shop; this reads the
   reference work, and it is the only source here that is comprehensive by
   construction rather than by whatever a retailer happens to stock.

   It answers a different question from the retailers and is therefore not in
   competition with them. Wikidata knows that Verve exists, that it is an
   English fashion magazine published in India, and where its own website is. It
   does not know what is on this month's cover or what it costs. Magzter and
   Readwhere know exactly that and nothing else. The two together are the whole
   picture, and neither alone is.

   Three things it gives that nothing else did:
     - 4,800 Indian titles, named properly, as a check on how much of the
       newsstand has actually been found
     - language and publisher for titles a retailer listed with neither
     - 3,800 OFFICIAL WEBSITES, which are primary sources for the current issue
       and the only route to a magazine no digital newsstand carries at all

   It is also the one source that needs no proxy: query.wikidata.org sends
   Access-Control-Allow-Origin, so the browser reads it directly, in India, with
   no rate limit worth the name. */

const WIKIDATA = {
  id: 'wikidata',
  label: 'Wikidata',
  endpoint: 'https://query.wikidata.org/sparql',

  // P31/P279* Q41298 is "is a magazine, or any subclass of one". The country
  // is taken three ways because Wikidata records it inconsistently: country of
  // origin, plain country, and the country a publication is published in.
  query: [
    'SELECT ?item ?itemLabel ?langLabel ?pubLabel ?freqLabel ?site ?inception',
    ' (GROUP_CONCAT(DISTINCT ?genreLabel;separator="|") AS ?genres) WHERE {',
    '  ?item wdt:P31/wdt:P279* wd:Q41298 .',
    '  { ?item wdt:P495 wd:Q668 } UNION { ?item wdt:P17 wd:Q668 } UNION { ?item wdt:P37 wd:Q668 }',
    '  OPTIONAL { ?item wdt:P407 ?lang . ?lang rdfs:label ?langLabel FILTER(lang(?langLabel)="en") }',
    '  OPTIONAL { ?item wdt:P123 ?pub  . ?pub  rdfs:label ?pubLabel  FILTER(lang(?pubLabel)="en") }',
    '  OPTIONAL { ?item wdt:P2896 ?freq. ?freq rdfs:label ?freqLabel FILTER(lang(?freqLabel)="en") }',
    '  OPTIONAL { ?item wdt:P136 ?g    . ?g    rdfs:label ?genreLabel FILTER(lang(?genreLabel)="en") }',
    '  OPTIONAL { ?item wdt:P856 ?site }',
    '  OPTIONAL { ?item wdt:P571 ?inception }',
    '  ?item rdfs:label ?itemLabel FILTER(lang(?itemLabel)="en")',
    '} GROUP BY ?item ?itemLabel ?langLabel ?pubLabel ?freqLabel ?site ?inception',
  ].join('\n'),

  async universe(ctx) {
    const url = this.endpoint + '?format=json&query=' + encodeURIComponent(this.query);
    let rows = [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(url, {
        headers: { Accept: 'application/sparql-results+json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      rows = (json.results && json.results.bindings) || [];
      logResearch({ kind: 'fetch', url: this.endpoint, via: 'direct', status: res.status, ok: true, note: rows.length + ' rows' });
    } catch (err) {
      logResearch({ kind: 'fetch', url: this.endpoint, via: 'direct', status: 'error', ok: false, note: String(err && err.message) });
      return { stubs: [], error: 'Wikidata query failed: ' + (err && err.message), at: Date.now() };
    }

    const val = x => (x && x.value) || null;
    const byTitle = new Map();
    for (const row of rows) {
      const title = val(row.itemLabel);
      if (!title) continue;
      const key = canonTitle(title);
      if (!key) continue;
      // Wikidata returns one row per website when a title has several. Keep the
      // first and let the rest fall away rather than creating duplicate leads
      // that the merge machinery would then have to undo.
      if (byTitle.has(key)) {
        const prev = byTitle.get(key);
        prev.site = prev.site || val(row.site);
        continue;
      }
      const genres = (val(row.genres) || '').split('|').filter(Boolean);
      byTitle.set(key, {
        sourceId: 'wikidata',
        url: val(row.item),
        title,
        publisher: val(row.pubLabel),
        language: val(row.langLabel),
        category: genres[0] || null,
        genres,
        site: val(row.site),
        frequency: val(row.freqLabel),
        inception: val(row.inception),
        region: 'IN',
        formats: [],
        catalogueOnly: true,
        order: byTitle.size,
      });
    }
    const stubs = Array.from(byTitle.values());
    if (ctx && ctx.note) {
      ctx.note('Wikidata: ' + stubs.length + ' Indian titles, ' +
        stubs.filter(x => x.site).length + ' with an official site');
    }
    return { stubs, at: Date.now() };
  },

  // A Wikidata row is a fact about a magazine, not a listing of one, so the
  // "detail" step records what the catalogue says and explicitly declines to
  // claim an issue or a price. Where the entry carries an official website, the
  // publisher connector is pointed at it — that is where a current issue can
  // actually be read.
  async detail(stub) {
    const obs = blankObservation(this, stub.url);
    obs.fetchedAt = Date.now();
    obs.title = stub.title;
    obs.publisher = stub.publisher;
    obs.language = stub.language;
    obs.category = stub.category;
    obs.frequency = stub.frequency;
    obs.availability = 'unknown';
    obs.catalogue = true;
    obs.magazineDescription = stub.genres && stub.genres.length
      ? stub.title + ' is described as: ' + stub.genres.join(', ') + '.'
      : null;

    if (!stub.site) {
      obs.problems.push('catalogue entry only — Wikidata lists no website, so no issue could be checked');
      return obs;
    }
    // Read the publisher's own page. This is the primary source the brief asks
    // to be preferred, and for a print-only title it is the only source there is.
    const pub = await PUBLISHER.detail({ url: stub.site, title: stub.title, publisher: stub.publisher });
    obs.issueLabel = pub.issueLabel;
    obs.offers = pub.offers;
    obs.formats = pub.formats;
    obs.coverUrl = pub.coverUrl;
    obs.via = pub.via;
    obs.inRegion = pub.inRegion;
    obs.availability = pub.issueLabel ? 'available' : 'unknown';
    obs.problems = obs.problems.concat(pub.problems);
    obs.sourceLabel = 'Wikidata + ' + hostOf(stub.site);
    obs.url = stub.site;
    return obs;
  },
};

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
/* India's other digital newsstand, and by some distance the most VALUABLE
   source here despite listing two per cent of what Magzter does — because it is
   an Indian site serving Indian prices. Magzter answers a proxied request from
   whatever country the proxy sits in and quotes that store, so its rupee prices
   are unreachable; Readwhere prints "Price : 30.00" in rupees on the page, and
   also prints the date the issue was actually published rather than leaving the
   cover date to be interpreted.

   It is therefore the corroborating source that turns a single-source "likely"
   into a two-source "verified", and the one that makes the price on a card a
   real number rather than an indicative foreign one.

   Its sitemap URLs carry three path segments and an id
   (/magazine/{publisher}/{Title}/{id}); an earlier version of this connector
   expected two and consequently matched nothing at all, which is why Readwhere
   contributed zero titles until now. */

const READWHERE = {
  id: 'readwhere',
  label: 'Readwhere',
  sitemap: 'https://www.readwhere.com/sitemap/titles/magazine/sitemap.xml',
  // Comics are magazines for this app's purposes — Tinkle and Amar Chitra Katha
  // live here — and are a shelf Magzter's India store covers unevenly.
  sitemaps: [
    ['https://www.readwhere.com/sitemap/titles/magazine/sitemap.xml', 'magazine'],
    ['https://www.readwhere.com/sitemap/titles/comic/sitemap.xml', 'Comics'],
  ],

  async universe(ctx) {
    const stubs = [];
    const seen = new Set();
    let at = 0, err = null;

    for (const [url, category] of this.sitemaps) {
      const page = await fetchPage(url, { ttl: TTL.universe, timeout: SITEMAP_TIMEOUT_MS });
      if (!page.text) { err = page.error || 'sitemap unreachable'; continue; }
      at = Math.max(at, page.at);
      // The sitemap lists each title twice — the title page and its issues
      // index. Only the first is worth reading, so /issues/ is excluded here
      // rather than deduplicated later.
      const re = /https?:\/\/(?:www\.)?readwhere\.com\/(?:magazine|comic)\/([^/\s<>"]+)\/([^/\s<>"]+)\/(\d+)\b/gi;
      let m;
      while ((m = re.exec(page.text))) {
        if (/^issues$/i.test(m[2])) continue;
        const canonical = 'https://www.readwhere.com/magazine/' + m[1] + '/' + m[2] + '/' + m[3];
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        stubs.push({
          sourceId: 'readwhere',
          url: canonical,
          title: unslug(m[2]),
          publisher: unslug(m[1]),
          category,
          region: 'IN',
          formats: ['digital'],
          order: stubs.length,
        });
      }
    }
    if (ctx && ctx.note) ctx.note('Readwhere: ' + stubs.length + ' Indian titles with rupee pricing');
    return { stubs, at: at || Date.now(), error: stubs.length ? null : err };
  },

  // One article from the issue, read in full. Deliberately one and not ten: the
  // story page carries a "more from this issue" block of about ten siblings with
  // their standfirsts, so a single request buys the prose of one piece AND a
  // summary of the rest. Ten requests would buy almost nothing more and would
  // cost ten times the budget.
  //
  // The longest piece is chosen rather than the first. A two-minute front-of-book
  // item is a caption; the long read is what the magazine is actually for, and it
  // is the piece that says what kind of magazine this is.
  async readOneStory(obs) {
    const withUrl = (obs.toc || []).filter(t => t.url);
    if (!withUrl.length) return;
    withUrl.sort((a, b) => (b.mins || 0) - (a.mins || 0));
    const page = await fetchPage(withUrl[0].url, { ttl: TTL.detail });
    if (!page.text) { obs.problems.push('article text unavailable'); return; }
    const st = parseMagzterStory(page.text);
    obs.articleProse = st.prose || null;
    obs.byline = st.byline;
    if (st.publishedAt && !obs.publishedAt) obs.publishedAt = st.publishedAt;
    // Siblings join the contents list, which is what the topic miner reads. They
    // are marked so their origin stays visible.
    const have = new Set((obs.toc || []).map(t => (t.title || '').toLowerCase()));
    for (const sib of st.siblings) {
      if (have.has(sib.title.toLowerCase())) continue;
      obs.toc.push({ ...sib, url: null, viaStory: true });
    }
  },

  async detail(stub) {
    const page = await fetchPage(stub.url, { ttl: stub.hot ? TTL.detailHot : TTL.detail });
    const obs = blankObservation(this, stub.url);
    obs.fetchedAt = page.at;
    obs.via = page.via;
    obs.inRegion = page.inRegion;
    obs.storeRegion = 'IN';   // an Indian site quoting rupees, whoever asked
    obs.formats = ['digital'];
    obs.title = stub.title;
    obs.publisher = stub.publisher;
    obs.category = stub.category;
    if (!page.text) {
      obs.problems.push('page unreachable: ' + (page.error || 'no response'));
      return obs;
    }
    return parseReadwherePage(page.text, stub, obs);
  },
};

function parseReadwherePage(text, stub, obs) {
  const lines = text.split('\n');

  // The detail block is a short run of rows carrying the current issue, its
  // price and its publication date. Anchoring on those rather than scanning the
  // whole page keeps the previous-issues carousel below from being read as the
  // current issue.
  //
  // Two shapes, because two routes can answer. The reader proxy marks them as
  // "##### Price : 25.00"; a plain-HTML proxy flattens them to bare lines. The
  // connector reads either rather than assuming it knows which one arrived —
  // which route a page came down is not something the parser should depend on.
  const heads = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = /^[*\-]?\s*#{3,6}\s*(.+?)\s*$/.exec(t);
    if (m) { heads.push(stripMd(m[1])); continue; }
    // Unmarked, but short and shaped like one of the rows we want.
    if (t.length <= 90 && /^(price\s*:|published on|published\s+(daily|weekly|monthly)|language\s*[-:]|issues\s+\d+)/i.test(t)) {
      heads.push(stripMd(t));
    } else if (t.length <= 40 && parseIssueLabel(stripMd(t)).precision === 'day') {
      heads.push(stripMd(t));
    }
  }

  const priceRow = heads.find(h => /^price\s*:/i.test(h));
  if (priceRow) {
    const amt = /([\d,]+(?:\.\d+)?)/.exec(priceRow);
    if (amt) {
      const amount = parseFloat(amt[1].replace(/,/g, ''));
      if (Number.isFinite(amount) && amount > 0) {
        obs.offers.push({
          kind: 'single', issues: 1, amount, currency: 'INR',
          seller: 'Readwhere', format: 'digital', url: obs.url,
        });
      }
    }
  }

  // "Published on Sep 4, 2026" — a real publication date, which is far better
  // evidence than a cover date. Cover dates routinely run ahead of the day an
  // issue reaches a shelf, and this is the only source here that states both.
  const pub = heads.find(h => /^published on/i.test(h))
    || (/Published on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(text) || [])[0];
  if (pub) {
    const d = Date.parse(String(pub).replace(/^published on\s*/i, ''));
    if (Number.isFinite(d)) obs.publishedAt = d;
  }

  // The current issue is the dated heading that is not the price and not the
  // publication date.
  for (const h of heads) {
    if (/^price\s*:/i.test(h) || /^published on/i.test(h) || /^issues\s+\d+$/i.test(h)) continue;
    if (parseIssueLabel(h).precision !== 'none') { obs.issueLabel = h; break; }
  }

  // Cover: the issue-scoped image, never the title-scoped one, so a magazine
  // whose masthead art is stale cannot supply a wrong-looking current cover.
  const cover = /(https?:\/\/[^\s)"']*coverforissue\/\d+\/[a-z]+\/\d+)/i.exec(text);
  if (cover) obs.coverUrl = cover[1];

  // Previous issues, for cadence and for confirming nothing newer is listed.
  // Readwhere puts the issue date in the URL slug of every back issue, which is
  // route-independent — it survives markdown extraction and HTML flattening
  // alike — so that is what is read rather than the surrounding markup.
  const seenIssue = new Set();
  const slugRe = /readwhere\.com\/(?:magazine|comic)\/[^/\s)"']+\/[^/\s)"']+\/([A-Za-z0-9-]+)\/(\d{5,})/g;
  let pm;
  while ((pm = slugRe.exec(text))) {
    if (seenIssue.has(pm[2])) continue;
    const label = decodeURIComponent(pm[1]).replace(/-/g, ' ').trim();
    if (!label || parseIssueLabel(label).precision === 'none') continue;
    seenIssue.add(pm[2]);
    obs.recentIssues.push({
      label,
      cover: 'https://iacache.epapr.in/read/imageapi/coverforissue/' + pm[2] + '/magazine/300',
      url: pm[0].startsWith('http') ? pm[0] : 'https://www.' + pm[0],
    });
    if (obs.recentIssues.length >= 14) break;
  }
  // Newest first, so recentIssues[0] means what the rest of the app assumes.
  obs.recentIssues.sort((a, b) =>
    (parseIssueLabel(b.label).date || 0) - (parseIssueLabel(a.label).date || 0));
  if (!obs.issueLabel && obs.recentIssues.length) obs.issueLabel = obs.recentIssues[0].label;

  // The standing description sits in the "About" block.
  const about = lines.findIndex(l => /About Issue|About the Magazine|About Magazine/i.test(l));
  if (about >= 0) {
    for (let i = about + 1; i < Math.min(about + 14, lines.length); i++) {
      const t = lines[i].trim();
      if (t.length > 120 && !isMarkupLine(t)) { obs.magazineDescription = stripMd(t); break; }
    }
  }
  if (!obs.magazineDescription) {
    const longest = lines.map(l => l.trim())
      .filter(l => l.length > 220 && !isMarkupLine(l))
      .sort((a, b) => b.length - a.length)[0];
    if (longest) obs.magazineDescription = stripMd(longest);
  }

  obs.availability = obs.issueLabel ? 'available' : 'unknown';
  if (!obs.issueLabel) obs.problems.push('no issue label could be read from the Readwhere page');
  return obs;
}

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

const CONNECTORS = {
  magzter: MAGZTER, readwhere: READWHERE, wikidata: WIKIDATA,
  publisher: PUBLISHER, websearch: WEBSEARCH,
};

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
  // Mastheads punctuate loosely — "September 14 , 2026" with a space before the
  // comma is real Readwhere output, and it fell all the way through to the
  // bare-year branch, losing a full cover date and the freshness check with it.
  const low = s.toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Numeric dates: 04-09-2026, 28/08/2026. Day-first, which is the convention
  // everywhere this app looks — the sources are Indian sites. Where the first
  // number is over 12 that is certain; where both could be a month it is a
  // convention rather than a deduction, so it is still taken as day-first but
  // the whole label is only ever used alongside the corroborating evidence in
  // identifyCurrentIssue().
  // A space counts as a separator too: back-issue dates are recovered from URL
  // slugs, so "04-09-2026" reaches here as "04 09 2026" once the slug is
  // un-hyphenated.
  const numeric = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(low);
  if (numeric) {
    let day = +numeric[1], mon = +numeric[2];
    if (day <= 12 && mon > 12) { const t = day; day = mon; mon = t; }
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const yr = +numeric[3];
      return { precision: 'day', date: Date.UTC(yr, mon - 1, day), month: yr * 12 + (mon - 1), text: s };
    }
  }

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
// The key every duplicate decision rests on, so what it fails to normalise
// arrives as two magazines. Four classes of difference were getting through and
// each was producing real duplicates in the corpus:
//
//   diacritics    "Café Society" vs "Cafe Society" — the old rule deleted the
//                 accented letter outright rather than folding it, so these
//                 normalised to "caf society" and "cafe society"
//   ampersands    "Home & Style" vs "Home and Style"
//   filler words  "Femina India" vs "Femina", "Vogue Print" vs "Vogue"
//   punctuation   smart quotes, en dashes, stray full stops
//
// Folding happens through NFD so a combining mark can be stripped separately
// from the letter it sits on, which is what turns é into e instead of nothing.
// The key every duplicate decision rests on, so whatever it fails to normalise
// arrives in the app as two magazines. Four classes were getting through, and
// each was producing real duplicates in the corpus:
//
//   diacritics    "Café Society" vs "Cafe Society" — the old rule DELETED the
//                 accented letter rather than folding it, so these normalised
//                 to "caf society" and "cafe society" and never met
//   ampersands    "Home & Style" vs "Home and Style"
//   qualifiers    "Femina India" vs "Femina", "Vogue (India Edition)" vs "Vogue"
//   punctuation   smart quotes, en dashes, stray stops
//
// Folding goes through NFD so a combining mark can be stripped separately from
// the letter it sits on, which is what turns é into e rather than into nothing.
const TITLE_NOISE = new RegExp('\\b(?:' + [
  'magazine', 'magazines', 'the', 'a', 'an', 'and', 'of',
  'edition', 'editions', 'issue', 'issues', 'vol', 'volume',
  'pdf', 'epaper', 'official',
  'ltd', 'pvt', 'limited', 'inc', 'llp',
].join('|') + ')\\b', 'g');

// Words that are noise ONLY at the end of a title, where they describe the
// format rather than name the product. Stripped in a loop so "Vogue Magazine
// Digital" unwinds completely.
//
// Deliberately short, and what is NOT in it matters more than what is. A
// trailing "India" looks like the same kind of qualifier and is not: Top Gear
// India is a separately licensed magazine from Top Gear, and the original code
// carried an explicit warning against merging them. A trailing "Hindi" or
// "English" is worse still — India Today Hindi is a different publication from
// India Today, and folding them together would also defeat the language filter,
// which is a hard constraint.
//
// Those cases are not ignored, they are routed elsewhere: duplicateCandidates
// already treats "one title extends the other by a single token" as a merge to
// OFFER, scored by whether the publisher matches. Femina / Femina India is
// surfaced there for a human, which is the right place for a judgement that a
// string cannot settle.
const TRAILING_QUALIFIER = /s+(?:magazine|edition|print|digital|online|pdf|epaper)$/;

function canonTitle(t) {
  let s = String(t || '')
    .normalize('NFD')                        // split é into e + combining acute
    .replace(/[̀-ͯ]/g, '')         // …then drop the mark, keep the letter
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")   // smart quotes
    .replace(/[‐-―]/g, '-')              // en and em dashes
    .replace(/\(.*?\)/g, ' ')                      // "(India Edition)"
    .replace(/&/g, ' and ')                        // before the noise pass removes it
    .replace(TITLE_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  let prev;
  do { prev = s; s = s.replace(TRAILING_QUALIFIER, '').trim(); } while (s !== prev);
  return s;
}

// Normalised edit distance between two canonical titles, used only to OFFER a
// merge and never to make one. A typo is the one duplicate class no amount of
// tidy normalisation can reach — "Buisness Today" and "Business Today" differ by
// a transposition and nothing else — so it is measured rather than matched.
// Bounded early: two titles of very different lengths are not typos of one
// another, and the early return keeps this off the hot path for the 10,000-lead
// case.
function titleDistance(a, b) {
  if (a === b) return 0;
  if (!a || !b) return 1;
  if (Math.abs(a.length - b.length) > 3) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, k) => k);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n] / Math.max(m, n);
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

// Romanised Indic titles are the hole every script check falls through:
// Grihshobha, Saras Salil and Sarita are Hindi magazines written in Latin
// letters, so SCRIPT_RANGES never fires and the language came back null — which
// then sailed through an English-only filter, because the filter only rejected
// languages it could name. These are title words that do not occur in English
// magazine names and do occur constantly in Indic ones.
const INDIC_TITLE_CUES = [
  ['Hindi', ['grihshobha', 'saras', 'salil', 'sarita', 'kadambini', 'dharmyug', 'nandan',
    'champak hindi', 'meri saheli', 'grehlakshmi', 'vanitha hindi', 'aha zindagi',
    'india today hindi', 'rozgar', 'samachar', 'patrika', 'jagran', 'bhaskar',
    'kalyan', 'manorama hindi', 'pratiyogita', 'darpan', 'gyan', 'vigyan',
    'sarvottam', 'navneet', 'hans', 'akhand jyoti']],
  ['Marathi', ['lokprabha', 'saptahik', 'sakal', 'maher', 'grihshobhika', 'chitralekha marathi']],
  ['Gujarati', ['chitralekha', 'abhiyaan', 'safari', 'akila', 'navchetan', 'gujarat']],
  ['Tamil', ['kumudam', 'vikatan', 'kalki', 'dinamalar', 'aval', 'mangayar', 'puthiya']],
  ['Malayalam', ['manorama', 'mathrubhumi', 'vanitha', 'grihalakshmi', 'bhashaposhini', 'kalakaumudi']],
  ['Telugu', ['swathi', 'chatura', 'navya', 'eenadu', 'sakshi', 'andhra']],
  ['Kannada', ['taranga', 'sudha', 'mayura', 'prajavani', 'karmaveera']],
  ['Bengali', ['anandabazar', 'desh', 'sananda', 'anandamela', 'sarodiya', 'bartaman']],
  ['Punjabi', ['ajit', 'jagbani', 'preetlari']],
  ['Urdu', ['urdu', 'inquilab', 'siasat', 'munsif']],
  ['Odia', ['samaja', 'dharitri', 'sambad']],
];

// A language name as a bare word in the title or category is a direct
// statement, and Magzter uses it constantly ("Grihshobha - Hindi").
const LANGUAGE_WORDS = ['Hindi', 'Bengali', 'Punjabi', 'Gujarati', 'Odia', 'Oriya', 'Tamil',
  'Telugu', 'Kannada', 'Malayalam', 'Urdu', 'Marathi', 'Assamese', 'Sanskrit',
  'Nepali', 'Konkani', 'Sindhi', 'Bhojpuri', 'English'];

// Detection now reads, in falling order of authority: what the source declared,
// the script the title is written in, the script the ISSUE TEXT is written in,
// a language named outright in the title or shelf, and finally a romanised
// Indic title word. Everything before the last is evidence; the last is a
// heuristic and is reported as one, which is why the basis comes back with it.
function normLanguage(declared, title, extra = {}) {
  const say = (lang, basis) => ({ language: lang, basis });

  if (declared) {
    const d = String(declared).trim();
    if (d && !/^n\/?a$/i.test(d)) {
      return say(d.charAt(0).toUpperCase() + d.slice(1), 'the source states it');
    }
  }
  for (const [re, name] of SCRIPT_RANGES) {
    if (re.test(String(title || ''))) return say(name, 'the title is written in ' + name + ' script');
  }

  // The issue's own text. A Latin-script title over Devanagari cover lines is a
  // Hindi magazine, and this is the only place that can be seen.
  const body = String(extra.text || '');
  if (body) {
    for (const [re, name] of SCRIPT_RANGES) {
      const hits = (body.match(new RegExp(re.source, 'g')) || []).length;
      if (hits >= 12) return say(name, name + ' script across the issue text');
    }
  }

  const hay = (String(title || '') + ' ' + String(extra.category || '')).toLowerCase();
  for (const w of LANGUAGE_WORDS) {
    const re = new RegExp('(^|[^a-z])' + w.toLowerCase() + '($|[^a-z])');
    if (re.test(hay)) return say(w === 'Oriya' ? 'Odia' : w, 'named in the title or shelf');
  }

  for (const [name, cues] of INDIC_TITLE_CUES) {
    for (const cue of cues) {
      const re = new RegExp('(^|[^a-z])' + escapeRe(cue) + '($|[^a-z])');
      if (re.test(hay)) return say(name, 'the title reads as a ' + name + ' one');
    }
  }

  return say(null, 'nothing on the page names a language');
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
  // Everything readable about this title, so a Latin-script name over
  // Devanagari cover lines is still recognised as Hindi.
  const langText = obs.map(o => [
    o.issueDescription || '', o.magazineDescription || '',
    (o.toc || []).map(t => (t.title || '') + ' ' + (t.blurb || '')).join(' '),
    (o.recentIssues || []).map(r => r.label || '').join(' '),
  ].join(' ')).join(' ').slice(0, 6000);
  if (rec.manual.language) {
    rec.language = rec.manual.language;
    rec.languageBasis = 'you set it by hand';
  } else {
    const det = normLanguage(langP && langP.value, rec.title, { text: langText, category: rec.category });
    rec.language = det.language;
    rec.languageBasis = det.basis;
  }

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

  // A stated publication date beats every inference available. If a source says
  // this issue went out four days ago, nothing about cover-date convention or
  // cadence estimation can improve on that.
  const published = obs.map(o => o.publishedAt).filter(Boolean).sort((a, b) => b - a)[0];
  if (published) {
    const sincePub = (Date.now() - published) / 864e5;
    const cycle = (rec.frequency && rec.frequency.days) || 30;
    if (sincePub >= -2 && sincePub <= cycle * 1.35) {
      conf += 0.22;
      reasons.push('the source states it was published on ' + fmtDate(published));
    } else if (sincePub > cycle * 2.5) {
      conf -= 0.2;
      reasons.push('the source states it was published on ' + fmtDate(published) +
        ', which is well over a cycle ago');
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
    publishedAt: published || null,
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
  // Typos and transpositions. Nothing above can reach these: "Buisness Today"
  // normalises to a different string from "Business Today" and always will, so
  // the difference is measured instead. Offered, never merged automatically —
  // "Vogue" and "Rogue" sit 0.20 apart, so any threshold loose enough to be
  // useful is also loose enough to be wrong, and a wrong automatic merge
  // destroys two records' histories.
  const seenPair = new Set(pairs.map(p => [p.a.id, p.b.id].sort().join('|')));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const d = titleDistance(keys[i], keys[j]);
      if (d === 0 || d > 0.15) continue;
      for (const ra of byTitle.get(keys[i])) for (const rb of byTitle.get(keys[j])) {
        if (seenPair.has([ra.id, rb.id].sort().join('|'))) continue;
        const samePub = ra.publisher && rb.publisher
          && canonTitle(ra.publisher) === canonTitle(rb.publisher);
        pushPair(ra, rb, samePub ? 0.7 : 0.3,
          'titles differ by ' + Math.round(d * 100) + '% — a probable misspelling'
          + (samePub ? ', same publisher' : ', different publishers'));
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
// The ontology names, as a set. Used to tell a real subject from a mined
// phrase, which matters wherever 'what is this magazine about' is asked.
const SUBJECT_NAMES = new Set(SUBJECTS.map(s => s[0]));

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

// Pornography and erotica, kept strictly apart from ADULT_CUES above. The two
// were the same list, which meant a cocktail recipe and a porn magazine landed
// in the same bucket — and since that bucket was only ever used to set
// `audience: 'adult'`, there was no way to exclude the second without also
// excluding The Economist. These cues exist to answer one question only: is
// this magazine pornography. A whisky column is not.
const EXPLICIT_CUES = ['erotic', 'erotica', 'pornographic', 'pornography', 'porn ',
  'nude', 'nudes', 'nudity', 'naked', 'topless', 'centerfold', 'centrefold',
  'playmate', 'pin-up', 'pinup', 'escort', 'fetish', 'bdsm', 'kink',
  'xxx', 'hardcore', 'softcore', 'adult entertainment', 'adults only',
  'sexually explicit', 'explicit content', 'uncensored', 'boudoir'];

// Strong enough on their own: a title containing one of these is pornography
// whatever the body text says, and a body-text cue count can be fooled by a
// single stray word in a book review.
const EXPLICIT_TITLE_CUES = ['playboy', 'penthouse', 'hustler', 'maxim', 'fhm',
  'erotic', 'erotica', 'nude', 'naked', 'porn', 'xxx', 'fetish', 'kink',
  'escort', 'boudoir', 'seduction', 'sensual'];

// Magzter files these shelves; none of them is a magazine anyone means when
// they ask what to read this month.
const EXPLICIT_CATEGORIES = /adult|erotic|men'?s\s*(interest|lifestyle)?\s*adult|18\+/i;
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

function escapeRe(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
    articleProse: obs.map(o => o.articleProse).filter(Boolean).join(' ').slice(0, 8000) || null,
    bylines: obs.map(o => o.byline).filter(Boolean),
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
  // Real article prose outweighs everything else on the page. A cover line is
  // written to sell the issue; this is the issue.
  push(src.articleProse, 5);
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

  /* ---- pornography ---- */
  // A separate question from `audience`, and the reason it is separate is that
  // audience could only ever say "adult", which is equally true of a defence
  // quarterly. Three independent signals, because any one alone is wrong: the
  // shelf Magzter files it on, the title, and the issue text. The title and the
  // shelf are decisive on their own; body-text cues need corroboration, since a
  // single word in a book review is not a porn magazine.
  const explicitTitle = EXPLICIT_TITLE_CUES.filter(c => {
    const re = new RegExp('(^|[^a-z])' + escapeRe(c) + '($|[^a-z])', 'i');
    return re.test(String(rec.title || ''));
  });
  const explicitShelf = EXPLICIT_CATEGORIES.test(String(rec.category || ''));
  const explicitText = countCues(EXPLICIT_CUES);

  let explicit = false, explicitWhy = null;
  if (explicitTitle.length) {
    explicit = true;
    explicitWhy = 'the title itself (' + explicitTitle.join(', ') + ')';
  } else if (explicitShelf) {
    explicit = true;
    explicitWhy = 'filed on an adult shelf (' + rec.category + ')';
  } else if (explicitText >= 3) {
    explicit = true;
    explicitWhy = explicitText + ' explicit references in the issue text';
  }

  /* ---- a description of THIS issue ---- */
  const summary = buildIssueSummary(rec, src, weighted);

  return {
    topics: weighted, evidence, minedRaw, mined: Object.fromEntries(minedTop),
    newsiness, visualness, visualBasis, visualConfidence, difficulty, audience, audienceWhy,
    explicit, explicitWhy,
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

// A title carrying any non-Latin letter is not an English magazine, whatever
// the page failed to declare. Deliberately not the same test as SCRIPT_RANGES:
// this catches every script at once, including ones with no entry there.
function nonLatinTitle(title) {
  return /[^ -ɏ -⁯₠-⃏]/.test(String(title || ''));
}

/* ------------------------------------------------------------- blocking */
/* "Never show me this again." A hard gate and the bluntest control in the app,
   kept deliberately distinct from the three softer things it is easy to confuse
   it with:

     - a DOWNVOTE says this one is worse than the others and is a ranking term;
     - NOT INTERESTED declines this issue and teaches from the reason given;
     - a BLOCK removes the title from the app entirely, for good, and teaches
       nothing at all.

   That last point is the important one. People block for reasons that say
   nothing about taste — they already subscribe, it is not sold near them, they
   read it at work — and a block that quietly trained the model against the
   subject would punish a whole shelf for a fact about one magazine. Blocking is
   therefore recorded at weight 0 and appears in History for visibility only.
   Anyone who blocks something because they dislike it can also downvote it, and
   the two controls sit next to each other. */

function blockKey(rec) { return canonTitle(rec.title || '') || rec.id; }

function isBlocked(rec) {
  const canon = blockKey(rec);
  return (state.blocked || []).some(b => b.id === rec.id || (b.canon && b.canon === canon));
}

// Why this title was blockable, read off what is already known about it. No
// dialog and no extra click: asking for a reason would make blocking slow enough
// to go unused, and the two reasons that actually come up leave evidence on the
// record anyway.
//
// This is not taste data and is never trained on. It exists because a block is
// usually a FILTER that missed — "I cannot read this" and "I do not want this on
// screen" are both statements about the shelf — and a filter that keeps missing
// is worth fixing once instead of blocking one title at a time.
function blockCause(rec) {
  const c = rec.content || {};
  if (c.explicit) return { code: 'explicit', label: 'adult material that got past the filter' };
  if (!rec.language) {
    return { code: 'language-unknown', label: 'no language could be established for this title' };
  }
  if (rec.language !== 'English') {
    return { code: 'language-other', label: 'published in ' + rec.language };
  }
  return { code: 'other', label: null };
}

function blockRecord(rec, note) {
  if (isBlocked(rec)) return;
  const cause = blockCause(rec);
  state.blocked.push({
    id: rec.id, canon: blockKey(rec), title: rec.title,
    at: Date.now(), note: note || null,
    cause: cause.code, causeLabel: cause.label,
  });
  // Recorded so the History timeline shows it. EVENT_WEIGHT.block is 0 — see
  // the note above; this must not move the taste model.
  recordEvent('block', rec);
  state.ranked = null;
  scheduleSave();
}

function unblockRecord(entry) {
  state.blocked = (state.blocked || []).filter(b => b !== entry);
  state.ranked = null;
  scheduleSave();
}

function evaluateFilters(rec, f) {
  const fails = [];
  const fail = (filter, reason) => fails.push({ filter, reason });

  // Checked first and on its own terms: a blocked title is gone, whatever else
  // it scores and whatever else is set.
  if (isBlocked(rec)) {
    fail('blocked', 'you blocked this title — unblock it in Filters');
    return { pass: false, fails };
  }

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

  // The leak this used to have: it only rejected a language it could NAME, so
  // every title whose language could not be read passed an English-only filter
  // untouched. Most titles have no declared language, so "English only" was
  // quietly letting most of the newsstand through.
  if (f.languages.length) {
    if (rec.language) {
      if (!f.languages.includes(rec.language)) fail('language', 'published in ' + rec.language);
    } else if (f.unknownLanguage === 'strict') {
      fail('language', 'no language could be established for this title');
    } else if (nonLatinTitle(rec.title)) {
      fail('language', 'the title is not written in the Latin alphabet');
    }
  }

  const rc = rec.content || {};
  if (f.hideExplicit && rc.explicit) {
    fail('explicit content', rc.explicitWhy || 'reads as adult material');
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
/* -------------------------------------------------------- pairwise choice */
/* "Which of these two?" is the cheapest honest question this app can ask, and
   it carries more than a like does, because it fixes a DIRECTION. A like says
   "not nothing"; a choice says "this one, not that one", and the two magazines
   were on screen together so the comparison was real.

   The whole trick is that everything the two share cancels. If both are English
   monthlies, the choice says nothing whatever about English or about monthlies,
   and nothing is recorded against them. Only the dimensions on which they
   actually differ move. That is what makes this immune to the failure the facet
   damping in discriminativeness() was invented to paper over: a value carried by
   four titles in five can never accumulate evidence here, because it is on both
   sides of almost every pair.                                                  */

function applyPair(model, winner, loser, magnitude, evMeta) {
  const wT = winner.topics || {}, lT = loser.topics || {};

  // Topics, as a difference of shares. A topic on both cards in equal measure
  // nets to zero; one carried only by the winner takes the full credit.
  const names = new Set([...Object.keys(wT), ...Object.keys(lT)]);
  for (const name of names) {
    const delta = ((wT[name] || 0) - (lT[name] || 0)) * magnitude * 3;
    if (Math.abs(delta) < 0.01) continue;
    const a = accFor(model.topics, name);
    if (delta > 0) a.pos += delta; else a.neg += -delta;
    a.evidence.push({
      at: evMeta.at, kind: 'prefer', sign: delta > 0 ? 1 : -1,
      delta: +Math.abs(delta).toFixed(3),
      recordId: delta > 0 ? winner.id : loser.id,
      title: delta > 0 ? winner.title : loser.title,
      against: delta > 0 ? loser.title : winner.title,
      share: +Math.abs((wT[name] || 0) - (lT[name] || 0)).toFixed(3),
      reason: null,
    });
    if (a.evidence.length > 40) a.evidence.shift();
  }

  // Facets: recorded ONLY where the pair disagrees.
  const facetPair = (map, wKey, lKey) => {
    if (wKey == null || lKey == null) return;
    if (String(wKey) === String(lKey)) return;      // shared — says nothing
    const w = accFor(map, String(wKey));
    w.pos += magnitude;
    w.evidence.push({ ...evMeta, note: 'chosen over ' + lKey });
    if (w.evidence.length > 30) w.evidence.shift();
    const l = accFor(map, String(lKey));
    l.neg += magnitude;
    l.evidence.push({ ...evMeta, note: 'passed over in favour of ' + wKey });
    if (l.evidence.length > 30) l.evidence.shift();
  };
  const wc = winner.content || {}, lc = loser.content || {};
  facetPair(model.audience, wc.audience, lc.audience);
  facetPair(model.languages, winner.language, loser.language);
  facetPair(model.publishers, winner.publisher, loser.publisher);
  facetPair(model.frequency,
    winner.frequency && winner.frequency.label, loser.frequency && loser.frequency.label);

  // Scalars: the winner's value is the target, the loser's is the thing to
  // avoid — but only when they are far enough apart to mean anything. Two
  // magazines both at 0.5 visualness teach nothing about visualness.
  const scalarPair = (key, wv, lv, minGap) => {
    if (wv == null || lv == null) return;
    if (Math.abs(wv - lv) < minGap) return;
    addScalar(model[key], wv, magnitude, 1, evMeta);
    addScalar(model[key], lv, magnitude * 0.8, -1, evMeta);
  };
  scalarPair('visualness', wc.visualness, lc.visualness, 0.12);
  scalarPair('difficulty', wc.difficulty, lc.difficulty, 0.12);
  scalarPair('newsiness', wc.newsiness, lc.newsiness, 0.12);
  scalarPair('price', toInr(winner.price), toInr(loser.price), 40);
}

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

    // Blocking is a hard constraint, not a preference — see the blocking
    // section. It has to be skipped HERE rather than relying on its zero in
    // EVENT_WEIGHT, because the lookup below falls back to 0.2 for an unknown
    // kind and `0 || 0.2` is 0.2: a weight of zero and no weight at all are the
    // same value to that expression. A block would otherwise have trained the
    // model against the subject of a magazine somebody blocked because they
    // already subscribe to it.
    if (ev.kind === 'block') { model.eventCount++; continue; }

    const w = (EVENT_WEIGHT[ev.kind] || 0.2) * (ev.weightMul || 1);
    if (!w) continue;

    // A pairwise choice is handled whole, by applyPair, because its meaning is
    // in the DIFFERENCE between two records and nothing about it decomposes
    // into "an event about one magazine".
    if (ev.kind === 'prefer') {
      const loser = resolveRecord(ev.loserId);
      if (!loser || loser.id === rec.id) continue;
      model.eventCount++;
      model.totalWeight += w;
      model.firstAt = model.firstAt || ev.at;
      model.lastAt = ev.at;

      const noveltyPair = centroidW ? 1 - cosine(centroid, rec.topicVec || {}) : null;
      applyPair(model, rec, loser, w,
        { at: ev.at, kind: 'prefer', title: rec.title, recordId: rec.id, reason: null });

      // Progression reads a choice the same way it reads any acceptance: the
      // winner was accepted at whatever distance it sat from the taste that
      // existed at the time, and the loser was declined at its own distance.
      if (noveltyPair != null) {
        model.novelty.posW += w; model.novelty.posSum += noveltyPair * w;
        const loserNov = 1 - cosine(centroid, loser.topicVec || {});
        model.novelty.negW += w; model.novelty.negSum += loserNov * w;
        model.novelty.samples.push({
          at: ev.at, kind: 'prefer', title: rec.title, recordId: rec.id,
          novelty: +noveltyPair.toFixed(3), sign: 1,
        });
        if (model.novelty.samples.length > 120) model.novelty.samples.shift();
      }

      for (const [k, v] of Object.entries(rec.topicVec || {})) {
        centroid[k] = (centroid[k] || 0) + v * w;
      }
      centroidW += w;
      continue;
    }

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
    // "Nothing has been LEARNED", which is not the same as "nothing has been
    // recorded". eventCount includes the two kinds that are deliberately not
    // trained on — `view` and `block` — so defining emptiness by it meant the
    // model stopped calling itself empty after a single render, purely because
    // rendering the month view logs a view. Every card then showed a match
    // percentage derived from no evidence at all, and the "this is not a
    // personalised recommendation yet" panel disappeared while it was still
    // entirely true. Weight is the honest test: it only moves when something
    // was actually learned from.
    empty: model.totalWeight <= 0,
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

  return view;
}


let tasteCache = { key: '', value: null };
function taste() {
  const key = state.events.reduce((a, e) => a + (e.kind === 'view' ? 0 : 1), 0)
    + '|' + state.magazines.size;
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

// A pairwise choice is one event, stored on the winner with the loser named.
// Kept as a single record rather than a like plus a dislike because it is a
// single judgement: the user did not say the loser was bad, only that it lost.
function recordPair(winner, loser, extra = {}) {
  return recordEvent('prefer', winner, {
    loserId: loser.id,
    loserTitle: loser.title,
    loserIssue: (loser.issue && loser.issue.label) || null,
    loserTopics: topEntries(loser.topics || {}, 5).map(([k]) => k),
    ...extra,
  });
}

/* ------------------------------------------------------- choosing the pair */
/* Which two to put up. Not the top two — those are usually near-identical and
   the answer teaches nothing. A useful pair is one the model cannot already
   call: close on total score, far apart on the things it is least sure about.

   Both sides must be real recommendations. Asking someone to choose between two
   magazines they would never buy produces an answer, and the answer is noise. */

function pickComparison(scored, t) {
  const pool = scored.filter(c =>
    c.parts.availability >= 0.6 && c.parts.freshness >= 0.35 && c.parts.ownedIssue === 0);
  if (pool.length < 2) return null;

  // Recently asked pairs are not asked again, and neither is a title that has
  // just been judged — the point is to cover new ground each time.
  const asked = new Set(state.meta.skippedPairs || []);
  const seenRecently = new Map();
  for (const ev of state.events) {
    if (ev.kind !== 'prefer') continue;
    asked.add([ev.recordId, ev.loserId].sort().join('|'));
    seenRecently.set(ev.recordId, ev.at);
    seenRecently.set(ev.loserId, ev.at);
  }
  const now = Date.now();
  const fatigue = id => {
    const at = seenRecently.get(id);
    if (!at) return 0;
    return clamp(1 - (now - at) / (14 * 864e5));
  };

  // Deterministic per event count, so the question does not reshuffle on every
  // render while the user is looking at it.
  const rnd = seededRand('pair:' + state.events.length + ':' + state.magazines.size);
  // Drawn from a wide band, not the top few. Restricting to the highest scorers
  // would ask about the same dozen titles forever and never learn anything about
  // the rest of the newsstand.
  const band = pool.slice(0, Math.min(160, pool.length));
  const top = band.length <= 60 ? band
    : band.filter(() => rnd() < 60 / band.length).slice(0, 60);
  if (top.length < 2) return null;

  let best = null, bestGain = -Infinity;
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i], b = top[j];
      if (asked.has([a.rec.id, b.rec.id].sort().join('|'))) continue;

      // Close on score: the model genuinely does not know which is better. Kept
      // deliberately light, because pushing it hard pairs a magazine with its
      // nearest neighbour — which is usually the same subject, and a choice
      // between two cooking monthlies teaches almost nothing.
      const closeness = 1 - clamp(Math.abs(a.base - b.base) / 3.5);

      // Far apart on content, and this is the term that matters most. The pair
      // is drawn ACROSS the newsstand rather than within a shelf: applyPair
      // cancels everything two magazines share, so a cross-genre pair is where
      // nearly all the information is. Two titles from the same shelf are
      // actively avoided.
      const sim = cosine(a.rec.topicVec || {}, b.rec.topicVec || {});
      const contrast = 1 - sim;
      const sameShelf = a.rec.category && a.rec.category === b.rec.category ? 0.5 : 0;

      // Weighted towards subjects the model has least evidence about.
      const ignorance = mean([...Object.keys(a.rec.topics || {}), ...Object.keys(b.rec.topics || {})]
        .map(k => { const tp = t.topics[k]; return tp ? 1 - tp.confidence : 1; })) || 1;

      // Quality floor, so neither side is a magazine nobody would buy.
      const quality = Math.min(a.parts.appeal, b.parts.appeal);

      // The random term is large on purpose. The user asked for two magazines
      // drawn from anywhere on the newsstand, not an optimiser's idea of the
      // most informative pair — and a question that feels picked at random is
      // also the one least able to walk the model into a corner of its own
      // choosing, which is the same bubble problem that keeps `view` at weight
      // zero. Information gain shapes the draw; it does not determine it.
      const gain = closeness * 0.5 + contrast * 2.0 + ignorance * 0.7 + quality * 0.6
        - sameShelf
        - fatigue(a.rec.id) * 0.8 - fatigue(b.rec.id) * 0.8
        + rnd() * 1.6;

      if (gain > bestGain) { bestGain = gain; best = [a, b]; }
    }
  }
  if (!best) return null;
  // Left/right is randomised per pair so a habit of clicking one side cannot
  // masquerade as a preference.
  const flip = seededRand('side:' + best[0].rec.id + best[1].rec.id)() > 0.5;
  return {
    a: flip ? best[1] : best[0],
    b: flip ? best[0] : best[1],
    gain: bestGain,
  };
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
    // CONSUMPTION only. `like` used to be in this list, which meant liking a
    // travel magazine marked travel as "just read" and fired the full -1.3
    // repetition penalty on every travel title — so the one button that was
    // supposed to ask for more of a subject was the button that buried it.
    // The cool-off exists to stop you reading the same subject twice in a
    // month; wanting a subject is not reading it.
    if (ev.kind === 'buy' || ev.kind === 'alreadyRead') {
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

  // Titles the user has expressed any direct judgement about their TASTE for,
  // either side of a comparison included. Used only to switch off the cold-start
  // terms, which measure an ignorance the user has already dispelled.
  //
  // `block` is excluded along with the two passive kinds, and for a stronger
  // reason than either. People block a magazine because it is in a language they
  // cannot read or because it is not something they want on screen — reasons
  // about the SHELF, not about their taste. Leaving it in meant a blocked title
  // came back from an unblock permanently stripped of its novelty and
  // exploration terms, as though it had been judged. Invisible while blocked,
  // since a blocked title never reaches the ranking at all, and wrong the moment
  // it is unblocked. A block must leave no mark on scoring whatsoever.
  const judged = new Set();
  for (const ev of state.events) {
    if (ev.kind === 'view' || ev.kind === 'open' || ev.kind === 'block') continue;
    const rec = resolveRecord(ev.recordId);
    judged.add(rec ? rec.id : ev.recordId);
    if (ev.loserId) judged.add(ev.loserId);
  }

  return { boughtByRecord, readByRecord, recommendedAt, subjectMonths, skipped, judged };
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

  // Novelty and exploration measure how little is known about something, so
  // they do not apply to a title the user has already ruled on. A vote is now a
  // pairwise `prefer` against the neighbouring row rather than a score term of
  // its own (see the voting section), so "ruled on" means any recorded judgement.
  const judged = ctx.judged.has(rec.id);
  if (judged) {
    parts.novelty = 0;
    parts.exploration = 0;
    notes.novelty = 'you have judged this title directly, so unfamiliarity is not in question';
    notes.exploration = notes.novelty;
  }

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

  /* ---- manual position adjustment from the arrows ---- */
  // Added raw rather than scaled, because it is denominated in score units by
  // construction: nudge() solves for exactly the delta that puts this title one
  // place higher and stores that. Shown in Research like every other term.
  parts.nudge = state.nudges[rec.id] || 0;
  notes.nudge = parts.nudge
    ? 'you moved this ' + (parts.nudge > 0 ? 'up' : 'down') + ' the list by hand'
    : '';

  // Diversity is not computable in isolation — it depends on what else has been
  // chosen — so it is filled in during selection and left at zero here.
  parts.diversity = 0;
  notes.diversity = '';

  // Novelty and exploration are COLD-START terms and are now scaled down as the
  // model learns. Left at full weight they did the opposite of their job: a
  // magazine that matches your taste has low novelty by definition and low
  // exploration value by definition, so between them they handed an unrelated
  // magazine a ~0.6 head start over a perfect match. Measured on a synthetic
  // corpus, a title scoring a perfect 1.00 on preference fit still finished
  // below seven titles the model knew nothing about. They are worth a lot when
  // nothing is known and very little once something is, which is exactly what
  // maturity measures.
  const coldStart = judged ? 0 : 1 - 0.75 * (t.maturity || 0);
  parts.novelty *= coldStart;
  parts.exploration *= coldStart;
  notes.novelty += t.maturity > 0.15
    ? ' · weighted x' + coldStart.toFixed(2) + ' — the model has learned enough that fit matters more than unfamiliarity'
    : '';
  notes.exploration += t.maturity > 0.15 ? ' · weighted x' + coldStart.toFixed(2) : '';

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

// How far down the list the greedy diversity pass runs. Below this depth every
// remaining candidate is appended in plain score order.
//
// This is a cost boundary and it is a real one. The old loop recomputed each
// candidate's similarity against every already-chosen title on every pick, which
// is cubic in the size of the list, and the list used to be 40. Measured on a
// synthetic corpus when the cap came off: 200 titles 0.9s, 400 titles 7.7s, 800
// titles 62s. At the 4,600 the app is heading for it would never finish.
//
// The incremental form below removes one factor — each candidate carries a
// running "closest thing already chosen", updated against the single new pick
// rather than rescanned — which makes the pass linear per pick. The depth cap
// removes the other. Together they turn the whole list into roughly the cost the
// old code paid for forty.
//
// Capping the DEPTH rather than the list is what makes it defensible: diversity
// is a statement about the top of a list, where the user is actually choosing
// between things. Nobody is comparing candidate 300 with candidate 301 for
// variety, and pretending to rank them against each other would be arithmetic
// nobody reads.
const DIVERSITY_DEPTH = 120;

// How many rows at the very top are guaranteed to be about DIFFERENT subjects.
//
// The overlap penalty below is a gradient: it makes similar things cost more,
// but a subject the model is confident about can pay that cost over and over
// and still win, so the top of the list drifts into six variations on one
// theme. That is the rut this app exists to avoid, and a penalty large enough
// to prevent it would also wreck the ranking further down.
//
// So the first rows are a mix BY CONSTRUCTION rather than by pressure: once a
// subject has taken a place in the top ROTATION_DEPTH, the next pick has to
// come from somewhere else. It costs nothing in the common case — a good list
// is already varied — and it binds exactly when the ranking is about to repeat
// itself. Below the depth, ordinary scoring resumes: a reader who genuinely
// wants four car magazines can still find them, just not as the whole answer to
// "what should I buy this month".
const ROTATION_DEPTH = 12;

// The subject a magazine is mostly about, which is what a reader would say it
// "is". Mined phrases are skipped: they are specific to one issue and two
// magazines sharing one is a coincidence, not a repetition.
function primarySubject(rec) {
  let best = null, bestShare = 0;
  for (const [name, share] of Object.entries(rec.topics || {})) {
    if (!SUBJECT_NAMES.has(name)) continue;
    if (share > bestShare) { bestShare = share; best = name; }
  }
  return bestShare >= 0.12 ? best : null;
}

function selectShortlist(scored, t, f, count) {
  const chosen = [];

  // How hard to push for variety. Rising when the user has said "too similar",
  // and high by default when nothing is known — with an empty model, breadth is
  // the only responsible strategy, because it is the only one that does not
  // require having guessed something.
  const pressure = t.empty ? 1.5
    : clamp(0.6 + t.diversityPressure * 0.25 + (1 - t.progression.confidence) * 0.3, 0.4, 1.6);

  // Parallel arrays rather than splicing out of a pool: splice is O(n) per pick
  // and the pool is now the whole newsstand.
  const pool = scored.slice();
  const taken = new Array(pool.length).fill(false);
  const worstSim = new Float64Array(pool.length);      // closest already-chosen
  const worstAgainst = new Array(pool.length).fill(null);
  const pubCount = new Map();
  const usedSubjects = new Set();

  const depth = Math.min(count, DIVERSITY_DEPTH);
  const tol = f.overlapTolerance;
  const denom = Math.max(0.05, 1 - tol);

  for (let picked = 0; picked < depth; picked++) {
    let bestIdx = -1, bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      if (taken[i]) continue;
      const cand = pool[i];
      // Below the tolerance, overlap costs nothing at all; above it the cost
      // rises steeply, so two genuinely different magazines are never punished
      // for sharing one subject while two interchangeable ones are.
      const over = Math.max(0, worstSim[i] - tol) / denom;
      const penalty = WEIGHTS.diversity * pressure * over;
      // Title-level variety too: the same publisher three times in a shortlist
      // reads as a rut even when the subjects differ.
      const pubPenalty = (pubCount.get(cand.rec.publisher) || 0) * 0.35;
      // Inside the rotation depth a subject already spoken for is skipped
      // outright rather than merely taxed. Skipped, not scored down, because a
      // penalty is something a strong candidate can buy its way through and the
      // whole point here is that it cannot.
      if (picked < ROTATION_DEPTH) {
        const subj = primarySubject(cand.rec);
        if (subj && usedSubjects.has(subj)) continue;
      }
      const s = cand.base - penalty - pubPenalty;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    // Every remaining candidate repeats a subject already in the top rows. The
    // rotation has done its job and now stands aside rather than truncating the
    // list — the reader asked for the whole shelf, not twelve titles.
    if (bestIdx < 0 && picked < ROTATION_DEPTH) {
      usedSubjects.clear();
      picked--;               // retry this slot with the constraint lifted
      continue;
    }
    if (bestIdx < 0) break;

    const pick = pool[bestIdx];
    taken[bestIdx] = true;
    const over = Math.max(0, worstSim[bestIdx] - tol) / denom;
    const penalty = WEIGHTS.diversity * pressure * over;
    const samePub = pubCount.get(pick.rec.publisher) || 0;
    const total = penalty + samePub * 0.35;

    pick.score = bestScore;
    pick.parts.diversity = -(total / Math.max(0.001, WEIGHTS.diversity));
    pick.notes.diversity = worstAgainst[bestIdx]
      ? 'closest to ' + worstAgainst[bestIdx].rec.title
        + ' at ' + worstSim[bestIdx].toFixed(2) + ' similarity'
      : 'first pick — nothing to overlap with';
    pick.overlap = { overlap: worstSim[bestIdx], against: worstAgainst[bestIdx], penalty: total, samePub };
    if (pick.rec.publisher) pubCount.set(pick.rec.publisher, samePub + 1);
    const subj = primarySubject(pick.rec);
    if (subj) {
      if (chosen.length < ROTATION_DEPTH) usedSubjects.add(subj);
      pick.notes.diversity += ' · leads on ' + subj;
    }
    chosen.push(pick);

    // The one update that replaces the inner rescan: every remaining candidate
    // only needs to know whether THIS pick is closer than whatever was closest
    // before.
    const vec = pick.rec.topicVec || {};
    for (let i = 0; i < pool.length; i++) {
      if (taken[i]) continue;
      const sim = cosine(pool[i].rec.topicVec || {}, vec);
      if (sim > worstSim[i]) { worstSim[i] = sim; worstAgainst[i] = pick; }
    }
  }

  // Everything past the diversity depth, in plain score order. These are real
  // candidates and are shown with real scores; they simply were not ranked
  // against one another for variety, and their diversity term says so rather
  // than reporting a zero that looks like a measurement.
  if (chosen.length < count) {
    const rest = [];
    for (let i = 0; i < pool.length; i++) if (!taken[i]) rest.push(pool[i]);
    rest.sort((a, b) => b.base - a.base);
    for (const cand of rest.slice(0, count - chosen.length)) {
      cand.score = cand.base;
      cand.parts.diversity = 0;
      cand.notes.diversity = 'past the top ' + DIVERSITY_DEPTH
        + ' — ordered on its own score, not against the others';
      chosen.push(cand);
    }
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

  // A single answer plus five alternatives was too little to browse and too
  // little to argue with. The shortlist is now long enough to read like a
  // ranked list, with the diversity and repetition machinery applied all the way
  // down it rather than only across the top few.
  // Everything eligible, ranked. There is no page size: the user asked for the
  // whole list and DIVERSITY_DEPTH is what keeps that affordable.
  const shortlistSize = opts.size || scored.length;
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


/* ------------------------------------------------------- the monthly cycle */
/* Recomputed from whatever is currently known, every month, with no memory of
   what last month decided beyond the history that should influence it. There is
   no stored schedule to repeat, because a schedule made in August cannot know
   that September's issue is a rerun or that the title has gone out of print. */

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
    nudge: 'you moved it up the list by hand',
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

function currentCycle() {
  const month = nowMonth();
  const key = String(month);
  const stored = state.meta.cycles[key];
  // Counting only events the model actually learns from. Including views made
  // the cache turn over on every render, and since a re-rank re-reads the taste
  // model, the headline pick changed each time the page was drawn.
  const rankKey = [
    month, state.events.reduce((a, e) => a + (e.kind === 'view' ? 0 : 1), 0), state.magazines.size,
    JSON.stringify(state.filters),
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
// Would reading this lead actually hit the network, or would fetchPage serve it
// straight back out of state.cache? The budget is defined as "page reads where a
// read changes the answer", and a read that resolves from cache changes nothing
// by definition — it cannot discover a new issue, a new price, or a withdrawal.
//
// This was costing a quarter of every refresh. The `hot` bucket below takes
// every currently-recommended title with NO age check at all, so the same ~23
// titles were planned on every single refresh and every one of them came back
// from cache in microseconds. The visible symptom was the progress counter
// appearing to start at 36 of 90: those first thirty-five "reads" were cache
// hits that completed before the first frame could paint. The real cost was
// thirty-five slots that never reached an unread title, which is the only thing
// that grows coverage.
function servedFromCache(url, ttl) {
  const hit = state.cache.get(url);
  return !!(hit && hit.text && Date.now() - hit.at < ttl);
}

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

  // What has already been read, by canonical title and publisher. A lead whose
  // title normalises onto a record we have already fetched is the same magazine
  // listed twice — different URL, different shelf, same product — and reading it
  // again spends a budget slot to learn nothing and then creates a duplicate
  // record for autoMerge to clean up afterwards. Cheaper and cleaner not to
  // fetch it. Publisher must match too: "Top Gear" and "Top Gear India" are
  // separate licensed magazines and only the publisher separates them here.
  const knownTitles = new Set();
  for (const rec of state.magazines.values()) {
    const ct = canonTitle(rec.title);
    if (ct) knownTitles.add(ct + '|' + canonTitle(rec.publisher || ''));
  }

  const hot = [], stale = [], fresh = [];
  let cachedSkips = 0;
  let duplicateSkips = 0;

  for (const lead of state.leads) {
    if (lead.fails >= 3) continue;
    const rec = urlToRecord.get(lead.url);

    if (!lead.detailAt) {
      // Only ever applied to a lead that has never been read. One that HAS been
      // read is already a record and is governed by the staleness rules below.
      const key = canonTitle(lead.title || '') + '|' + canonTitle(lead.publisher || '');
      if (canonTitle(lead.title || '') && knownTitles.has(key)) { duplicateSkips++; continue; }
      fresh.push(lead);
      continue;
    }

    // Staleness is measured in publication cycles, not days. A four-week-old
    // reading of a quarterly is current; the same reading of a weekly is four
    // issues out of date.
    const cycleDays = (rec && rec.frequency && rec.frequency.days) || 30;
    const ageCycles = (now - lead.detailAt) / 864e5 / cycleDays;
    const isHot = !!(rec && recommended.has(rec.id));

    // Skipped before a slot is spent, not after. The TTL used here must match
    // the one the connector will pass, or this predicts the wrong thing.
    if (servedFromCache(lead.url, isHot ? TTL.detailHot : TTL.detail)) {
      cachedSkips++;
      continue;
    }

    if (isHot) { hot.push({ lead, ageCycles, rec }); continue; }
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

  let breadth = [];
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

  // Readwhere is 150 titles against Magzter's 10,400, so a proportional
  // round-robin would reach almost none of it — and Readwhere is the only
  // source that quotes rupees and states a publication date, which are the two
  // things a recommendation most needs. It gets a guaranteed slice of the
  // breadth budget instead of competing for it on volume.
  const rwFresh = fresh
    .filter(l => l.sourceId === 'readwhere')
    .sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6))
    .slice(0, Math.ceil(breadthN * 0.35));

  const taken = new Set(rwFresh.map(l => l.id));
  breadth = rwFresh.concat(breadth.filter(l => !taken.has(l.id))).slice(0, breadthN);

  return {
    plan: [].concat(
      hot.slice(0, hotN).map(x => ({ ...x.lead, hot: true, why: 'currently recommended' })),
      stale.slice(0, staleN).map(x => ({ ...x.lead, why: 'reading is ' + x.ageCycles.toFixed(1) + ' cycles old' })),
      breadth.slice(0, breadthN).map(x => ({ ...x, why: 'never read' })),
    ),
    counts: {
      hot: hotN, stale: staleN, breadth: breadthN,
      leads: state.leads.length, fresh: fresh.length,
      cachedSkips, duplicateSkips,
    },
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
        note('Readwhere: ' + rw.stubs.length + ' titles in rupees (' + added + ' new)');
      } else {
        note('Readwhere unavailable — ' + (rw.error || 'no response'));
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
      + counts.stale + ' stale, ' + counts.breadth + ' new)'
      + (counts.cachedSkips
        ? ' — ' + counts.cachedSkips + ' already current, not re-read' : '')
      + (counts.duplicateSkips
        ? ', ' + counts.duplicateSkips + ' skipped as the same title under another listing' : ''));

    // Eight at a time rather than one after another. The per-upstream limiter
    // is still the thing that decides how fast requests actually leave, so this
    // cannot outrun what the proxy tolerates — it just stops the refresh idling
    // between them, which was costing a factor of five.
    const leadIndex = new Map(state.leads.map(l => [l.id, l]));
    await pooled(plan, CONCURRENCY, async (lead, seq) => {
      const connector = CONNECTORS[lead.sourceId] || CONNECTORS.magzter;
      setProgress('(' + seq + '/' + plan.length + ') ' + (lead.title || lead.url));
      let obs;
      try {
        obs = await connector.detail(lead);
      } catch (err) {
        obs = blankObservation(connector, lead.url);
        obs.problems.push('connector threw: ' + (err && err.message));
      }
      done++;

      const stored = leadIndex.get(lead.id);
      if (stored) {
        stored.detailAt = Date.now();
        stored.lastResult = obs.availability;
        if (obs.availability === 'gone' || (!obs.issueLabel && !obs.toc.length)) stored.fails = (stored.fails || 0) + 1;
        else stored.fails = 0;
      }

      if (obs.availability === 'gone' && !obs.title) return;
      const rec = upsertObservation(obs, lead);
      if (stored) stored.recordId = rec.id;
    });

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

function coverNode(rec, opts = {}) {
  const box = el('div', { class: 'coverBox' });
  if (rec.coverUrl) {
    const img = el('img', {
      src: magzterTier(rec.coverUrl, opts.tier || COVER_TIER.card),
      alt: rec.title + ' cover', loading: 'lazy',
      onerror: e => {
        // Two steps down before giving up. A title whose issue folder carries no
        // view/ tier still has a thumb, and a small cover beats the placeholder —
        // which says something about the ISSUE, not about the CDN.
        const thumb = magzterThumb(rec.coverUrl);
        if (thumb && e.target.src !== thumb) { e.target.src = thumb; return; }
        e.target.replaceWith(missingCover(rec, 'the cover image would not load'));
      },
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



function actionRow(cand, opts = {}) {
  const rec = cand.rec;
  const row = el('div', { class: 'actions' });
  row.append(el('button', { class: 'primary', onclick: () => openBuy(rec) }, 'I bought this'));
  row.append(el('button', { onclick: () => { recordEvent('like', rec); toast('Noted — more like this'); render(); } }, '👍 Like'));
  row.append(el('button', { onclick: () => { recordEvent('dislike', rec); toast('Noted'); render(); } }, '👎 Dislike'));
  row.append(el('button', { onclick: () => openReject(rec, 'notInterested') }, 'Not interested'));
  row.append(el('button', { onclick: () => { recordEvent('alreadyRead', rec); toast('Marked as already read'); render(); } }, 'Already read'));
  row.append(el('button', { class: 'ghost', onclick: () => openDetail(rec, cand) }, 'Details & sources'));
  row.append(blockToggle(rec, { label: 'Block this title' }));
  if (!opts.noSkip) {
    row.append(el('button', { class: 'ghost', onclick: () => openReject(rec, 'skip') }, 'Skip this month'));
  }
  return row;
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

  if (!r.chosen.length) {
    main.append(el('h2', { class: 'sec' }, 'Which magazine should I buy this month?'));
    main.append(el('div', { class: 'empty' },
      el('h3', {}, 'Nothing clears your filters this month'),
      el('p', {}, r.excluded.length + ' discovered titles were all excluded. The commonest reasons are '
        + 'listed in Research → Exclusions. Loosening the price ceiling or the current-issue '
        + 'confidence floor usually reopens the field.'),
      el('button', { class: 'primary', onclick: () => toggleDeck(true) }, 'Open filters')));
    return;
  }

  // The comparison earns the top of the page only when it is due — see
  // compareDue(). Otherwise it collapses to a one-line invitation, so the
  // answer to "which magazine should I buy" is the first thing on screen.
  const cmp = compareDue(t) ? comparePanel(r) : null;
  if (cmp) main.append(cmp);
  else main.append(compareInvite(r));

  main.append(el('h2', { class: 'sec' },
    t.empty ? 'Every magazine on sale now, ranked' : 'Ranked for you'));
  main.append(el('p', { class: 'muted small', style: 'margin:-6px 0 14px' },
    t.empty
      ? 'MagLens has learned nothing about you yet, so this is not a personalised order — it is ranked '
        + 'by how strong each issue is and how confidently it can be shown to be on sale now, spread '
        + 'deliberately across subjects. Answer the question above and it becomes personal.'
      : 'Ranked by how well each fits what you have taught it, then spread so the list does not repeat '
        + 'itself. The percentage is the taste match alone. Use ▲ and ▼ on any card to correct it — '
        + 'the list re-ranks immediately.'));

  const grid = el('div', { class: 'grid' });
  main.append(grid);
  fillGrid(grid, r.chosen, { order: r.chosen });
  for (const c of r.chosen.slice(0, 3)) markViewed(c.rec);


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




/* ------------------------------------------------------------- voting */
/* Up and down arrows on every card in the list, ranker.com style: press one and
   the title moves, because the vote is a real training event and the list is
   re-ranked from the model on the spot. Pressing the same arrow again clears
   the vote rather than stacking another one — a vote is a position, not a
   counter, and the only way to hold a position is to be able to leave it.
   Clearing DELETES the event, which is what makes it honest: the model that
   comes back is exactly the model that would have existed had the vote never
   been cast. */

// The block control as a single toggle, so that every surface showing a title
// shows its true state rather than an action that may already have been taken.
function blockToggle(rec, opts = {}) {
  const on = isBlocked(rec);
  return el('button', {
    class: 'tiny ghost' + (on ? ' blockedOn' : ''),
    title: on ? 'Show this title again' : 'Never show this title again',
    onclick: e => {
      e.stopPropagation();
      if (on) { unblockRecord((state.blocked || []).find(b => b.id === rec.id || b.canon === blockKey(rec))); render(); }
      else confirmBlock(rec);
    },
  }, on ? 'Unblock' : (opts.label || 'Block'));
}

function confirmBlock(rec) {
  blockRecord(rec);
  closeModal('#detailModal');
  // Blocking is instant rather than behind a confirm dialog, because it is
  // reversible and a dialog on every block would make the control annoying
  // enough to go unused. The undo is what pays for that: it is offered for as
  // long as the toast stands, and the full list is in Filters afterwards.
  const entry = state.blocked[state.blocked.length - 1];
  toastAction(rec.title + ' blocked', 'Undo', () => {
    unblockRecord(entry);
    const evs = state.events.filter(e => e.kind === 'block' && e.recordId === rec.id);
    for (const e of evs) deleteEvent(e.id);
    render();
  });
  render();
}

/* A vote moves a title ONE PLACE, and the move is the whole meaning of it.

   The first version scored a vote directly (WEIGHTS.voted) and an upvote sent a
   magazine straight to the top of the list, which is not what an up arrow beside
   a ranked row means anywhere it appears. It means "this one beats the one above
   it" — a statement about two adjacent titles, not about the whole shelf.

   So that is exactly what it now records: an upvote on rank N is a pairwise
   preference for N over N-1, the same `prefer` event the duel produces, and a
   downvote is a preference for N+1 over N. The list then re-ranks from the
   model rather than from any stored position, so the movement is earned. Because
   the two titles were adjacent they score alike, applyPair cancels everything
   they share, and the learned delta is correspondingly small — which is why the
   title moves about a place instead of leaping.

   Pressing again compares it with its NEW neighbour and walks it up another
   step, exactly as repeated voting does on a ranked list. There is no toggle,
   because "undo my vote" and "vote again" cannot both be the same button; the
   events are in History and are individually deletable, which is the honest
   undo and the one that rebuilds the model exactly. */

// The duel teaches; the arrows arrange. An adjacent pair is similar by
// construction, so it carries far less information than two magazines drawn
// from opposite ends of the newsstand, and the user is tidying an order rather
// than answering a question. It is weighted right down — 2.6 x 0.05, lighter
// than a skip — for a measured reason as well as a principled one: at higher
// weights a single press moved the row several places, because what it taught
// reordered the rows around it too. Walked up one place at a time, the ladder
// reads 7-6-5-4-3-2 at this value and 7-6-2-1 at 0.12.
const NUDGE_WEIGHT_MUL = 0.05;

// Net movement this title has been given by voting, for the card's readout.
function voteTally(rec) {
  let n = 0;
  for (const ev of state.events) {
    if (ev.kind !== 'prefer' || !ev.nudge) continue;
    if (ev.recordId === rec.id) n++;
    else if (ev.loserId === rec.id) n--;
  }
  return n;
}

// `order` is the ranked list as currently displayed, so "the one above" means
// the row the user can actually see above this one.
//
// Two things happen, and both are needed. The pairwise event is what the vote
// TEACHES; the stored delta is what it ASSERTS. Teaching alone does not do the
// job: the first version recorded only the comparison, and upvoting a finance
// magazine taught "finance", which lifted the finance title already above it
// further still and pushed the voted title DOWN a place. An arrow that moves a
// row the wrong way is worse than one that does nothing.
//
// The delta is solved for AFTER the learning has been applied, against the
// partner's post-learning score, so the two halves cannot fight. It is solved
// rather than calculated because `diversity` is assigned during selection and
// depends on what has already been chosen, so there is no closed form for "the
// score that lands one place higher" — a few bounded probes are cheaper and
// more honest than an approximation that is subtly wrong near the top.
function nudge(rec, dir, order) {
  const i = order.findIndex(c => c.rec.id === rec.id);
  if (i < 0) return;

  const partner = dir > 0 ? order[i - 1] : order[i + 1];
  if (!partner) {
    toast(dir > 0 ? 'Already top of the list' : 'Already bottom of the list');
    return;
  }
  const partnerId = partner.rec.id;

  // 1. Teach: this row beats the one it is being moved past.
  const winner = dir > 0 ? rec : partner.rec;
  const loser = dir > 0 ? partner.rec : rec;
  recordPair(winner, loser, { nudge: true, weightMul: NUDGE_WEIGHT_MUL });
  tasteCache.key = '';
  state.ranked = null;

  // 2. Assert: find the SMALLEST delta that lands the row exactly one place
  //    from where the user saw it. The target is one place from the position
  //    they were looking at, not from wherever the learning in step 1 has just
  //    moved it to — the arrow has to answer to the list on screen.
  //
  //    Smallest matters. A first attempt grew the delta geometrically until the
  //    row was past its partner, which overshot: a single press could carry a
  //    title from seventh to second, because the step that finally worked was
  //    several times larger than the one needed. Rank is monotonic in the delta,
  //    so bisection finds the minimum and the row moves one place.
  const rankOfMe = () => {
    state.ranked = null;
    return rankAll().chosen.findIndex(c => c.rec.id === rec.id);
  };
  const target = dir > 0 ? i - 1 : i + 1;
  const base = state.nudges[rec.id] || 0;
  const setDelta = d => { state.nudges[rec.id] = base + dir * d; };
  const reached = () => {
    const r = rankOfMe();
    return r >= 0 && (dir > 0 ? r <= target : r >= target);
  };

  let hi = 0.05, ok = false;
  for (let k = 0; k < 18 && !ok; k++) { setDelta(hi); if (reached()) ok = true; else hi *= 2; }
  if (ok) {
    let lo = 0;
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      setDelta(mid);
      if (reached()) hi = mid; else lo = mid;
    }
    setDelta(hi);
  }
  // If 18 doublings could not reach it the row is pinned by a hard term such as
  // ownedIssue, and no ranking delta should be able to override one. The delta
  // is left where it got to rather than growing without bound.
  state.ranked = null;
  scheduleSave();

  toast(dir > 0
    ? rec.title + ' now ranks above ' + partner.rec.title
    : partner.rec.title + ' now ranks above ' + rec.title);
  render();
}

// Undo every manual adjustment. The learning the votes produced is NOT undone
// here — those are events and live in History, where they can be deleted
// individually. This clears only the asserted positions.
function clearNudges() {
  state.nudges = {};
  state.ranked = null;
  scheduleSave();
}

function voteBox(rec, order) {
  const n = voteTally(rec);
  const box = el('div', { class: 'vote' + (n > 0 ? ' up' : n < 0 ? ' down' : '') });
  const i = order ? order.findIndex(c => c.rec.id === rec.id) : -1;
  // Without a ranked order there is no "the one above", so there is nothing
  // honest for an arrow to record. Browse sorted by price is the case that
  // matters: position there says nothing about preference.
  const usable = !!order && i >= 0;

  const up = el('button', {
    class: 'voteBtn',
    title: !usable ? 'Sort by best fit to vote'
      : i > 0 ? 'Rank above ' + order[i - 1].rec.title : 'Already top of the list',
    onclick: e => { e.stopPropagation(); if (order) nudge(rec, 1, order); },
  }, '▲');
  if (!usable || i === 0) up.disabled = true;
  box.append(up);

  box.append(el('span', { class: 'voteState' }, n > 0 ? '+' + n : n < 0 ? String(n) : '·'));

  const down = el('button', {
    class: 'voteBtn',
    title: !usable ? 'Sort by best fit to vote'
      : i < order.length - 1 ? 'Rank below ' + order[i + 1].rec.title : 'Already bottom of the list',
    onclick: e => { e.stopPropagation(); if (order) nudge(rec, -1, order); },
  }, '▼');
  if (!usable || i === order.length - 1) down.disabled = true;
  box.append(down);

  return box;
}

function matchPct(cand, t) {
  // What the card calls the "match". It is the preference-fit term and nothing
  // else — not the total score — because the total mixes in availability and
  // freshness, which are facts about the shop rather than about the reader, and
  // a number labelled "match" has to mean what it says.
  if (t.empty) return null;
  return Math.round(clamp(cand.fit ? cand.fit.score : 0.5) * 100);
}

/* Fills a grid with every candidate given, without a "show more" button and
   without blocking the page while it does it.

   The whole list is wanted on screen, and at four thousand cards building the
   DOM in one synchronous pass freezes the tab for long enough to look broken.
   So the first screenful goes in immediately and the rest follows across
   animation frames. Nothing is waiting on a click — by the time the user has
   read the top of the list the bottom of it is already there.

   `renderToken` guards against the obvious hazard: a vote, a block or a filter
   change calls render() again while a fill is still in flight, and the old fill
   would otherwise keep appending cards to a grid that is no longer on the page.
   Each fill captures the token it started under and stops as soon as it changes. */

const FILL_FIRST = 60;     // enough to cover any first screen
const FILL_CHUNK = 120;    // per frame thereafter

function fillGrid(grid, cands, opts = {}) {
  const token = renderToken;
  let i = 0;

  const put = n => {
    const end = Math.min(cands.length, i + n);
    for (; i < end; i++) grid.append(rankCard(cands[i], i + 1, opts));
  };

  put(FILL_FIRST);
  if (i >= cands.length) return;

  const step = () => {
    if (token !== renderToken) return;   // superseded; this grid is detached
    put(FILL_CHUNK);
    if (i < cands.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function rankCard(cand, n, opts = {}) {
  const rec = cand.rec;
  const t = (state.ranked && state.ranked.t) || taste();
  const pct = matchPct(cand, t);
  const tally = voteTally(rec);

  const card = el('div', {
    class: 'card' + (cand.exploratory ? ' exploratory' : '')
      + (tally > 0 ? ' votedUp' : tally < 0 ? ' votedDown' : ''),
  });

  const poster = el('div', { class: 'cardPoster' });
  poster.append(coverNode(rec));
  poster.append(el('span', { class: 'rankBadge' }, '#' + n));
  if (pct != null) {
    poster.append(el('span', {
      class: 'matchBadge' + (pct >= 70 ? ' high' : pct >= 45 ? ' mid' : ' low'),
      title: cand.fit ? cand.fit.note : '',
    }, pct + '%'));
  }
  if (cand.exploratory) poster.append(el('span', { class: 'exploreBadge' }, 'Outside your usual'));
  card.append(poster);

  const body = el('div', { class: 'cardBody' });
  body.append(el('h3', { class: 'cardTitle', title: rec.title }, rec.title));
  body.append(el('div', { class: 'cardMeta' },
    ((rec.issue && rec.issue.label) || 'issue unknown')
    + ' · ' + (rec.price.amount == null ? 'price unknown' : fmtPrice(rec.price))
    + (rec.language ? ' · ' + rec.language : '')));
  body.append(topicChips(rec.topics, { limit: 3 }));
  body.append(el('div', { class: 'cardWhy' },
    cand.exploratory ? cand.exploreReason
      : t.empty ? (rec.content.summary.text || '').slice(0, 110)
      : (cand.fit && cand.fit.note) || 'no strong signal either way'));

  const foot = el('div', { class: 'cardFoot' });
  foot.append(voteBox(rec, opts.order));
  const btns = el('div', { class: 'cardBtns' });
  btns.append(el('button', { class: 'tiny', onclick: () => openDetail(rec, cand) }, 'Details'));
  btns.append(el('button', { class: 'tiny', onclick: () => openBuy(rec) }, 'Bought'));
  if (!opts.noSkip) {
    btns.append(el('button', { class: 'tiny ghost', onclick: () => openReject(rec, 'notInterested') }, 'Not for me'));
  }
  btns.append(blockToggle(rec));
  foot.append(btns);
  body.append(foot);
  card.append(body);
  return card;
}

/* --------------------------------------------------- the comparison panel */
/* The primary way this app learns. Two magazines, one question, no scale to
   interpret and nothing to type. A forced choice between two things that are
   both on sale right now is a far better signal than a rating, because it is
   comparative and because the alternative was concrete rather than imagined.

   Deliberately drawn from across the whole newsstand rather than within a
   shelf: applyPair() cancels everything two magazines share, so a pair from the
   same shelf teaches almost nothing while a car magazine against a cookery one
   separates a dozen dimensions at once. */

// Dismissed for this session only. A block is forever; not wanting to be asked
// right now is not, so this deliberately does not persist.
let compareDismissed = false;
let compareSummoned = false;

// Whether the duel earns the top of the page this render. It is the best signal
// the app has, which is exactly why it must not be permanent furniture: a
// question that is always there stops being a question and becomes a banner to
// scroll past, and the answers it does collect start coming from people trying
// to clear it. So it is shown when it is genuinely the most useful thing on the
// screen — at the very start, while the model is still thin, or after a gap —
// and is otherwise reduced to a one-line invitation that can be taken up
// whenever the user feels like it.
function compareDue(t) {
  if (compareDismissed) return false;
  if (compareSummoned) return true;
  if (t.empty) return true;                       // the only way to bootstrap

  const answered = state.events.filter(e => e.kind === 'prefer');
  if (answered.length < 5) return true;           // still cheap and still moving

  const last = answered[answered.length - 1].at;
  const hours = (Date.now() - last) / 36e5;
  // Asked less often as the model firms up: at low maturity a fresh answer is
  // worth a lot, near the top it is worth little and the shelf is worth more.
  const gapHours = 6 + 42 * (t.maturity || 0);
  return hours >= gapHours;
}

// The collapsed form: one line, no cover art, no commitment.
function compareInvite(r) {
  const bar = el('div', { class: 'compareInvite' });
  const answered = state.events.filter(e => e.kind === 'prefer').length;
  bar.append(el('span', { class: 'muted small' },
    answered + ' comparison' + (answered === 1 ? '' : 's') + ' answered · '
    + Math.round(r.t.maturity * 100) + '% model maturity'));
  bar.append(el('button', {
    class: 'ghost',
    onclick: () => { compareSummoned = true; compareDismissed = false; render(); },
  }, 'Compare two magazines'));
  return bar;
}

function comparePanel(r) {
  const pair = pickComparison(r.scored, r.t);
  if (!pair) return null;

  const panel = el('section', { class: 'compare' });
  panel.append(el('div', { class: 'compareHead' },
    el('h2', {}, 'Which of these two would you rather read?'),
    el('p', { class: 'muted small' },
      r.t.empty
        ? 'This is how MagLens learns. It knows nothing about you yet — pick whichever appeals more and the whole list below re-ranks.'
        : 'Both are on sale now and both clear your filters. Only what makes them DIFFERENT is learned, so anything they share is ignored.')));

  const row = el('div', { class: 'compareRow' });
  for (const side of [pair.a, pair.b]) {
    const other = side === pair.a ? pair.b : pair.a;
    const choose = () => {
      recordPair(side.rec, other.rec);
      toast('Learned: ' + side.rec.title + ' over ' + other.rec.title);
      render();
    };

    // A div rather than a button, because this card carries buttons of its own
    // — Block, and Details — and a button inside a button is invalid markup
    // that browsers resolve by dropping one of them. The whole card stays
    // clickable for convenience; "Choose this" is the real control and is what
    // the keyboard reaches.
    const opt = el('div', { class: 'compareCard', onclick: choose });
    opt.append(el('div', { class: 'compareCover' }, coverNode(side.rec, { tier: COVER_TIER.large })));
    opt.append(el('div', { class: 'compareName' }, side.rec.title));
    opt.append(el('div', { class: 'compareMeta' },
      ((side.rec.issue && side.rec.issue.label) || 'issue unknown')
      + (side.rec.price.amount == null ? '' : ' · ' + fmtPrice(side.rec.price))));
    opt.append(topicChips(side.rec.topics, { limit: 3 }));
    opt.append(el('div', { class: 'compareBlurb' },
      (side.rec.content.summary.text || '').slice(0, 150)));

    const acts = el('div', { class: 'compareActs' });
    acts.append(el('button', { class: 'comparePick', onclick: e => { e.stopPropagation(); choose(); } },
      'Choose this'));
    acts.append(el('button', {
      class: 'tiny ghost', title: 'Details & sources',
      onclick: e => { e.stopPropagation(); openDetail(side.rec, side); },
    }, 'Details'));
    // Being asked to choose between two magazines is exactly when you discover
    // that one of them should never have been offered, so the block has to be
    // reachable here and not only from the ranked list below.
    acts.append(blockToggle(side.rec));
    opt.append(acts);
    row.append(opt);
  }
  panel.append(row);

  panel.append(el('div', { class: 'compareFoot' },
    el('button', {
      class: 'ghost',
      onclick: () => {
        // A skipped pair is recorded so the same question is not asked again,
        // but it trains nothing — "I cannot choose" is not a preference.
        state.meta.skippedPairs = state.meta.skippedPairs || [];
        state.meta.skippedPairs.push([pair.a.rec.id, pair.b.rec.id].sort().join('|'));
        scheduleSave();
        render();
      },
    }, 'Skip — can’t say'),
    el('button', {
      class: 'ghost',
      onclick: () => { compareDismissed = true; compareSummoned = false; render(); },
    }, 'Not now'),
    el('span', { class: 'muted small' },
      r.t.empty ? 'Nothing is recorded until you choose.'
        : r.t.eventCount + ' judgements so far · model maturity ' + Math.round(r.t.maturity * 100) + '%')));
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




/* ---------------------------------------------------------- the taste view */
/* Everything the app believes about the reader, what it believes it FROM, and a
   control to change or delete each belief. An inference with no visible
   evidence behind it is indistinguishable from a guess, and a system that
   cannot be corrected will eventually be wrong in a way that compounds. */



const evidenceWord = k => ({
  buy: 'bought', rate: 'rated', like: 'liked', dislike: 'disliked',
  notInterested: 'dismissed', skip: 'skipped', open: 'opened',
  view: 'was shown', alreadyRead: 'had already read',
}[k] || k);





/* -------------------------------------------------------- the history view */
/* Issue-level, not title-level. "You read Autocar India" is not a useful fact;
   "you bought the August 2026 issue for ₹150 and rated it 4" is, and it is what
   the repetition and already-have logic actually needs. */

let historyFilter = '';

/* ------------------------------------------------------- the research view */
/* The audit trail. Everything the app knows, where it came from, when it was
   read, what it could not establish, what it excluded and why, and the
   component-by-component arithmetic behind every score. It is also where
   metadata gets corrected and duplicates get resolved by hand, because an
   automated pipeline reading a dozen retailer layouts will get things wrong and
   the alternative to a correction button is a wrong answer that persists. */

let researchTab = 'Discovered';









/* ------------------------------------------------------------ detail sheet */

function openDetail(rec, cand) {
  const body = $('#detailBody');
  body.replaceChildren();
  recordEvent('open', rec);

  const head = el('div', { class: 'detailHead' });
  head.append(coverNode(rec, { tier: COVER_TIER.large }));
  const info = el('div', {});
  info.append(el('h2', {}, rec.title));
  info.append(el('div', { class: 'muted' },
    ((rec.issue && rec.issue.label) || 'issue unknown')
    + (rec.publisher ? ' · ' + rec.publisher : '')
    + (rec.category ? ' · ' + rec.category : '')));
  info.append(factRow(rec));
  info.append(topicChips(rec.topics, { limit: 12 }));
  info.append(voteBox(rec, (state.ranked && state.ranked.chosen) || []));
  // actionRow below is only rendered when a ranked candidate was passed in, so
  // the modal needs its own copy for the cases that open without one.
  info.append(el('div', { class: 'chipWrap', style: 'margin-top:8px' },
    blockToggle(rec, { label: 'Block this title' })));
  head.append(info);
  body.append(head);

  // The reasoning, the where-to-buy and the caveats used to live on the hero
  // card at the top of the month view. The hero is gone — every magazine is a
  // card in one ranked grid now — so they live here, which is where someone
  // asking "why this one?" actually goes.
  body.append(whereBox(rec));
  if (cand) body.append(actionRow(cand));

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
    el('button', { class: 'ghost', onclick: () => closeModal('#detailModal') }, 'Close')));

  openModal('#detailModal');
}

/* ---------------------------------------------------- manual metadata edit */


/* ------------------------------------------------------------- filter deck */
/* Hard constraints only. The deck is built from the corpus, so the topic and
   language lists grow as discovery does — there is no fixed menu of subjects,
   because a fixed menu would quietly define what the app thinks magazines are
   about before it has read a single one. */


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
    'Nothing selected means any language. English is set by default — this is a hard '
    + 'constraint about what you can read, not a taste.'));

  target.append(selectField('Titles whose language cannot be established', [
    ['latin', 'Keep them if the title is in the Latin alphabet'],
    ['strict', 'Drop anything not positively identified'],
  ], f.unknownLanguage, v => set('unknownLanguage', v),
    'Most listings never declare a language. "Keep" reads the script of the title and of the '
    + 'issue text before giving up; "drop" is cleaner but will hide real English titles whose '
    + 'page simply did not say so. Research → Sources reports how many are affected.'));

  target.append(selectField('Adult material', [
    [true, 'Hide pornography and erotica'], [false, 'Show everything'],
  ], f.hideExplicit, v => set('hideExplicit', v === 'true'),
    'Judged from the shelf a title is filed on, its name, and its issue text. This is separate '
    + 'from "Audience" below, which only says whether a magazine is written for adults — a '
    + 'defence quarterly is written for adults too.'));

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

  // Blocked titles live with the filters because that is what they are — a
  // hard constraint the user set. They are stored outside `filters` all the
  // same, so "Reset filters" cannot silently unblock them.
  if ((state.blocked || []).length) {
    const wrap = el('div', { class: 'field', style: 'grid-column:1/-1' });
    wrap.append(el('span', {}, 'Blocked titles (' + state.blocked.length + ')'));
    const list = el('div', { class: 'blockList' });
    for (const b of state.blocked.slice().sort((x, y) => y.at - x.at)) {
      list.append(el('div', { class: 'blockRow' },
        el('span', { class: 't' }, b.title || b.id,
          b.causeLabel ? el('div', { class: 'muted small' }, b.causeLabel) : null),
        el('span', { class: 'when' }, ago(b.at)),
        el('button', {
          class: 'tiny',
          onclick: () => { unblockRecord(b); render(); },
        }, 'Unblock')));
    }

    // A repeated cause is a filter that is not doing its job. Said once, with
    // the setting that would have caught them, rather than left for the user to
    // notice across a list of thirty.
    const byCause = {};
    for (const b of state.blocked) byCause[b.cause || 'other'] = (byCause[b.cause || 'other'] || 0) + 1;
    const unknownLang = byCause['language-unknown'] || 0;
    const otherLang = byCause['language-other'] || 0;
    const explicit = byCause.explicit || 0;

    if (unknownLang >= 3 && f.unknownLanguage !== 'strict') {
      wrap.append(el('div', { class: 'blockHint' },
        el('span', {}, unknownLang + ' of these were blocked because no language could be '
          + 'established for them. Dropping titles that cannot be confirmed English would '
          + 'have caught them before they were ever shown.'),
        el('button', {
          class: 'tiny primary',
          onclick: () => { f.unknownLanguage = 'strict'; state.ranked = null; scheduleSave(); render(); },
        }, 'Drop unconfirmed languages')));
    }
    if (otherLang >= 2 && !f.languages.length) {
      wrap.append(el('div', { class: 'blockHint' },
        el('span', {}, otherLang + ' were blocked for their language while the language '
          + 'filter is set to accept any.'),
        el('button', {
          class: 'tiny primary',
          onclick: () => { f.languages = ['English']; state.ranked = null; scheduleSave(); render(); },
        }, 'English only')));
    }
    if (explicit >= 2 && !f.hideExplicit) {
      wrap.append(el('div', { class: 'blockHint' },
        el('span', {}, explicit + ' were adult material, which the filter is currently set to show.'),
        el('button', {
          class: 'tiny primary',
          onclick: () => { f.hideExplicit = true; state.ranked = null; scheduleSave(); render(); },
        }, 'Hide adult material')));
    }
    wrap.append(list);
    wrap.append(el('small', { class: 'muted' },
      'Blocked titles never appear in the ranking, in Browse, or as one side of a '
      + 'comparison, and blocking teaches the taste model nothing at all — not the '
      + 'subject, not the publisher, not the price. It is a hard constraint, like a '
      + 'filter. Downvote as well if you also dislike the subject.'));
    target.append(wrap);
  }

  if (Object.keys(state.nudges || {}).length) {
    const n = Object.keys(state.nudges).length;
    target.append(el('label', { class: 'field', style: 'grid-column:1/-1' },
      el('span', {}, 'Manual ranking order'),
      el('button', {
        class: 'ghost',
        onclick: () => { clearNudges(); toast('Manual ordering cleared'); render(); },
      }, 'Reset ' + n + ' hand-placed title' + (n === 1 ? '' : 's')),
      el('small', { class: 'muted' },
        'Positions you set with the ▲ ▼ arrows. Clearing these returns the list to '
        + 'the model’s own order; it does not un-teach what the votes taught, which '
        + 'lives in History as individual events.')));
  }

  target.append(multiSelect('Publication type', [
    ['magazine', 0], ['newspaper', 0], ['journal', 0], ['book', 0],
  ], f.kinds, v => set('kinds', v),
    'Most of what the sitemaps list is not a consumer magazine — a large share is academic '
    + 'journals and coursebooks. Magazines only, by default.'));

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
  // Not removable from the pill row: one × should not silently unblock a list
  // of titles the user blocked one at a time. It opens the deck instead.
  if ((state.blocked || []).length) {
    pills.push({
      label: state.blocked.length + ' blocked',
      reset: () => toggleDeck(true),
      keep: true,
    });
  }
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
    ['English', 'English only'], ['any', 'Any language'],
  ], f.languages.length ? 'English' : 'any',
    v => set('languages', v === 'any' ? [] : [v]),
    'English by default. A magazine you cannot read is not a recommendation.'));

  grid.append(selectField('Adult material', [
    [true, 'Hide pornography and erotica'], [false, 'Show everything'],
  ], f.hideExplicit, v => set('hideExplicit', v === 'true')));

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

// One view. The app answers one question, and the four inspection views that
// grew around it — Browse, Taste, History, Research — were answering questions
// about the app instead. What is still worth seeing lives on the card or behind
// Details.


let renderToken = 0;

function render() {
  renderToken++;

  const pills = activeFilterPills();
  $('#filterCount').hidden = !pills.length;
  $('#filterCount').textContent = String(pills.length);
  const pillBox = $('#activePills');
  pillBox.replaceChildren();
  for (const p of pills) {
    // A pill marked `keep` stands for a list rather than a single setting, so its
    // control opens the deck to manage it. Clearing a dozen blocked titles with
    // one stray × is not an undo anybody wanted.
    pillBox.append(el('span', { class: 'pill' }, p.label,
      el('button', {
        title: p.keep ? 'Manage' : 'Remove',
        onclick: () => {
          if (p.keep) { p.reset(); return; }
          p.reset(); state.ranked = null; scheduleSave(); render();
        },
      }, p.keep ? '⋯' : '×')));
  }

  $('#headline').textContent = headlineText();
  if (!$('#deck').hidden) renderDeck($('#deckGrid'));

  viewMonth();
}

// How many DISTINCT consumer magazines are actually known about, as opposed to
// how many URLs the sitemaps emitted. Three things inflated the raw number and
// all three are corrected here: the same title listed under two category paths
// counted twice, academic journals and coursebooks counted at all, and titles in
// languages the reader cannot read counted as if they were on offer. Saying
// "10,406 titles on sale in India" when most of them are neither magazines nor
// readable is the kind of confident-sounding number this app is supposed not to
// produce.
function leadStats() {
  const f = state.filters || defaultFilters();
  const seen = new Set();
  let consumer = 0, journals = 0;
  for (const lead of state.leads) {
    const cat = (lead.category || '').toLowerCase();
    const key = canonTitle(lead.title || lead.url);
    if (!key) continue;
    if (seen.has(key)) continue;      // same title, second shelf
    seen.add(key);
    if (/academic|journal|coursebook|exam|university|research/.test(cat)) { journals++; continue; }
    if (/newspaper/.test(cat)) continue;
    if (f.hideExplicit && EXPLICIT_CATEGORIES.test(cat)) continue;
    consumer++;
  }
  return { distinct: seen.size, consumer, journals, raw: state.leads.length };
}

function headlineText() {
  const researched = state.magazines.size;
  const bits = [];
  const ls = leadStats();
  bits.push(ls.consumer.toLocaleString('en-IN') + ' consumer magazines indexed'
    + (ls.raw > ls.consumer ? ' (of ' + ls.raw.toLocaleString('en-IN') + ' listings)' : ''));
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
    filters: state.filters,
    merges: state.merges, blocked: state.blocked, nudges: state.nudges, meta: state.meta,
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
    state.merges = data.merges || [];
    state.blocked = data.blocked || [];
    state.nudges = data.nudges || {};
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

  if (migratedFilters) {
    toast('Updated: English-only and no adult material are now on by default. '
      + 'Change either in Filters.', 6000);
  }

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
