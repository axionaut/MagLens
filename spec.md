# MagLens — behavioural record

Organised by version. Newer sections supersede older ones; when correcting stale
text, mark the old passage as superseded rather than rewriting history.

---

## 1. Initial build

### 1.1 What this app is

A monthly magazine recommender for India whose source of truth is a live read of
what is on sale, not a bundled catalogue, and whose user profile begins with
nothing in it at all.

Static `index.html` + `styles.css` + `app.js`, served from the repository root.
No build step, no dependencies, no backend, no keys required.

### 1.2 Feasibility findings that shaped the design

Established by probing live endpoints before any code was written.

**No retail source is CORS-open.** `magzter.com` returns 403 to a plain request
and sends no `Access-Control-Allow-Origin`; `amazon.in` returns 503;
`readwhere.com` and `frontline.thehindu.com` answer but send no header.
`autocarindia.com`, `theweek.in` and `sanctuarynaturefoundation.org` do send
`Access-Control-Allow-Origin: *`. A static page therefore cannot do live
discovery without a proxy.

**Proxy chain, tested.** `r.jina.ai` returned 200 with the Origin reflected, and
ten consecutive requests at ~1/s all succeeded — the basis for `PACE_MS = 1000`.
`api.allorigins.win` and `api.codetabs.com` both returned 522 on the retailer
pages this app cares about, so they sit behind it as fallbacks for plain-HTML
sources. `corsproxy.io` returned 403.

**Magzter's India sitemap is the discovery universe.**
`sitemapxml/magazines_1.xml` enumerates **10,406 unique `/IN/` titles** in one
3.7MB fetch. `/IN/` is the store's own marker for "sells in the India store", so
the sitemap doubles as an availability-in-India filter. Its URL shape
`/IN/{publisher}/{title}/{category}/` carries three fields before any page is
read. Category distribution: Academic 4572, Newspaper 1266, Comics 974,
Business 586, Children 333, Education 296, News 272, Lifestyle 257 — the tail
holds the magazines anyone would actually buy.

The sitemap's own `Published Time` was 28 Sep 2025, i.e. it goes stale. This is
surfaced in Research and is the reason the web-search connector exists.

`title_issues_*.xml` was evaluated and rejected: 8MB, last regenerated June
2025, and carries no dates.

**A Magzter title page carries everything needed.** Verified against India Today
and Autocar India: breadcrumb publisher, `magazines/listAllIssues/{id}` (a
stable title id, the best dedup key available), an `# {Title} Magazine- {Issue}`
heading, a `Publisher: / Category: / Language:` metadata row, `Frequency:`, an
`## In this issue` description, `## [HEADLINE standfirst … N mins](story-url)`
cover lines, `## Recent issues`, and a cover image.

**DuckDuckGo's HTML endpoint works through the reader proxy** and returns real
result URLs inside a `uddg=` redirector — open-ended search with no key and no
account.

**Readwhere's magazine pages are client-rendered.** A text proxy sees only
boilerplate. It contributes titles and languages from its sitemap and cannot be
asked what this month's issue is — which is why discovery and issue
identification are separate concerns in the architecture.

### 1.3 Prices and currency

A proxied read originates wherever the proxy lives, so Magzter answered with US
store pricing (`$1.99`, `flag/new/us.svg`) during development. The store region
is parsed from that flag and carried on every observation. A non-India reading is
shown in its own currency with the store named; it is never converted into a
rupee figure and presented as an Indian price. `FX_TO_INR` exists only to make
prices comparable for the value-fit score.

Offers are paired positionally against their labels in the purchase block
(single issue, then short subscription, then annual), because Magzter emits both
lists in the same order. Where pairing fails — the page emits `$NaN` often
enough to matter — the cheapest figure in the block is taken as the single-issue
price and marked `inferred`.

### 1.4 The fetch budget

Enumeration is one request; reading an issue is one request per title; there are
ten thousand titles. `planFetches()` splits a fixed budget (default 90) 25/35/40
between verifying currently-recommended titles, refreshing readings that are
stale *in the magazine's own cycles*, and breadth across never-read titles.

Breadth is round-robin across categories, ordered by sitemap position with a
small deterministic jitter. The first implementation shuffled randomly and a
14-fetch sample returned a defunct society newsletter, two coursebooks and a
Gujarati astrology monthly; sitemap position tracks title id, so an early entry
is long-established. After the change the same budget returned India Today,
Autocar India, Car India, Down To Earth, Filmfare, TINKLE and Outlook Traveller.

### 1.5 Publication kind

