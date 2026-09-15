# MagLens

Answers one question, once a month: **which magazine should I buy this month?**

Not from a built-in catalogue — there isn't one. Every title, issue, cover price
and cover image in this app was read off a live publisher or newsstand page
during a refresh, and every reading carries the URL it came from and the
timestamp it was taken at. A magazine that was perfect in August may be
unavailable, dearer, repetitive or simply carrying a dull issue in September,
and only a fresh read can tell you which.

**It starts knowing nothing about you.** No seeded topics, no assumed interests,
no demographic guess, no starter recommendations. The first list is ranked for
*breadth* rather than fit, and it says so. Everything the app later believes
about your taste is derived from what you actually did, is shown to you with the
evidence behind it, and can be corrected or deleted.

**It learns by asking you to choose.** Two magazines at a time, drawn from
opposite ends of the newsstand: *which of these would you rather read?* Only what
makes the two different is recorded, so anything they share is ignored. It asks
often at the start and progressively less as the model firms up, collapsing to a
single line you can take up whenever you feel like it. Every card in the ranked
list also carries up and down arrows, and pressing one re-ranks the list on the
spot.

Static: `index.html` + `styles.css` + `app.js`. No build step, no dependencies,
no backend, no accounts, nothing paid.

MagLens is one page: a ranked list of every magazine that clears your filters,
and a duel at the top that teaches it what you like. The inspection views that
grew around it — Browse, Research, History, Taste — were removed in v10; what is
worth seeing is on the card or behind Details.

## Run it

```sh
python -m http.server 8731
```

Then open <http://localhost:8731>. It works from `file://` too, but a real
origin behaves better with the fetch layer.

First run: five short questions (budget, print/digital, news, audience,
language — nothing about your interests), then **Discover magazines**. Expect a
couple of minutes: it reads the India newsstand index, then reads roughly 90
individual issue pages at about one a second.

## Where the magazines come from

**10,406 titles currently on sale in India**, enumerated from Magzter's India
store sitemap — the `/IN/` path segment is the store's own marker for "sells in
India", so the sitemap doubles as an availability filter. Each title's page then
yields the current issue label, its cover, the issue's own description, the
table of contents with per-article reading times, the declared frequency and
language, the publisher, and the recent-issue list.

| connector | entry point | role |
| --- | --- | --- |
| Magzter (India store) | `sitemapxml/magazines_1.xml` | title enumeration + per-issue reading |
| Readwhere | `sitemap/titles/magazine/sitemap.xml` | titles and regional languages; its issue pages are client-rendered and cannot be read |
| Web search | DuckDuckGo HTML endpoint | open-ended discovery — reaches print-only titles and anything launched since a sitemap was regenerated |
| Publisher sites | discovered URLs | primary source; the only place a print cover price is usually printed |

A browser cannot fetch magzter.com or amazon.in directly — neither sends
`Access-Control-Allow-Origin` — so a static page has two options: a proxy, or no
live data. Pages are read through `r.jina.ai`, which returns extracted text
rather than raw markup, with `allorigins` and `codetabs` behind it. Hosts that
*do* send the header are read directly, which matters for more than speed: a
direct fetch originates in India, so its prices are the ones actually on offer
here.

**Currency is not faked.** A proxied read lands wherever the proxy lives, and
Magzter's page carries a flag telling you which store answered. When that is not
the India store, the price is shown in the currency it was read in and labelled
*"read from the US store — the India price will differ"*, rather than being
silently converted into a rupee figure nobody is being offered.

### The fetch budget is the design

A read that would be served from the local cache is never given a budget slot:
it cannot discover a new issue, a new price or a withdrawal, so it does not
change the answer and the slot goes to an unread title instead. Skipping them
lifted real coverage per refresh by about a third.


Enumerating what exists is one cheap request. Reading what is *in* a given issue
is one request per title, and there are ten thousand titles. So a refresh spends
a fixed budget (90 page reads by default) where a read changes the answer:

- **verify** — titles currently being recommended
- **stale** — readings older than the magazine's own publication cycle (a
  four-week-old reading of a weekly is four issues out of date; the same reading
  of a quarterly is current)
- **breadth** — never-read titles, round-robined across every shelf and ordered
  by sitemap position, which tracks how long-established a title is

