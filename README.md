# Famicase Archive

Archives artwork and metadata from [My Famicase Exhibition](https://famicase.com) —
an annual show where creators design NES-cartridge labels for imaginary games.

Bun + TypeScript. One runtime dependency: [sharp](https://sharp.pixelplumbing.com),
for AVIF encoding.

## Usage

```bash
bun install                                      # sharp, plus dev types

bun run famicase-archive.ts 26                   # archive 2026
bun run famicase-archive.ts 15 24 25 26          # several years
bun run famicase-archive.ts 26 --dry-run         # print planned filenames only
bun run famicase-archive.ts 26 --embed           # + write XMP/IPTC into the JPEGs
bun run famicase-archive.ts 26 --plain-names     # bare NNN.jpg instead of titled names
bun run famicase-archive.ts 26 --translate       # + translate the non-English entries
bun run famicase-archive.ts 26 --translate-only  # translate what is already on disk
bun run famicase-archive.ts 26 --html-only       # rebuild index.html only, no network
bun run famicase-archive.ts 26 --no-avif         # skip AVIF; the page loads the JPEGs
bun run famicase-archive.ts 26 --avif-only       # convert a year already on disk, no network
bun run famicase-archive.ts --master             # rebuild the master page across all years

bun run typecheck                                # tsc --noEmit, strict
```

Years are the site's own two-digit directory names (`/26/`, `/15/`, …).

Reruns are cheap and safe: files already on disk with a matching SHA-256 are
skipped, so an interrupted run resumes where it stopped.

## Progress output

A run draws a live progress bar naming the asset currently in flight:

```
  ███████░░░░░░░░░░░░░░░  30%   75/250  2.7 MB · 72 cached · eta 28s
```

It reports how far along it is, bytes actually pulled over the network (so a
resumed run honestly shows how little it transferred), how many files were
already cached, and a running ETA that becomes total elapsed time on completion.
Failures print above the bar rather than corrupting it.

The asset name is truncated to the terminal's *display* width rather than its
character count, because Japanese and Korean titles occupy two columns per
character and would otherwise overflow and wrap.

When stdout is not a TTY — piped to a file, or running in CI — the bar is
replaced by a plain line every 10%, so logs stay readable and free of escape
codes. The cursor is restored on exit and on Ctrl-C.

`--embed` requires `exiftool` (`brew install exiftool`). Without it the step is
skipped with a notice — the sidecar JSON is written either way, so the archive is
never left incomplete.

## Output

```
archive/
├── index.html                                # master page: every game, every year
└── 26/
    ├── 001 - Murder In The Office.jpg        # 1230×810, byte-identical to the server
    ├── 001 - Murder In The Office.avif       # derived: what the page actually loads
    ├── 001 - Murder In The Office.json       # sidecar metadata
    ├── 001 - Murder In The Office_logo.gif   # 130×130 publisher logo
    ├── 001 - Murder In The Office_logo.avif  # derived
    ├── ...
    ├── index.json                            # every record in one array
    ├── _manifest.json                        # run log: URLs, SHA-256, sizes, failures
    └── index.html                            # browsable contact sheet for the year
```

## The page

Every archived year gets a self-contained `index.html` beside its images: a
four-column grid of covers with just the title beneath each one. Plain white
ground, no borders or chrome, so the cover art carries the page. It drops to
three, two, and one column as the viewport narrows.

The creator credit and description stay out of the way until you want them: on
hover or keyboard focus, the whole tile — artwork included — becomes a white card
that lifts on a soft shadow and overlaps its neighbors. No rounded corners.

The grid has no gap at all: each card's own padding is the gutter, so tiles sit
flush and the only whitespace is the breathing room inside a card. That also
means the card carries its padding at all times and merely paints a background
and shadow on hover, so the geometry never changes and the artwork cannot shift
as the card opens.

Each tile is an absolutely-positioned card floating over a placeholder that
reserves the artwork box (via `aspect-ratio` taken from the image's own recorded
dimensions) plus one line of title, so revealing the details never reflows the
grid. The title is clamped to that one line: 242 of 2026's 250 titles fit, and
the 8 that don't ellipsize and show in full on hover. Raising
`figure::after{height}` and `-webkit-line-clamp` together makes room for two
lines again if a future year runs longer.

Touch devices have no hover, so under `@media (hover:none)` the details lay out
inline instead. Every tile is focusable, so the same information is reachable by
keyboard.

Clicking a tile toggles a highlight: the card inverts to black ground with white
text, the muted greys lifted so the credit and description stay readable. It is
for marking favorites as you scroll a year; the marks are deliberately not
persisted, so a reload clears them. One delegated listener on the grid handles
every tile, and Enter or Space does the same thing from the keyboard. The rules
sit last in the stylesheet and are repeated for `:hover`, so a highlight survives
both the hover fill and the touch-mode reset.

Open it straight off disk (`open archive/26/index.html`) or serve the folder.
Images are referenced by relative filename, percent-encoded for the spaces and
non-ASCII characters in the titles, and carry intrinsic `width`/`height` plus
`loading="lazy"` so 250 covers stream in without layout shift.

## The master page

`archive/index.html` lists every game from every archived year in one grid,
styled like the year pages and built from the same tile renderer. It is rewritten
after any run, or on its own with `--master` (no years needed) — it reads each
year's `index.json` and never touches the network.

Four additions on top of a year page. The credit line leads with the year, so a
tile always says where it came from. A **Shuffle** button reorders the grid,
which is the point of the page: 250-plus covers in exhibition order are a list,
but in random order they are a source of inspiration. And the shuffle is seeded —
the seed lands in the URL as `#seed=abc123`, so a shuffle you like is a link you
can bookmark or send, and opening it reproduces that exact order. The seed box
accepts any string (`#seed=inspo` works), and **Reset** clears it back to
exhibition order.

The click-to-highlight from a year page works here too, but with a memory: the
master page is the one you come back to, so a marked tile is a favorite that
persists. Marks are stored in `localStorage` under `famicase-favorites` as a list
of short keys — the year's last two digits plus the id with leading zeros
stripped (2026 id `008` is `268`) — keyed by record rather than position, so
copy/pasting the export list stays manageable and marks survive a
shuffle, a reordered grid, and a rebuild that adds a new year. A **Favorites**
button filters the grid down to the marked tiles and carries the count; it is
disabled until something is marked. Filtering hides the unmarked tiles with CSS
rather than removing them, so the shuffle order and the marks themselves are
untouched, and the year rail steps aside while the filter is on, as it does when
shuffled.

An **Import/export favorites** button doubles as both: it opens a
`window.prompt` pre-filled with the current list, so copying it out is just a
confirm. Pasting in a different list and confirming replaces the marks with
whatever keys are in it; confirming the list unchanged, or cancelling, leaves
favorites untouched. The list is comma-separated rather than one key per line,
since `prompt()` collapses a multi-line default value onto a single line in
most browsers anyway.

Reordering uses CSS `order` on the grid items rather than moving nodes, so
nothing reloads and no image is re-fetched when you shuffle. The permutation is a
Fisher-Yates shuffle over a mulberry32 PRNG keyed by an FNV-1a hash of the seed
string — a few lines of arithmetic, and identical in every browser.

`--html-only` regenerates the page from an existing `index.json` without touching
the network, which is the fast path when you are just changing the layout.

Each sidecar carries the year, id, title, creator, occupation, country, the raw
credit string, the description, per-asset URL/size/SHA-256, the source page URL,
and a retrieval timestamp — plus an `en` block once the entry has been
translated. Record types are exported from `famicase-archive.ts` (`GameRecord`,
`AssetInfo`, `Credit`, `Translation`) for anything that consumes the archive.

## Translation

Roughly a third of any given year is written in Japanese — 83 of 2026's 250
entries — and the descriptions are the good part: one-paragraph pitches for games
that do not exist, most of them jokes. `--translate` renders the foreign
`title`, `occupation` and `description` into English and stores the result on the
record as an `en` block. The original is never overwritten.

Japanese is nearly all of it, but not all: a few entries each year arrive in
Korean, and Cyrillic, Greek, Arabic, Hebrew, Thai and Devanagari are recognized
too. The two scripts are tested differently on purpose. Any single CJK character
marks a field as Japanese, because a Japanese title can be mostly Latin. For
every other script the foreign characters must be at least half the field's
letters, because those scripts nearly always turn up as one glossed word inside
English prose — `Σειρήν (sirène) is a music game` wants no translating, while a
Korean title standing alone does. Latin-1 and Latin Extended never count as
foreign, so `Relámpago` and `Á BIENTÔT` are left as the English they are.

It shells out to the [Claude CLI](https://claude.com/claude-code) in headless
mode (`claude -p`), which means it bills to whatever subscription that CLI is
already logged in with rather than to an API key, and there is no key to keep in
the repo. That is also the one prerequisite: `claude` on `PATH` and logged in. If
it is missing the step is skipped with a notice, exactly like `--embed` without
exiftool.

Machine translation is a poor fit for this material — the blurbs run on puns and
onomatopoeia, which is precisely what a phrase-matching translator flattens — so
the prompt asks for the joke to land in English rather than for a literal
rendering, and forbids padding or explaining. Entries are sent about twenty at a
time as JSON and come back as JSON; a reply is only trusted for ids that were
actually sent.

Nothing is translated twice. Each `en` block records a SHA-256 of the exact
source text that produced it, so a rerun re-translates only entries whose
source text has actually changed, and a second `--translate` run costs nothing.
`creator` is deliberately left alone — names are not for machines to romanize —
and `country` is already English.

`--translate-only` does the same work against a year already on disk, with no
scraping, which is the fast loop when you are iterating on wording. Translation
never fails a run: the artwork is the point of the archive, so a batch that
errors is retried once, reported, and then left untranslated.

Translating draws the same progress bar as a download, with the byte counters
replaced by the call in flight:

```
  ██████████░░░░░░░░░░░░  45%  31/68  call 2/4 · retry · 3s · eta 6s  検索窓 +19
```

A batch is one opaque `claude -p` call that can run for a minute with nothing to
report, so the bar repaints on a timer rather than only on completion — a clock
that stops moving reads as a hang. The name is the batch's first title and how
many others are in flight with it, `retry` appears while a failed batch is on its
second attempt, and failures print above the bar rather than through it.

Which language the page shows is a per-reader choice. Both versions ship in the
markup and a toggle in the header swaps between them, remembering the choice in
`localStorage`. Only the fields that actually have a translation are swapped, so
an entry that was written in English to begin with never blanks out; the button
appears only on pages that have something to toggle. Each version carries its own
`lang` attribute, which is what lets a screen reader — and the browser's own
translate feature — tell the two apart.



## Design notes

**No browser automation.** Every page is static server-rendered HTML — the
lightbox on the index just iframes the same detail URL the link already points
at. Plain `fetch` is enough; Playwright would add nothing.

**Parsing uses `HTMLRewriter`**, Bun's native streaming parser. Two caveats it
imposes, both handled: it delivers text in arbitrary chunks (so element text is
buffered until the end tag, via `firstTextCollector`), and it does **not** decode
HTML entities (so `decodeEntities` resolves named and numeric refs, matching what
Python's `HTMLParser` did automatically).

**The images are already full resolution.** `NNN.jpg` is the 1230×810 original
with its Photoshop EXIF intact; the page merely displays it at 615×405. There is
no larger variant. The download is stored as the exact bytes the server sent — no
transcoding, no re-encoding, original JPEG format preserved.

**AVIF is a delivery copy, never a replacement.** The site serves near-lossless
4:4:4 JPEGs, around 700 KB for one label, which is right for an archival master
and hopeless for a grid of 250 of them. Each download therefore gets an `.avif`
sibling and the page loads that instead: 1.4 GB of originals becomes 149 MB, and
2026 alone drops from 238 MB to 19 MB. The originals stay on disk untouched, and
the page uses `<picture>` with the JPEG as the `<img>` fallback, so nothing is
lost if AVIF is unavailable — or unreadable in twenty years.

Settings, arrived at by comparing crops against the originals:

| | quality | why |
| --- | --- | --- |
| cover art | 65 | ~7% of the original, no visible difference at 1:1 |
| logos | 80 | small flat graphics with hard edges, where ringing shows first |

Chroma stays at 4:4:4 rather than subsampled: the artwork is full of thin
saturated outlines and small coloured type, exactly what 4:2:0 smears, and on
this material it costs only about 7% more bytes. `effort` is 3 — above that the
trade goes bad here, with effort 4 running roughly 3× slower for well under 1%
smaller output.

Conversion is keyed off the same SHA-256 that skips the download, so a re-run
reuses every sibling already on disk (5,538 assets re-checked in 0.15 s) and a
missing one is rebuilt on the spot. A handful of the smallest GIF logos are
already near-optimal as palette images and re-encode *larger*; those are dropped
rather than kept, and the page falls back to the original for them. All 2,769
cover images convert; 197 logos are skipped this way, and logos are not rendered
on the page anyway.

`--avif-only` is the backfill and re-encode path: it converts a year already on
disk, rewrites `index.json`, the sidecars and the page, and touches neither the
network nor `_manifest.json` (that file is a log of a scrape run). The full
archive — 12 years, 5,538 assets — converts in about a minute on 14 cores.

**The deploy ships the AVIF, not the masters.** The archive directory holds both
formats and so grew to 1.5 GB, but `make deploy` excludes `*.jpg`: every cover
image has an AVIF sibling, so the JPEGs are 1.36 GB — 88% of the tree — that no
browser ever requests. 210 MB goes up instead of 1.5 GB.

Two rsync details make that work. `--delete` on its own does **not** remove files
an `--exclude` covers, so `--delete-excluded` comes along too; without it the
JPEGs from earlier deploys would sit on the server forever, and with it the first
run reclaims the 1.36 GB. And rsync's built-in `--skip-compress` list predates
AVIF (it has `jpg`/`png`/`webp` but not `avif`), so `-z` would spend CPU
re-deflating already-compressed frames — the list is restated with `avif` added,
which leaves `-z` doing what it is good for here, the JSON and HTML. Naming a
list replaces the built-in one rather than extending it, hence the full restatement.
`--skip-compress` is rsync 3 only, so it sits in the branch that already handles
Apple's openrsync.

The tradeoff: the `<picture>` fallback points at the JPEG, so a browser without
AVIF (Safari before 16.4, roughly 5% of traffic) gets no image from the deployed
site. `make deploy DEPLOY_MASTERS=yes` ships the originals too if that matters.
The masters are always kept locally either way — serving AVIF *instead of*
archiving the JPEGs would be the wrong trade for this project.

**Parse, never construct.** The markup is not stable across years: 2015 uses
`softs/01.html` pointing at `1.jpg`, 2026 uses `softs/001.html` → `001.jpg`.
Entry URLs come from the index and image URLs are read from each page's
`<img src>` and resolved against the page URL, so new years work without special
cases.

**Credit separators vary.** 2026 mostly uses a fullwidth `｜`, but six entries mix
in an ASCII `|`, and 2015-era pages use ` / ` with no country field. All three are
handled, and `credit_raw` always preserves the original string.

**Filenames** are `NNN - Title.ext`. The numeric prefix (zero-padded to a uniform
width per year, since 2015 mixes `01` and `100`) preserves exhibition order and
prevents collisions. Titles keep their spaces, capitalization, and Japanese/Korean
characters; only the characters that are illegal or hazardous in a path
(`/ \ : * ? " < > |`) are replaced with `-`, so the tree stays safe to zip, sync,
or copy to an external drive. Truncation respects UTF-8 *byte* length (255) while
trimming by code point, so a multi-byte character is never split. The untouched
title always remains in the sidecar JSON.

**Politeness.** 4 concurrent workers behind a global inter-request delay, a
descriptive User-Agent, and retry with exponential backoff. `robots.txt` returns
404, so nothing is disallowed, but this is a small exhibition site on shared
hosting.

## Provenance and rights

Artwork is the copyright of its individual creators; this archive is for personal
and research use. Every file's source URL and retrieval timestamp are recorded in
its sidecar and in `_manifest.json`, so attribution stays attached to the images.