Inferred, not taken from the source's category. Newspapers (1,266 titles),
coursebooks and academic journals (4,572) are genuinely on sale and genuinely
discovered, but are not what "which magazine should I buy" asks. On the first
end-to-end run the cold-start winner was a Bihar teacher-recruitment guide, and
the run before that a daily newspaper. Default filter: `kinds: ['magazine']`.

A `Frequency: Books` string is a better tell than a `Children` shelf, so kind is
derived from frequency, cadence in days, category and title together.

### 1.6 Content understanding

Two passes. An ontology of ~65 subjects with word-boundary matching, and a mining
pass over cover lines kept within a corpus document-frequency band (ceiling
0.28). Mining is script-agnostic: a Hindi monthly indexed under `कृष्ण`,
`जन्माष्टमी` and `धर्म` in testing.

Text is weighted by how much it says about *this* issue: cover lines ×4, issue
description ×3, blurbs ×2, title ×2, category ×2, standing magazine description
×1.

Derived alongside: `newsiness`, `visualness`, `difficulty`, `audience`, each
rendered as a word rather than a number.

`visualness` comes chiefly from reading time per piece where the source
publishes one. Only Magzter's "Stories" partners do — Autocar India has a rich
issue description and no per-article index at all — so a substantial issue
description counts as `depth: 'issue'` too, or nine titles in ten would be judged
on their shelf category alone.

### 1.7 Issue identification and confidence

`identifyCurrentIssue()` scores rather than decides. Inputs: label precision
(day > month > quarter > number > unparseable), agreement with the magazine's own
cadence, whether the source lists a newer issue than the one it presents as
current, cross-source agreement, and the age of the reading measured in cycles.
Output: 0–1 plus a band (verified / likely / uncertain / unknown) and the list of
reasons, shown on every card.

Cadence is checked rather than believed: declared frequency against the median
gap between recently-listed issues, with a disagreement recorded as a conflict.

### 1.8 Zero-seed profile

`defaultFilters()` contains only hard constraints and "no constraint" values.
`topicsWanted` and `topicsExcluded` are empty arrays. Onboarding asks five
questions — budget, print/digital, news, audience, language — and not one about
interests, because a questionnaire asking which subjects appeal is seeding by
another name.

With an empty model `preferenceFit()` returns exactly 0.5 with the note
"nothing learned yet — this is not a personalised score", the shortlist is
selected at high diversity pressure, and the month view carries an explicit panel
saying the shortlist is chosen for breadth rather than fit.

Verified: cold start over 15 usable magazines produced a shortlist of 6 with 11
distinct subjects and a maximum pairwise topic similarity of 0.28.

---

## 2. Defects found by end-to-end testing, and their fixes

All found by running the real connectors against live pages, then rendering
every view in jsdom.

### 2.1 Ranking oscillated between renders

**Symptom.** Six consecutive renders of the month view produced
`Filmfare → Down To Earth → Business Of Fashion → Sadhana Path → …`.

**Two causes.** `historyContext()` read `state.meta.cycles` including the current
month, and `currentCycle()` writes that entry as a side effect of ranking — so
this month's pick collected the full `recentTitle` penalty (weight −1.6) on the
very next recompute. And `markViewed()` records a `view` event during render,
which invalidated both the ranking and taste caches and shifted the model.

**Fixes.** `recommendedAt` now skips `+month >= nowMonth()`. Both cache keys count
only non-view events.

### 2.2 A view event was training data

The deeper half of 2.1. Being shown a magazine is a fact about what the ranker
chose, not about what the reader likes; training on it means learning from the
recommender's own output. `EVENT_WEIGHT.view` is now `0` and `buildTaste()` skips
view events entirely while still counting them for the timeline. "Shown and not
wanted" has its own deliberate event: `skip`.

### 2.3 Near-universal facets outvoted stated preferences

A reader taught with four purchases, four 5-star ratings and three explicit
"too text-heavy" rejections to want highly visual, easy reading (learned
visualness 0.87 ± 0.11, difficulty 0.31) was handed a text-heavy business
monthly at visualness 0.25. The two scalar terms were correctly at −1 each and
were outvoted by *likes Monthly*, *likes English* and *likes adult*.

**Fix.** `discriminativeness()` damps a facet utility by `1 − share^0.7` across
the corpus, so a value on four titles in five contributes almost nothing.
Scalar weights raised (visualness 0.9, difficulty 0.8, newsiness 0.8), facet
weights lowered, publisher promoted above language and frequency.

### 2.4 Preference fit could not outweigh generic appeal