Coverage therefore grows month over month, and Research → Coverage says exactly
how far it has got.

## Reading what a magazine actually says

Topics used to come from cover lines and a shelf category — what an issue
advertises about itself. MagLens now reads one real article per issue: the
opening paragraphs before the paywall, plus the “more from this issue” block that
carries about ten sibling articles with their standfirsts. One request buys the
prose of one piece and a summary of ten more.

It matters. On a live India Today issue, cover lines alone made it look like an
art-and-food magazine (art 11%, food 10%); one article read moved it to finance
16%, politics 7%, economy 6% — and surfaced economy, finance and manufacturing,
which were invisible before.

## Understanding an issue, not a category

The shelf label says "Automotive" every month. The cover lines say that *this*
month it is Audi's product offensive, a Range Rover Sport EV at Goodwood and a
19,351km drive from Pune to Prague. Only the second can tell you whether this is
the month to buy it.

Topics come from two passes. An ontology of ~65 subjects names the things that
recur across a newsstand so they are recognised identically every time, with
word-boundary matching so `art` does not fire on `start`. Then a mining pass
over cover lines picks up whatever the ontology has no word for, kept only
within a corpus frequency band — below it a phrase describes one magazine and
cannot generalise, above it it describes the whole newsstand and cannot
discriminate. The mining is script-agnostic, so a Hindi monthly indexes under
`कृष्ण` and `जन्माष्टमी` as readily as an English one indexes under `cars`.

Four characteristics are derived alongside the topics:

- **news-heaviness** — its own dimension, because "a magazine, but not more
  news" is a real and common filter
- **visual vs textual** — mostly from reading time per piece, which is the
  strongest structural signal there is: a magazine of two-minute pieces is one
  you look at, a magazine of fifteen-minute pieces is one you sit down with.
  Where no reading times exist the estimate stays near the middle and is flagged
- **reading difficulty** — word and sentence length, academic tells, piece length
- **audience** — child / adult / both. Cues here describe who the magazine is
  *for*, never what it is *about*: an early version listed bare "children" and
  classified *Down To Earth*, an environment fortnightly, as a children's
  magazine because that issue ran a piece on child nutrition

## "Is this really the current issue?"

The hardest requirement, because every retailer page looks equally confident
about a dead title and a live one. The app does not decide — it scores, and
shows its working:

- what the page claims, and how precisely (a full cover date beats a bare month
  beats "Issue 47", which cannot be checked for freshness at all)
- whether that date sits where the magazine's own cadence says it should, with
  the penalty proportional to how many issues behind it is
- whether the source lists a *newer* issue than the one it presents as current —
  the signature of a cached page
- whether a second source agrees
- how old the reading itself is, measured in the magazine's cycles

Result: **verified / likely / uncertain / unknown**, with a percentage and the
reasons, on the card and in full in the detail sheet. Titles below your
confidence floor are excluded rather than guessed at, and the exclusion is
listed in Research with its reason.

Cadence is checked, not believed: the declared "Monthly" is compared against the
median gap between issues actually listed, and a disagreement lowers confidence
and appears as a conflict.

## Filters vs tastes

**Filters are hard constraints and are yours alone.** The learning model can
never write to them, and nothing it believes can override them. Failing a filter
removes a candidate; it does not quietly sink it down a ranking for a reason
nobody can see.

Price ceiling · print/digital · language · frequency · topics wanted · topics
excluded · news in/out · audience · visual content · reading difficulty ·
availability in India · publication type · recently-bought cool-off ·
recently-read-subject cool-off · overlapping-subject tolerance · minimum
current-issue confidence.

Every option list is built from what has actually been discovered. There is no
fixed menu of subjects, because a fixed menu would define what the app thinks
magazines are about before it had read one.

Four defaults worth knowing. **Magazines only**: much of what the newsstand
sitemaps list is academic journals, coursebooks and daily newspapers — all
genuinely on sale, none of them what this question is about. **English only**,
because a magazine you cannot read is not a recommendation; a companion setting
decides what to do with titles whose language could not be established at all.
**No pornography or erotica**, judged from the shelf a title is filed on, its
name and its issue text — a separate question from *Audience*, which only says
whether a magazine is written for adults, as a defence quarterly also is. And a
magazine whose **price could not be read is never hidden** by the price ceiling;
it is flagged on the card instead, because dropping it would silently hide every
print title whose publisher does not put a number on the page.