`prefFit` sits in [0,1] around a neutral 0.5, so a firm mismatch moved the total
less than a missing cover image did. It is now stretched about the neutral point
by `1 + 1.7 × maturity`, where `maturity = 1 − exp(−totalWeight / 9)`. An
uninformed model still cannot assert anything; an informed one can sink an
otherwise excellent magazine. `WEIGHTS.appeal` dropped 0.8 → 0.6 because appeal
is partly a measure of how much of the issue could be read.

After the change, on a corpus of 15: TINKLE `prefFit 0.94 → 2.44` against
Business of Fashion `0.38 → 0.98`.

### 2.5 A subject word was read as an audience

`CHILD_CUES` listed bare `children`, `kids` and `child`, so *Down To Earth* — an
environment fortnightly for policy readers — was classified as a children's
magazine because that issue ran a piece on child nutrition. Audience is a hard
filter, so this hid the wrong things.

**Fix.** Cues now describe who the magazine is *for* (`for children`, `young
readers`, `ages 5`) and never what it is *about*. The shelf leads; a veto blocks
`child` when politics/business/finance/defence/celebrity weight exceeds 0.25.
Verified: Down To Earth → adult, Car India → adult, Business of Fashion → adult,
TINKLE → child.

### 2.6 Markdown leaked into extracted prose

The `## X Magazine Description:` heading is followed by the
Publisher/Category/Language link row, which was scraped in as the description
and shown verbatim on the card. `stripMd()` and `isMarkupLine()` now clean every
piece of prose lifted out of reader output — which also matters for the topic
miner, since URL fragments would otherwise become tags.

### 2.7 A retired listing kept a cover

Stale sitemap entries redirect to the Magzter front page, which parses as a
valid page about nothing. The redirect was detected, but the record kept a cover
image picked up from the front page's carousel — belonging to another magazine
entirely. `coverUrl` and `issueLabel` are now cleared when availability is
`gone`.

### 2.8 Freshness penalty was flat

A 2013 fortnightly scored 45% confident — the same as one issue late — because
everything past the threshold was penalised identically. Now
`0.18 + 0.3 × log2(cyclesLate)`, capped at 0.8.

### 2.9 Cold-start ties broken by iteration order

Banded `appeal` scoring put three unrelated magazines on an identical 5.19 and
left the winner to `Map` ordering. `appeal` is now continuous in article count,
summary length and topic count.

### 2.10 Smaller fixes

- Ordinal cover dates (`August 2nd 2026`) fell through to the numbered branch
  and lost their date entirely. Now stripped before parsing.
- Research → Sources looked up lead counters by the first word of the display
  name (`leads:web`) against keys written as `leads:websearch`.

---

## 2A. v2 — the app did not run at all

Reported from the live Pages deploy, as a black page with an empty panel
floating on it and a blurred "Mark as bought" sheet behind that.

**Cause.** The `hidden` attribute hides an element through the UA stylesheet rule
`[hidden] { display: none }`, whose specificity is (0,1,0) — identical to a class
selector. On a specificity tie the author stylesheet wins, so `.modal { display:
grid }` cancelled `hidden` on every modal. All five rendered simultaneously,
each with its own `rgba(6,8,11,.72)` backdrop; five of those stacked is opaque
black over `#main` and over the topbar at its lower z-index. The topmost in DOM
order, `#mergeModal`, showed as an empty `.modalBody.wide` — 900px wide, 48px
tall, exactly the floating panel in the report — and its `backdrop-filter`
blurred `#buyModal` beneath it.

The giveaway in the screenshot was that the buy sheet read "Mark as bought", the
literal string in `index.html`. Had `openBuy()` ever run it would have read
"Bought: *title*". Nothing had opened these modals; they had never been closed.

`.progress` (`display: flex`), `.pipCount` (`display: inline-block`) and
`.barStats` (`display: grid`) carried the same defect. `#deck`, `#btnStop`,
`#btnTop` and `#importFile` were unaffected because no class sets `display` on
them — which is why the bug was invisible in review: it depended on a property
set somewhere else in the file.

**Fix, in two layers.** A global `[hidden] { display: none !important; }` catches
anything added later. But `!important` invites a louder `!important` to defeat
it, so each of the four classes is additionally written `:not([hidden])`, which
at (0,2,0) simply does not apply while the element is hidden, leaving the UA rule
to win uncontested. The second layer is the load-bearing one.

**Why the test suites missed it.** Both harnesses render in jsdom without the
stylesheet attached, so they exercised the DOM and the JS and could not see a
cascade problem. A CSS check was added: `styles.css` inlined into the real
`index.html`, asserting `getComputedStyle(el).display === 'none'` for every
element carrying `hidden`, and asserting that each one still toggles both ways.
Run against the pre-fix stylesheet it reports all six modals plus `progress` and
`filterCount` leaking; after, none.