## What it learns, and how you correct it

### The comparison

The main way it learns. Two magazines, one question, no scale to interpret and
nothing to type — and both of them real, on sale now, and past the same
availability and freshness bars as anything else it would recommend.

The whole trick is that **everything the two share cancels**. If both are English
monthlies, your answer says nothing whatever about English or about monthlies and
nothing is recorded against them. Only the dimensions on which they actually
differ move. That is why one answer can separate a dozen things at once, and why
a near-universal value like *English* can never accumulate spurious evidence — it
sits on both sides of almost every pair.

Pairs are drawn deliberately **across** the newsstand rather than within a shelf,
and with a large random element. A choice between two cookery monthlies teaches
almost nothing; a cookery monthly against a car magazine separates a dozen
dimensions at once.

### Blocking

**Block** is on every surface that shows a magazine — the ranked card, the
comparison, the detail view and the Research table — and reads its own state, so
a blocked title offers *Unblock* instead.

**Block** removes a title from the app for good — out of the ranking, out of
Browse, and out of either side of a comparison. It is the one control that
teaches the taste model *nothing*, deliberately: people block because they
already subscribe, or because it is not sold near them, and a block that quietly
trained against the subject would punish a whole shelf for a fact about one
magazine. Downvote as well if you also dislike it.

Because blocking is usually a filter that missed, the cause is noted from what
is already known about the title — no language established, another language,
adult material — and when one keeps recurring the filter deck offers the setting
that would have caught them, in one click.

Blocking is one click with an undo in the toast; the full list, with per-title
unblock, is in the filter deck. It survives *Reset filters*, because resetting
your price ceiling should not silently unblock a dozen titles.

### Voting

Every card carries ▲ and ▼, and they move a title **one place**, not to the top.
An arrow beside a ranked row means "this one beats the one above it", so that is
exactly what it records: a comparison between the two adjacent rows, the same
event the duel produces. Press again and it is compared with its new neighbour
and walks up another step.

A vote does two things. It **teaches** — gently, since two adjacent titles are
alike and the comparison says correspondingly little — and it **asserts** a
position, stored as a visible, resettable adjustment. Both are needed: teaching
alone once moved a row the *wrong way*, because upvoting a finance magazine
taught "finance" and lifted the finance title already above it.

The duel teaches; the arrows arrange.

### Everything else

Purchases and explicit ratings dominate; a skip is worth a fifth of a like,
because skipping is one flick of a thumb over a card that was barely read.

One thing is deliberately **not** learned from: simply being shown a magazine.
It is kept in History so you can see what was put in front of you, but training
on it means learning from the recommender's own output — it showed a spiritual
monthly, concluded you were drawn to spirituality, and showed it again. That is
the preference bubble, arriving one render at a time.

A **stated reason** beats a passive inference. "Too text-heavy" is a direct
instruction about one dimension and is applied as one, at triple weight, rather
than being inferred back out of everything else on the card.

The **Taste** view lists every belief, the evidence behind it — which magazine,
which action, when, what proportion of that issue the subject was — and controls
to mute it, assert the opposite, or delete the evidence outright. The model is
always rebuilt from the event log rather than updated in place, so a correction
produces exactly the model that would have existed had things gone that way.

### Facet damping

A value carried by four magazines in five says nothing about anyone's taste,
however much evidence piles up behind it — and it piles up on exactly those
values fastest, because they are on everything you are ever shown. A reader
taught with four purchases and three explicit "too text-heavy" rejections to
want highly visual easy reading was handed a text-heavy business monthly: the
two scalar terms were correctly at −1 each and were outvoted by *likes Monthly*,
*likes English* and *likes adult*, which between them described 80% of the
newsstand. Facet utilities are now damped by how discriminating the value
actually is across the corpus.

### Progression

The app learns whether you prefer familiar ground, one subject over, or long
jumps — measured as the distance each accepted pick sat from your taste **at the
moment it was offered**, snapshotted before the event was applied. Nothing here
knows that cars come after motorcycles. If distant picks keep landing well the
stride widens on its own; if they keep being rejected it narrows. Rejections
count as much as acceptances, because a model watching only acceptances reads a
cautious reader as adventurous.