Note that jsdom's cascade ignores `!important`, so it can only verify the
`:not([hidden])` layer — which is the layer that matters.

---

## 3. Verification performed

No assertion suite is kept in the repository. The following were run against
live data during the build and the scripts discarded.

**Pipeline probe** — real sitemap, real detail fetches, real ranking:
10,406 leads enumerated; 26 then 70 detail pages read; TOC extraction confirmed
at 25/29/36 entries on the titles that publish one and correctly 0 on those that
do not; issue-label parser across nine shapes; duplicate detection.

**UI smoke test** — real `index.html` in jsdom, real `app.js`, real fetched
records. All five views, all six Research sub-tabs, the filter deck, onboarding
and all four modals rendered with zero errors, both with an empty profile and
after seven recorded interactions.

**Stability test** — six consecutive renders must produce the same pick. Failed
before §2.1, passes after.

**Behaviour test** — cold-start diversity; that teaching a consistent taste moves
the learned scalars and changes the pick; that the exploratory slot is labelled,
clears hard filters, and never takes the primary slot; that the repetition
penalty fires; that muting a topic zeroes it and unmuting restores it; that
deleting a purchase rebuilds the model (`comics 2.98 → 2.19`).

**Static checks** — `node --check app.js`; every `$('#id')` in `app.js` resolves
to an id in `index.html` (45/45).

## 4. v3 — English-only, no adult material, pairwise learning, one ranked grid

Six defects reported by the owner against v2. Four were real bugs, one was a
missing control, one was a misleading number. All six are fixed; a seventh item
(a replacement India newsstand) was attempted and abandoned, see §4.8.

### 4.1 Other languages appeared under an English-only filter

Two independent faults. `defaultFilters()` shipped `languages: []`, which means
*any* language — and the gate in `evaluateFilters` read:

```js
if (rec.language && !f.languages.includes(rec.language)) fail(...)
```

so a title whose language could not be read was never rejected. Since most
listings never declare a language, "English only" was letting most of the
newsstand through. `normLanguage` made this worse by only script-checking the
*title*, so Grihshobha and Saras Salil — Hindi magazines with Latin-script
names — came back `null` and passed.

Fixed on three fronts. English is now the default. Detection reads, in falling
order of authority: the declared language, the title's script, **the script of
the issue text** (12+ characters in one range), a language named outright in the
title or shelf, and a romanised-Indic title list (`INDIC_TITLE_CUES`). The basis
is stored on the record as `languageBasis`, so a heuristic match is never
presented as a declaration. Unknown-language titles are now rejected when the
title is not Latin script (`nonLatinTitle`), with a `filters.unknownLanguage`
control offering `strict` for anyone who wants the harder line.

### 4.2 Pornography could not be excluded

There was no control. `ADULT_CUES` mixed erotica with `liquor`, `whisky`,
`cocktail` and `lingerie`, and its only effect was to set `content.audience =
'adult'` — which is equally true of a defence quarterly. The `audience` filter
selected *for* that bucket and could not select against it.

`EXPLICIT_CUES`, `EXPLICIT_TITLE_CUES` and `EXPLICIT_CATEGORIES` are now a
separate question answered by three independent signals: the shelf a title is
filed on, its name, and its issue text. Shelf and title are decisive alone; body
text needs three hits, because one word in a book review is not a porn magazine.
`filters.hideExplicit` defaults true. Food, drink and fashion titles are
deliberately untouched — the owner's decision, recorded here because the wider
reading of the cue list was offered and declined.

### 4.3 Like and dislike changed nothing

The most serious of the six, and it was backwards: **a title scoring a perfect
1.00 on preference fit finished 8th, below seven titles the model knew nothing
about.** Measured on a 12-magazine synthetic corpus after two likes and two
dislikes, with topic utilities correctly learned at `travel=+2.06`,
`food=+1.87`, `finance=-2.20`:

```
Travel Diaries  base=4.98          Cricket Weekly  base=6.04  (zero signal)
  prefFit     1.000 x  2.6 =  2.600   prefFit     0.877 x  2.6 =  2.279
  novelty     0.214 x  0.5 =  0.107   novelty     1.000 x  0.5 =  0.500
  exploration 0.566 x  0.5 =  0.283   exploration 1.000 x  0.5 =  0.500
  repetition  1.000 x -1.3 = -1.300   repetition  (none)
```

Three compounding causes:

1. **`like` fed the subject cool-off.** `historyContext` listed `like` beside
   `buy` and `alreadyRead` when building `subjectMonths`, so liking a travel
   magazine marked travel as *just read* and fired the full `-1.3` repetition
   penalty on every travel title. The one button asking for more of a subject
   was the button burying it. The cool-off now counts consumption only.
2. **`novelty` rewards mismatch by construction.** A title that fits your taste
   is close to the centroid, so it scores near zero where an unrelated one
   scores 1.0 — a 0.39-point handicap for being right.
3. **`exploration` does the same**, for the same reason, costing another 0.22.

Net: a perfect match started 1.89 points behind a magazine with no signal.

Novelty and exploration are cold-start terms and are now scaled by
`1 - 0.75 * maturity`. That alone was not enough — at one event maturity is
0.16, so the scaling is negligible and an upvoted title still placed outside the
top four. Added `WEIGHTS.voted` (1.9): a vote is an instruction about *one
magazine*, not evidence about a genre, and must move that magazine on its own.
Both cold-start terms are zeroed outright for a voted record, since a title the
user has judged is not unknown territory. Verified: upvoting takes a title to #1
at 98%, and clearing the vote returns the ranking to exactly its prior order.

### 4.4 Learning is now a pairwise choice

Owner's design: *"It should show me two magazines and ask which one I prefer.
That's how it learns. Simple."*

`applyPair` records only the **difference** between the two records. Everything
they share cancels: if both are English monthlies the choice says nothing about
English or about monthlies and nothing is stored against them. Topics move on
`share_winner - share_loser`; facets are recorded only where the pair disagrees;
scalars take the winner's value as target and the loser's as repulsion, and only
when the gap clears a floor (0.12, or ₹40 on price).

This is structurally immune to the failure §2.3 papered over with
`discriminativeness`: a value carried by four titles in five cannot accumulate
evidence here, because it sits on both sides of nearly every pair.

`prefer` carries weight 2.6 — above `rate`, below `buy`. It is stored as one
event on the winner naming the loser, not as a like plus a dislike, because it
is one judgement: the loser was not called bad, only second.

`pickComparison` draws the pair. Per the owner's follow-up — *"between any two
random magazines, not necessarily from same genre"* — contrast carries the
largest term (2.0), same-shelf pairs are penalised, and the random term is
deliberately large (1.6) so the question feels drawn from the whole newsstand
rather than optimised. Information gain shapes the draw; it does not determine
it. Measured topic overlap across five consecutive generated pairs: 0.00 every
time. Both sides must clear availability and freshness bars — asking someone to
choose between two magazines they would never buy produces an answer, and the
answer is noise.

### 4.5 Up/down voting in the ranked list

Owner's request: ranker.com-style voting that adjusts and learns. Every card
carries up and down arrows. A vote is a **position, not a tally**: `setVote`
deletes any standing like/dislike before recording the new one, and pressing the
active arrow clears it. Clearing deletes the event rather than patching the
model, so what comes back is exactly the model that would have existed had the
vote never been cast — the same honesty rule as the Taste view overrides in
§1.8. Verified by round trip: 50% → 100% → 50%.

### 4.6 The hero card is gone

v2 rendered one large `pickCard` plus a row of small `rankCard`s. That asserts a
confidence the ranking does not have, and the owner asked for the CineLens
treatment instead: one uniform `auto-fill` grid, every magazine in the same
frame, cover, rank badge, **match percentage**, topic chips, vote arrows.

The match badge is `fit.score` alone — the preference-fit term, not the total.
The total mixes in availability and freshness, which are facts about the shop
rather than about the reader, and a number labelled "match" has to mean what it
says. With an empty model every card reads 50% and the copy says so.

`whyBox`, `whereBox` and `uncertaintyBox` were not deleted with the hero; they
moved into the detail modal, which is where someone asking "why this one?"
actually goes. `pickCard` is removed.

### 4.7 "10,406 titles on sale in India" was misleading

The owner doubted the number, and doubted issues were being counted as titles.
The second concern was unfounded — the sitemap regex requires a token boundary
after the third path segment, so four-segment issue URLs never match; confirmed
directly against sample URLs. Three other things inflated it:

- leads deduplicate on **URL**, so one title under two category paths counts twice;
- academic journals and coursebooks (a large share of the Magzter India store)
  counted as magazines;
- languages the reader cannot read counted as if they were on offer.

`leadStats()` now reports raw listings, distinct titles after canonical-title
deduplication, and consumer magazines after dropping journals, newspapers and —
when the filter is on — adult shelves. The header reads "*N* consumer magazines
indexed (of *M* listings)" and the cycle summary breaks down all three. The
hard-coded "Of 10,400 titles... about 4,500 are academic" hint in the filter
deck is gone; it was a build-time observation presented as a standing fact.