## Ranking

Thirteen components, each in [0,1], each stored on the candidate and rendered
term by term in Research → Scores with its weight in the column header. A
surprising ranking is traceable to the term responsible in one click.

`availability · freshness · prefFit · appeal · novelty · progression · valueFit ·
exploration · nudge` — minus `diversity · repetition · recentTitle · ownedIssue`.

The preference term is stretched about its neutral point in proportion to how
much the model knows, so an informed dislike can sink an otherwise excellent
magazine while an uninformed one cannot.

`nudge` is the position you set by hand with the arrows, in score units, and can
be reset in the filter deck without un-teaching what the votes taught.

`novelty` and `exploration` are **cold-start** terms and fade as the model
matures. Both reward unfamiliarity, which a magazine that fits you lacks by
definition — left at full weight they handed an unrelated title a head start over
a perfect match, and a title scoring 100% on preference fit could finish below
seven titles the model knew nothing about. Neither applies at all to a title you
have voted on: you have judged it, so it is not unknown territory.

Every magazine in the list shows a **match percentage**. That is the preference
term alone, not the total — the total mixes in availability and freshness, which
are facts about the shop rather than about you, and a number labelled *match* has
to mean what it says. With an empty model every card reads 50%.

Every title that clears your filters is ranked and shown — there is no page
size and no "show more". The list builds itself in the background: the first
screenful lands immediately and the rest follows across animation frames.

Selection is separate from scoring: the second pick is not the second-best
magazine, it is the best magazine *given* the first. That comparison runs for the
top 120, which is where variety is a real question; below that, titles are
ordered on their own score and say so. Overlap costs nothing below
your tolerance and rises steeply above it, so two genuinely different magazines
are never punished for sharing a subject while two interchangeable ones are.
Publisher repetition is penalised too — the same house three times reads as a rut
even when the subjects differ.

Two overlap questions are kept apart. *The same magazine listed twice* is a data
problem and goes to Research → Duplicates for merging. *Two different magazines
about the same subject* is a diversity decision and is handled above.

## Exploration

Off at zero, 15% of months by default, scaled by learned appetite. An
exploratory pick clears the same hard filters and the same availability,
freshness and quality bars as anything else — it is a real suggestion, not a
wildcard — and it is **labelled as exploratory** rather than dressed up as an
obvious match. It never takes the primary slot: the headline answer should be
the app's best judgement, not its most interesting gamble.

## Degrading honestly

Uncertainty is shown, never smoothed over. No cover and a cover that failed to
load are different boxes with different captions. A retired listing that
redirects to the newsstand front page is detected and stripped of the cover it
picked up there, because a cover from the wrong title is the most convincing lie
this app could tell. A subscription-only price is divided out and labelled as
derived. Every source's reading, route, store region and complaint is listed in
the detail sheet. When every live route fails, a stale cache entry is returned
and marked stale rather than discarded.

## Monthly refresh

Recomputed from whatever is currently known, every month. There is no stored
schedule to repeat — a schedule made in August cannot know that September's
issue is a rerun or that the title has gone out of print. A new calendar month
triggers a refresh on load whatever the cache says, because the issue on the
shelf has changed even if nothing else has.

## Data

IndexedDB, in this browser only. Nothing is sent anywhere except the page
fetches themselves. Export and import are in Settings. The discovery cache is
the only thing ever evicted — records and events never are, because a magazine
dropped today may be exactly right once the taste model has moved.

If IndexedDB is unavailable the app runs in memory and the header says so,
rather than losing a session's ratings silently.

## Architecture

`app.js` is one file, sectioned in dependency order:

```
util → state → persistence → net → connectors → normalising → records →
issue identification → duplicates → content understanding → filters →
preference learning → ranking → discovery → ui → boot
```

Everything that knows what a particular retailer's page looks like lives in
**connectors** and nowhere else. Each turns one page into an *observation* — a
source's claim about a magazine at a moment in time — and every layer above
merges observations without knowing where they came from. Observations are kept
whole and forever; the merged record is a view over them, not a replacement, so
two sources disagreeing lowers confidence instead of one silently overwriting
the other. When a site redesigns, only its connector changes.