### 4.8 A replacement newsstand was attempted and abandoned

The owner proposed archive.org's The Magazine Rack. Checked rather than assumed:
654,651 items, and they are individual scanned back issues (`murzilka-1991-01`,
`BoletinOficialTarragona_1888_115_18880516`), largely non-English and
historical, free to read, with no price, no availability and no current issue.
It answers a different question and would worsen both §4.1 and §4.7. Declined
with reasons.

A substitute India newsstand was then attempted. PressReader's India catalogue
is JS-rendered — the reader proxy returns 9.8 KB of navigation chrome and no
titles. Zinio, Magazine Mall and Indian Magazine Online all returned near-empty
under r.jina.ai rate limiting. **No connector was written.** Shipping a parser
against markup that could not be read is the exact mistake recorded in the
`DIRECT_OK` comment — Readwhere was once added on the assumption it sent CORS
headers, returned nothing in the browser, and a Node harness reported success.
Left open deliberately.

### 4.9 Migration

`loadState` spreads stored filters over the defaults, so an existing profile's
`languages: []` would win and the new English default would never arrive. A
one-time `meta.filterVersion < 3` migration sets the three new fields only where
the user had not already chosen, and a toast says what changed rather than
silently altering results.

### 4.10 Verification for this release

Headless logic harness over the real ranking and learning code, plus a jsdom
smoke test over the real `index.html` and `app.js`. All five views rendered with
zero failures; the vote button and both comparison cards dispatch real clicks
and record the expected events; 12 match badges present on a 12-title corpus.
Lead deduplication confirmed (4 raw → 3 distinct → 2 consumer). `node --check
app.js` and `git diff --check` clean. The owner does the browser testing.

## 5. v4 — blocking, a duel that knows when to stop asking, full-width layout

### 5.1 Blocking a title

Requested as a plain "option to block a magazine". Implemented as the bluntest
control in the app and kept deliberately distinct from the three softer things
it is easy to confuse it with:

| control | scope | teaches the model |
|---|---|---|
| downvote (▼) | ranking term on one title | yes |
| Not for me | declines this issue, with a reason | yes, via `REASON_EFFECTS` |
| **Block** | removes the title from the app, permanently | **no** |

The "teaches nothing" column is the design decision worth recording. People
block for reasons that say nothing whatever about taste — they already
subscribe, it is not sold near them, they read it at work — and a block that
quietly trained the model against the subject would punish a whole shelf for a
fact about one magazine. Anyone blocking out of dislike can downvote as well,
and the two controls sit beside each other on the card.

`state.blocked` holds `{ id, canon, title, at, note }` and is stored **outside**
`filters`, so that "Reset filters" cannot silently unblock a magazine somebody
took the trouble to block. Entries carry the canonical title as well as the
record id, because a record can be merged, split or rediscovered under a new id
and a block that leaks in those cases is worse than useless.

The gate is the first check in `evaluateFilters` and returns immediately, so a
blocked title is gone from the ranking, from Browse, and from either side of a
comparison, whatever else it scores.

Blocking is instant rather than behind a confirm dialog — a dialog on every
block makes the control annoying enough to go unused — and is paid for by an
undo offered in the toast (`toastAction`, new). The full list, with per-title
unblock, is in the filter deck; a `N blocked` pill appears in the header. That
pill's control is `⋯` and opens the deck rather than `×` clearing the list,
because one stray click should not undo a dozen separate decisions.

### 5.2 A zero weight is not the same as no weight

`EVENT_WEIGHT.block` was set to 0 to keep blocks out of training, exactly as
`view` is. That is not sufficient, and the reason is a live trap in
`buildTaste`:

```js
const w = (EVENT_WEIGHT[ev.kind] || 0.2) * (ev.weightMul || 1);
```

`0 || 0.2` is `0.2`. The fallback for an *unknown* event kind silently captures
any kind whose weight is deliberately zero, so a block would have trained at
0.2 — above `skip`. `view` escapes only because it is `continue`d before this
line ever runs. `block` now does the same, and the comment at that line records
why the zero in the table is decorative rather than load-bearing.

### 5.3 `empty` meant "nothing recorded", not "nothing learned"

Found while testing §5.2 and pre-existing since v1. `finaliseTaste` defined:

```js
empty: model.eventCount === 0
```

but `eventCount` is incremented for the two kinds that are deliberately *not*
trained on. Rendering the month view calls `markViewed`, which logs a `view`, so
**the model stopped describing itself as empty after a single render** — with
nothing learned from. Every card then showed a match percentage derived from no
evidence at all, the "this is not a personalised recommendation yet" panel
disappeared while it was still entirely true, and `selectShortlist` dropped out
of its cold-start diversity pressure of 1.5.

Now `empty: model.totalWeight <= 0`. Weight only moves when something was
actually learned from, which is the honest test. `eventCount` remains for
display.

### 5.4 The duel no longer sits permanently at the top

Reported directly: *"the comparison/duel shouldn't always be present on top."*

The comparison is the best signal the app has, which is exactly why it must not
be permanent furniture. A question that is always there stops being a question
and becomes a banner to scroll past, and the answers it does collect start
coming from people trying to clear it rather than people expressing a
preference.

`compareDue()` shows the full panel when it is genuinely the most useful thing
on screen — an empty model (the only way to bootstrap), fewer than five answers,
or after a gap — and otherwise collapses it to `compareInvite()`, a single line
carrying the answer count, model maturity, and a button. The gap widens as the
model firms up: `6 + 42 * maturity` hours, so a fresh answer is asked for often
while it is worth a lot and rarely once it is not.

A `Not now` control dismisses it for the session. That deliberately does not
persist: a block is forever, not wanting to be asked right now is not.

### 5.5 Full-width layout

Reported: *"the space is not being used properly to full width."*

`main` carried `max-width: 1180px; margin: 0 auto`, which left most of a wide
monitor empty now that the view is a card grid rather than one hero. The cap
existed to keep prose readable, so that job was moved to the prose: `main` is
now full width with a gutter of `clamp(16px, 2.2vw, 44px)`, the header shares
the same gutter so it lines up, and running text carries its own `88ch` measure.
The card grid drops to `minmax(215px, 1fr)` so a wide screen gains columns
rather than wider cards. `.compareRow` is capped at 980px — two magazine covers
stretched across an ultrawide is not a comparison anybody can scan.

### 5.6 Verification

jsdom smoke test over the real `index.html` and `app.js`, 0 failures:

- a blocked title leaves the grid, is excluded with reason `blocked`, and is
  absent from `scored` so it can never be drawn into a duel;
- blocking leaves `taste.empty === true` and zero learned topics;
- unblocking restores the title to the grid;
- the duel is due on an empty model, not due at 0.82 maturity after six
  answers, collapses to the invite bar, and expands again on demand;
- all five views render.

## 6. v5 — an upvote moves one place, not to the top

Reported directly: *"When upvoting like ranker, why are they jumping straight to
top?? It just means they jump one place and learns accordingly."*

Correct, and v4 was wrong. `WEIGHTS.voted` gave an upvoted title a flat +1.9,
which is a teleport. An arrow beside a ranked row does not mean "best of all",
it means **"this one beats the one above it"** — a statement about two adjacent
titles.

### 6.1 A vote is now an adjacent pairwise comparison

An upvote on rank *N* records `prefer(N over N−1)` — the same event the duel
produces — and a downvote records `prefer(N+1 over N)`. `WEIGHTS.voted` and the
`ctx.votes` map are gone. Pressing again compares the row with its **new**
neighbour and walks it up another step, as repeated voting does on any ranked
list.

The toggle semantics went with it: "undo my vote" and "vote again" cannot be the
same button. The events live in History and are individually deletable, which is
the honest undo and the one that rebuilds the model exactly.

The arrows are disabled at the top and bottom of the list, and in Browse
whenever it is sorted by anything other than best fit — position under a price
sort says nothing about preference, so there is nothing honest for an arrow to
record there.

### 6.2 Teaching alone moved the row the WRONG WAY

The first attempt recorded only the comparison and let the list re-rank. Upvoting
a finance magazine taught *finance*, which lifted the finance title already above
it further still, and the voted row went **down** a place:

```
upvoting #7 (Money Matters) once...
  now at #8      <-- moved down
```

An arrow that moves a row the wrong way is worse than one that does nothing. So a
vote now does two things, and both are needed: it **teaches** (`applyPair`, from
the adjacent pair) and it **asserts** a position. The assertion is `state.nudges`,
a persisted `recordId -> score delta` map added as its own scoring term, and it
is the same kind of object as the Taste view's `overrides` — an explicit, visible,
reversible user correction that wins. It is shown in Research beside every other
term and can be reset wholesale from the filter deck, which clears positions
without un-teaching what the votes taught.

### 6.3 Solve for the smallest delta, not the first one that works

The delta is solved for *after* the learning is applied, against the rank the
user was actually looking at, so the two halves cannot fight.

The first solver grew the delta geometrically (×1.6) until the row passed its
partner. That overshoots badly — the step that finally worked was several times
larger than the one needed, and a single press carried a title from seventh to
second. Rank is monotonic in the delta, so it is now found by **bisection**,
which yields the minimum and therefore a one-place move. If 18 doublings cannot
reach the target the row is pinned by a hard term such as `ownedIssue`; no
ranking delta should override one of those, so it gives up rather than growing
without bound.

### 6.4 The duel teaches, the arrows arrange

`NUDGE_WEIGHT_MUL` is 0.05 — an effective weight of 0.13, lighter than a skip.
The value was measured rather than picked. Walking one title up the list a press
at a time:

| `NUDGE_WEIGHT_MUL` | resulting ladder |
|---|---|
| 0.35 | 7→6, 6→3, 3→2, 2→1 |
| 0.12 | 7→6, 6→2, 2→1 |
| **0.05** | **7→6, 6→5, 5→4, 4→3, 3→2** |

At higher weights a press moved the row several places, because what it *taught*
reordered the rows around it as well. An adjacent pair is similar by
construction and carries far less information than two magazines drawn from
opposite ends of the newsstand, so weighting it down is principled as well as
convenient: the duel is the learning mechanism, the arrows are for tidying the
order.

Note that 0 is not the best value either — with no learning at all the ladder
reads 7→6, 6→3, 3→1, because the `diversity` term is assigned during selection
and reshuffles neighbours as positions change. Some learning damps that.

### 6.5 Verification

- an upvote from #7 lands at #6, and four successive presses give 6, 5, 4, 3;
- the top row cannot be upvoted and the list is unchanged when tried;
- the vote tally on the card reads +4 after four presses;
- all five views render, and the v4 block and duel-cadence tests still pass.

## 7. v6 — a quarter of every refresh was spent on cache hits

Reported as a display oddity: *"whenever I press refresh, it starts from 36
somehow."* The counter was telling the truth. Thirty-five of ninety planned
reads completed before the first frame could paint, because they never touched
the network.

### 7.1 What was happening

`fetchPage` returns immediately when the URL is in `state.cache` and the entry is
younger than the TTL it was called with. `planFetches` did not know that, so it
spent budget slots on leads whose pages it was certain to get back from cache.
Those slots resolved in microseconds, `pooled` raced its counter up, and the
progress text only became readable on reaching the first lead that needed a real
fetch.

The `hot` bucket was the main culprit and the check it was missing is simply
absent, not wrong:

```js
if (rec && recommended.has(rec.id)) { hot.push({ lead, ageCycles, rec }); continue; }
```

No age test at all. Every currently-recommended title was planned on every
refresh — `hotN` is `ceil(budget * 0.25)`, so 23 slots of 90 — and since they had
just been read, all 23 came straight back out of cache. Weeklies and
fortnightlies in the `stale` bucket did the same thing for a subtler reason:
staleness is measured in publication cycles (`ageCycles >= 0.8`, about 5.6 days
for a weekly) while `TTL.detail` is a flat 18 days, so a weekly could be
correctly judged stale and still be served from cache.

### 7.2 Why it mattered more than the counter

The budget is defined in §1.4 as page reads *where a read changes the answer*. A
read served from cache changes nothing by definition — it cannot discover a new
issue, a new price, or a withdrawal. Those thirty-five slots were not slow, they
were inert, and every one of them was a slot that never reached an unread title.
Unread titles are the only thing that grows coverage, and coverage was the
standing complaint behind §4.7.

### 7.3 The fix

`servedFromCache(url, ttl)` predicts what `fetchPage` will do, and `planFetches`
skips those leads before spending a slot rather than discovering it afterwards.
The TTL used in the prediction must match the one the connector will pass
(`stub.hot ? TTL.detailHot : TTL.detail`) or it predicts the wrong thing.

Measured on a synthetic 200-lead corpus — 40 already read and still cached, 25 of
them currently recommended, 160 never read, budget 90:

| | before | after |
|---|---|---|
| slots spent on cache hits | 25 | **0** |
| slots reaching unread titles | 67 | **90** |

A 34% increase in real coverage per refresh, with no additional fetching.

The count is reported rather than hidden: the refresh log appends "*N* already
current, not re-read", and the cycle summary carries a "Skipped as already
current" row explaining that the budget went to unread titles instead. A number
that silently improved would be as opaque as the one that silently leaked.

### 7.4 Note on the counter itself

It will still not count smoothly. `pooled` runs `CONCURRENCY` (12) workers and
each calls `setProgress` with its own sequence number, so the displayed figure is
whichever worker reported last and jumps around within a window of twelve. That
is inherent to reading twelve pages at once and is not worth serialising to fix.
What it will no longer do is begin at thirty-six.
