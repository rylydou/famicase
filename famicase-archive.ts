#!/usr/bin/env bun
/**
 * Archive My Famicase Exhibition (https://famicase.com) artwork and metadata.
 *
 * Downloads the full-resolution cartridge art for every entry in a given year,
 * alongside per-game sidecar JSON metadata.
 *
 *   bun run famicase-archive.ts 26
 *   bun run famicase-archive.ts 15 24 25 26
 *   bun run famicase-archive.ts 26 --dry-run
 *   bun run famicase-archive.ts 26 --embed
 *   bun run famicase-archive.ts 26 --no-avif
 *   bun run famicase-archive.ts 26 --avif-only
 */

import { parseArgs } from "node:util";
import { $ } from "bun";
import sharp from "sharp";

const BASE = "https://famicase.com";
const USER_AGENT =
  "famicase-archive/1.0 (personal archival script; " +
  "contact: rylydou@gmail.com)";

const ARCHIVE = new URL("./archive/", import.meta.url).pathname;

const MAX_WORKERS = 4;
const REQUEST_DELAY_MS = 150; // global floor between requests
const NAME_MAX_BYTES = 255;
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface AssetInfo {
  file: string;
  url: string;
  bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  skipped?: boolean;
  /** The AVIF rendition beside it, when one was written. */
  avif?: AvifInfo;
}

/**
 * A derived AVIF sibling. The original download always stays on disk as the
 * archival master, so this is a delivery copy and carries no hash: the source
 * `sha256` already decides when it has to be rebuilt.
 */
export interface AvifInfo {
  file: string;
  bytes: number;
}

export interface Credit {
  creator: string | null;
  occupation: string | null;
  country: string | null;
  credit_raw: string | null;
}

/**
 * An English rendering of a record's non-English fields. `src_hash` covers the
 * exact source text that produced it, so a later run can tell a stale
 * translation from a current one without re-reading the site.
 */
export interface Translation {
  title?: string | null;
  occupation?: string | null;
  description?: string | null;
  src_hash: string;
  engine: string;
  translated_at: string;
}

export interface GameRecord extends Credit {
  year: number;
  id: string;
  title: string | null;
  description: string | null;
  image?: AssetInfo;
  logo?: AssetInfo;
  source_url: string;
  retrieved_at: string;
  // Present only for entries that carry foreign text; the original always stays.
  en?: Translation;
}

export interface Options {
  embed: boolean;
  dryRun: boolean;
  plainNames: boolean;
  translate: boolean;
  avif: boolean;
}

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

let gate: Promise<void> = Promise.resolve();
let lastRequest = 0;

/** Serialize a global minimum delay between outbound requests. */
function throttle(): Promise<void> {
  const turn = gate.then(async () => {
    const gap = performance.now() - lastRequest;
    if (gap < REQUEST_DELAY_MS) await Bun.sleep(REQUEST_DELAY_MS - gap);
    lastRequest = performance.now();
  });
  gate = turn.catch(() => {});
  return turn;
}

/** GET a URL politely, retrying transient failures with exponential backoff. */
export async function fetchBytes(url: string, retries = 3): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) throw new Error(`404 Not Found: ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("404")) throw err;
      lastErr = err; // transient socket/TLS drops, seen under concurrency
    }
    if (attempt < retries - 1) await Bun.sleep(2 ** attempt * 1000);
  }
  throw new Error(`failed after ${retries} attempts: ${url} (${lastErr})`);
}

/**
 * Pre-2013 pages are Shift_JIS; the year indexes declare no charset at all,
 * so sniff instead of assuming UTF-8 (mojibake titles become unwritable
 * filenames further down: EILSEQ).
 */
export function decodeHtml(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1" as any).decode(bytes.subarray(0, 2048));
  const declared = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
  for (const label of [declared, "utf-8", "shift_jis"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label as any, { fatal: true }).decode(bytes);
    } catch {
      // wrong label, or bytes invalid for it: try the next candidate
    }
  }
  return new TextDecoder("utf-8").decode(bytes); // lossy, but never throws
}

async function fetchText(url: string): Promise<string> {
  return decodeHtml(await fetchBytes(url));
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", middot: "·", deg: "°",
};

/**
 * HTMLRewriter hands back raw text, so entity refs must be resolved here.
 * (Python's HTMLParser did this via convert_charrefs.)
 */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, ref: string) => {
      if (ref[0] === "#") {
        const code =
          ref[1] === "x" || ref[1] === "X"
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES[ref] ?? whole;
    },
  );
}

/** Collapse whitespace (the markup wraps descriptions across lines). */
export function cleanText(raw: string): string {
  return decodeEntities(raw).normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Accumulate the text of the FIRST matching element only.
 * HTMLRewriter streams text in arbitrary chunks, so buffer until the end tag.
 */
function firstTextCollector() {
  let state: "pending" | "active" | "done" = "pending";
  const chunks: string[] = [];
  return {
    element(el: HTMLRewriterTypes.Element) {
      if (state !== "pending") return;
      state = "active";
      try {
        el.onEndTag(() => {
          state = "done";
        });
      } catch {
        state = "done"; // self-closing element: nothing to accumulate
      }
    },
    text(chunk: HTMLRewriterTypes.Text) {
      if (state === "active") chunks.push(chunk.text);
    },
    value(): string | null {
      const joined = cleanText(chunks.join(""));
      return joined.length > 0 ? joined : null;
    },
  };
}

/**
 * Accumulate EVERY matching element, one cleaned line each.
 * 2013+ entries often split the blurb across many <p class="ss">, so keeping
 * only the first (as firstTextCollector does) silently dropped the rest.
 */
function allTextCollector() {
  const parts: string[] = [];
  let chunks: string[] | null = null;
  const flush = () => {
    if (!chunks) return;
    const text = cleanText(chunks.join(""));
    chunks = null;
    if (text.length > 0) parts.push(text);
  };
  return {
    element(el: HTMLRewriterTypes.Element) {
      flush(); // no nesting in these pages, so a new start tag ends the last
      chunks = [];
      try {
        el.onEndTag(() => flush());
      } catch {
        flush(); // self-closing element: nothing to accumulate
      }
    },
    text(chunk: HTMLRewriterTypes.Text) {
      if (chunks) chunks.push(chunk.text);
    },
    value(): string | null {
      flush();
      const joined = parts.join("\n");
      return joined.length > 0 ? joined : null;
    },
  };
}

const SOFT_RE = /softs\/(\d+)\.html$/;

/** Collect softs/NNN.html links from a year index, order preserved, deduped. */
export async function parseIndex(html: string): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  await new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        const href = el.getAttribute("href");
        if (!href) return;
        const match = SOFT_RE.exec(href.split("?")[0]!);
        if (match && !seen.has(href)) {
          seen.add(href);
          entries.push([match[1]!, href]);
        }
      },
    })
    .transform(new Response(html))
    .text();
  return entries;
}

export interface Detail {
  title: string | null;
  credit: string | null;
  description: string | null;
  images: string[];
}

/** Read h3 / h4 / description text plus every <img src> in document order. */
export async function parseDetail(html: string, pageUrl: string): Promise<Detail> {
  const title = firstTextCollector();
  const credit = firstTextCollector();
  const description = allTextCollector();
  const images: string[] = [];

  await new HTMLRewriter()
    .on("h3", title)
    .on("h4", credit)
    // The blurb class is inconsistent across years and includes outright typos:
    // "ss" (2013+), "small" (most of 2013), "sss" and "ssss" (scattered).
    .on('p[class^="s"]', description)
    // 2012 wraps the blurb in <div id="text"> instead of a <p> at all.
    .on("div#text", description)
    .on("img[src]", {
      element(el) {
        const src = el.getAttribute("src");
        // Resolve against the page: 2015 points at "1.jpg", 2026 at "001.jpg".
        if (src) images.push(new URL(src, pageUrl).href);
      },
    })
    .transform(new Response(html))
    .text();

  const detail: Detail = {
    title: title.value(),
    credit: credit.value(),
    description: description.value(),
    images,
  };
  // 2008-2011 predate the h3/h4 layout entirely (see parseLegacyDetail).
  return detail.title === null ? { ...parseLegacyDetail(html), images } : detail;
}

// Any element can carry it: <span>, <p>, and 2008's stray <td class="style2">.
const STYLE2_RE = /<(\w+)\s[^>]*class="style2"[^>]*>([\s\S]*?)<\/\1>/gi;
const STRONG_RE = /<strong>([\s\S]*?)<\/strong>/i;
const FIRST_BR_RE = /<br\s*\/?>/i;
const ANCHOR_RE = /<a\s[^>]*>[\s\S]*?<\/a>/gi;
const TAG_RE = /<[^>]*>/g;

/** Strip the decorative quoting around 2008-2010 titles: " x "  /  「 x 」. */
function unquoteTitle(text: string): string {
  return text.replace(/^["“「『【]\s*/, "").replace(/\s*["”」』】]$/, "").trim();
}

/**
 * 2008-2011 have no h3/h4/p.ss: every field lives in .style2 blocks, with the
 * title and "creator / occupation" line packed into one <strong> and split by a
 * <br>. Trailing "Official Site" anchors are markup, not part of the credit.
 * HTMLRewriter cannot express "text of this element but not of its <strong>",
 * so these pages are parsed as text.
 */
export function parseLegacyDetail(html: string): Omit<Detail, "images"> {
  const blocks = [...html.matchAll(STYLE2_RE)].map((m) => m[2]!);
  const head = blocks.find((b) => STRONG_RE.test(b));
  const strong = head ? STRONG_RE.exec(head)![1]! : "";
  const [titleRaw = "", creditRaw = ""] = strong
    .replace(ANCHOR_RE, "")
    .split(FIRST_BR_RE)
    .map((part) => cleanText(part.replace(TAG_RE, " ")));

  // Whatever is left once the header <strong> is removed is the description.
  const body = blocks
    .map((b) => cleanText(b.replace(STRONG_RE, " ").replace(ANCHOR_RE, " ").replace(TAG_RE, " ")))
    .filter((b) => b.length > 0);

  const title = unquoteTitle(titleRaw);
  return {
    title: title.length > 0 ? title : null,
    credit: creditRaw.length > 0 ? creditRaw : null,
    description: body.length > 0 ? body.join("\n") : null,
  };
}

/**
 * Split "Name|Occupation|Country".
 * 2026 mostly uses the fullwidth U+FF5C, but a handful of entries mix in an
 * ASCII pipe; 2012-2015-era pages use "／" or " / " and carry no country.
 */
export function splitCredit(credit: string | null): Credit {
  const out: Credit = {
    creator: null,
    occupation: null,
    country: null,
    credit_raw: credit,
  };
  if (!credit) return out;
  let parts = credit.split(/[｜|]/).map((p) => p.trim());
  if (parts.length === 1) parts = credit.split(/[／/]/).map((p) => p.trim());
  const fields = parts.filter((p) => p.length > 0);
  out.creator = fields[0] ?? null;
  out.occupation = fields[1] ?? null;
  out.country = fields[2] ?? null;
  return out;
}

/** Read width/height from a JPEG's SOF marker without decoding the image. */
export function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 2;
  while (i < data.length - 9) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan
    const length = view.getUint16(i + 2);
    // SOF0-SOF15, excluding DHT (C4), JPG (C8) and DAC (CC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// filenames
// ---------------------------------------------------------------------------

// POSIX-illegal plus the Windows/exFAT reserved set, so the tree stays safe to
// zip, sync, or copy onto an external drive.
const RESERVED = /[/\\:*?"<>|\0]/g;
const CONTROL = /[\x00-\x1f\x7f]/g;
const encoder = new TextEncoder();

/** Build "NNN - Title.ext", sanitized to survive any filesystem. */
export function safeFilename(
  id: string,
  title: string | null,
  suffix: string,
  plain = false,
): string {
  if (plain || !title) return `${id}${suffix}`;
  let name = title
    .normalize("NFC")
    .replace(RESERVED, "-")
    .replace(CONTROL, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!name) return `${id}${suffix}`;

  const prefix = `${id} - `;
  const budget =
    NAME_MAX_BYTES - encoder.encode(prefix).length - encoder.encode(suffix).length;
  // Byte limit, not character limit: Japanese costs 3 bytes per char in UTF-8.
  // Trim by code point so a multi-byte character is never split in half.
  while (encoder.encode(name).length > budget) {
    name = [...name].slice(0, -1).join("").replace(/[\s.]+$/g, "");
    if (!name) return `${id}${suffix}`;
  }
  return `${prefix}${name}${suffix}`;
}

function extOf(url: string, fallback: string): string {
  const base = new URL(url).pathname.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : fallback;
}

// ---------------------------------------------------------------------------
// avif
// ---------------------------------------------------------------------------

/**
 * The site serves near-lossless 4:4:4 JPEGs - around 700 KB for a 1230x810
 * label - which is right for an archival master and far too heavy for a grid of
 * 250 of them. Each download therefore gets an AVIF sibling for the page to
 * load, while the original stays on disk untouched.
 *
 * Chroma is kept at 4:4:4 rather than subsampled: the artwork is full of thin
 * saturated outlines and small coloured type, which is exactly what 4:2:0
 * smears, and on this material it only costs about 7% more bytes.
 *
 * `effort` trades encode time for size, and above 3 that trade goes bad here -
 * effort 4 is roughly 3x slower for well under 1% smaller output.
 */
interface AvifPreset {
  quality: number;
  effort: number;
}

/** Cover art: large, photographic-to-painterly, and the bulk of the bytes. */
const AVIF_ART: AvifPreset = { quality: 65, effort: 3 };

/**
 * Logos are small (130-591px) flat graphics with hard edges, where ringing
 * shows up immediately, so they get a higher quality. They are tiny either way.
 */
const AVIF_LOGO: AvifPreset = { quality: 80, effort: 3 };

/**
 * Keep the AVIF only when it is a real win. A handful of the smallest GIF logos
 * are already near-optimal as palette images and re-encode larger; for those the
 * page is better off pointing at the original.
 */
const AVIF_MIN_GAIN = 0.95;

/** "001 - Title.jpg" -> "001 - Title.avif" (only the final extension goes). */
export function avifName(file: string): string {
  return file.replace(/\.[^.\/]*$/, "") + ".avif";
}

/**
 * Encode `data` to an AVIF sibling of `name` in `outdir`, returning undefined
 * when the result is not worth keeping.
 *
 * `animated: true` is set unconditionally. Every logo GIF in the archive today
 * is a single frame, and the flag is a no-op on still input, but if an animated
 * one ever appears this keeps all of its frames instead of silently writing out
 * only the first.
 */
async function encodeAvif(
  data: Uint8Array,
  outdir: string,
  name: string,
  preset: AvifPreset,
): Promise<AvifInfo | undefined> {
  const file = avifName(name);
  const dest = `${outdir}/${file}`;

  const buf = await sharp(data, { animated: true })
    .avif({ quality: preset.quality, effort: preset.effort, chromaSubsampling: "4:4:4" })
    .toBuffer();

  if (buf.length >= data.length * AVIF_MIN_GAIN) {
    // A stale sibling from an earlier, more generous run would otherwise keep
    // being served, so drop it rather than leave the page pointing at it.
    await Bun.file(dest)
      .unlink()
      .catch(() => {});
    return undefined;
  }

  // Same swap-in-place dance as the downloads: a reader (or a deploy rsync)
  // must never catch a half-written frame.
  const part = `${dest}.part`;
  await Bun.write(part, buf);
  await $`mv ${part} ${dest}`.quiet();
  return { file, bytes: buf.length };
}

/**
 * Attach the AVIF rendition to `info`, reusing the one already on disk when the
 * source bytes have not changed. Re-encoding 5,500 assets on every run would
 * dominate the runtime of an otherwise no-op resume, so the hash check that
 * skips the download skips the encode too.
 */
async function attachAvif(
  info: AssetInfo,
  data: Uint8Array,
  outdir: string,
  name: string,
  preset: AvifPreset,
  prior?: AssetInfo,
): Promise<void> {
  if (info.skipped && prior?.avif) {
    if (await Bun.file(`${outdir}/${prior.avif.file}`).exists()) {
      info.avif = prior.avif;
      return;
    }
  }
  info.avif = await encodeAvif(data, outdir, name, preset);
}

// ---------------------------------------------------------------------------
// archiving one entry
// ---------------------------------------------------------------------------

function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/**
 * Download `url` into `outdir`, unless a byte-identical file is already there,
 * and write its AVIF sibling. `preset` picks the encoder settings for the kind
 * of image this is; AVIF is skipped entirely when `opts.avif` is false.
 */
async function writeAsset(
  url: string,
  outdir: string,
  name: string,
  existing: Map<string, AssetInfo>,
  opts: Options,
  preset: AvifPreset,
  progress?: Progress,
): Promise<AssetInfo> {
  progress?.setCurrent(name);
  const dest = `${outdir}/${name}`;
  const prior = existing.get(name);
  const file = Bun.file(dest);
  if (prior?.sha256 && (await file.exists())) {
    const onDisk = await file.bytes();
    if (sha256(onDisk) === prior.sha256) {
      const info: AssetInfo = { ...prior, file: name, url, bytes: onDisk.length, skipped: true };
      delete info.avif;
      // Backfill dimensions if an earlier run dropped them: we already have the
      // bytes in hand for the hash, so this costs nothing and self-heals.
      if (info.width === undefined) {
        const size = jpegSize(onDisk);
        if (size) {
          info.width = size.width;
          info.height = size.height;
        }
      }
      // Same self-healing for the AVIF: reused when it is already there, built
      // now if this download predates AVIF or the sibling went missing.
      if (opts.avif) await attachAvif(info, onDisk, outdir, name, preset, prior);
      return info;
    }
  }

  const data = await fetchBytes(url);
  // The server sends `accept-ranges: none`, so a partial file can't be
  // resumed - write beside the target and swap it in only once complete.
  const part = `${dest}.part`;
  await Bun.write(part, data);
  await $`mv ${part} ${dest}`.quiet();

  const info: AssetInfo = {
    file: name,
    url,
    bytes: data.length,
    sha256: sha256(data),
    skipped: false,
  };
  const size = jpegSize(data);
  if (size) {
    info.width = size.width;
    info.height = size.height;
  }
  if (opts.avif) await attachAvif(info, data, outdir, name, preset);
  return info;
}

async function archiveEntry(
  id: string,
  pageUrl: string,
  year: string,
  outdir: string,
  existing: Map<string, AssetInfo>,
  opts: Options,
  progress?: Progress,
): Promise<GameRecord> {
  progress?.setCurrent(`${id}.html`);
  const detail = await parseDetail(await fetchText(pageUrl), pageUrl);

  const record: GameRecord = {
    year: year.length === 2 ? 2000 + Number(year) : Number(year),
    id,
    title: detail.title,
    ...splitCredit(detail.credit),
    description: detail.description,
    source_url: pageUrl,
    retrieved_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  const [artUrl, logoUrl] = detail.images;

  if (opts.dryRun) {
    if (artUrl) {
      record.image = {
        file: safeFilename(id, detail.title, extOf(artUrl, ".jpg"), opts.plainNames),
        url: artUrl,
      };
    }
    return record;
  }

  if (artUrl) {
    const name = safeFilename(id, detail.title, extOf(artUrl, ".jpg"), opts.plainNames);
    record.image = await writeAsset(artUrl, outdir, name, existing, opts, AVIF_ART, progress);
  }
  if (logoUrl) {
    const name = safeFilename(
      id,
      detail.title,
      `_logo${extOf(logoUrl, ".gif")}`,
      opts.plainNames,
    );
    record.logo = await writeAsset(logoUrl, outdir, name, existing, opts, AVIF_LOGO, progress);
  }

  await writeSidecar(record, outdir, opts);
  return record;
}

/**
 * Write one record's sidecar JSON next to its artwork. `mustExist` is for the
 * translate-only path: the naming scheme comes from the flags of whichever run
 * created the files, so refusing to create a new file keeps a mismatched
 * --plain-names from scattering duplicate sidecars through the folder.
 */
async function writeSidecar(
  rec: GameRecord,
  outdir: string,
  opts: Options,
  mustExist = false,
): Promise<boolean> {
  const path = `${outdir}/${safeFilename(rec.id, rec.title, ".json", opts.plainNames)}`;
  if (mustExist && !(await Bun.file(path).exists())) return false;
  await Bun.write(path, JSON.stringify(rec, null, 2) + "\n");
  return true;
}

// ---------------------------------------------------------------------------
// translation (optional)
// ---------------------------------------------------------------------------

// Hiragana, katakana, CJK ideographs, halfwidth katakana. Fullwidth punctuation
// is deliberately excluded: "GAME OVER！" is still English.
const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾝ]/;

// The other scripts the exhibition turns up: Hangul, Cyrillic, Greek, Arabic,
// Hebrew, Thai, Devanagari. These get a share test rather than CJK's
// any-character test, because most of their appearances are a single foreign
// word glossed inside English prose — "Σειρήν (sirène) is a music game" needs
// no translating, while a Korean title standing on its own does.
const FOREIGN = /[가-힯ᄀ-ᇿЀ-ӿͰ-Ͽ؀-ۿ֐-׿฀-๿ऀ-ॿ]/g;

// Latin-1 and Latin Extended count as Latin, not foreign: "Relámpago" and
// "Á BIENTÔT" are English entries with accents, not entries to translate.
const LATIN = /[A-Za-zÀ-ɏ]/g;

const FOREIGN_SHARE = 0.5;

/** True when a string is written in a script that wants an English rendering. */
export function needsRendering(text: string | null | undefined): boolean {
  if (!text) return false;
  if (CJK.test(text)) return true;
  const foreign = text.match(FOREIGN)?.length ?? 0;
  if (foreign === 0) return false;
  const latin = text.match(LATIN)?.length ?? 0;
  return foreign / (foreign + latin) >= FOREIGN_SHARE;
}

// One script test per language FOREIGN lumps together, so a translated title
// can be tagged with the script it actually came from.
const SCRIPT_LANG: [RegExp, string][] = [
  [/[가-힯ᄀ-ᇿ]/, "KO"],
  [/[Ѐ-ӿ]/, "RU"],
  [/[Ͱ-Ͽ]/, "EL"],
  [/[؀-ۿ]/, "AR"],
  [/[֐-׿]/, "HE"],
  [/[฀-๿]/, "TH"],
  [/[ऀ-ॿ]/, "HI"],
];

/** Which script a translated title came from, for the "(JP)"-style superscript. */
export function sourceLanguage(text: string | null | undefined): string | null {
  if (!text) return null;
  if (CJK.test(text)) return "JP";
  for (const [script, code] of SCRIPT_LANG) if (script.test(text)) return code;
  return null;
}

// Only these three are worth translating: `creator` is a personal name,
// `country` is already English, and `credit_raw` is just the parts rejoined.
const TRANSLATABLE = ["title", "occupation", "description"] as const;
type Field = (typeof TRANSLATABLE)[number];
type Fields = Partial<Record<Field, string>>;

const ENGINE = "claude-cli";
const TRANSLATE_BATCH = 20;
const TRANSLATE_ATTEMPTS = 2;

/** Fingerprint the source text, so an edited original invalidates its translation. */
export function sourceHash(rec: GameRecord): string {
  const joined = TRANSLATABLE.map((f) => rec[f] ?? "").join("\0");
  return sha256(encoder.encode(joined));
}

/** Which of this record's fields are not English, and so need translating. */
function pending(rec: GameRecord): Field[] {
  return TRANSLATABLE.filter((f) => needsRendering(rec[f]));
}

/** A record wants work when it holds foreign text and no translation of *this* text. */
export function needsTranslation(rec: GameRecord): boolean {
  return pending(rec).length > 0 && rec.en?.src_hash !== sourceHash(rec);
}

const PROMPT = `Translate the non-English fields of the entries below into natural English.

They come from My Famicase Exhibition, a yearly show of cartridge label art for
imaginary Famicom games, so each one is a game title, a job title, or a short
blurb for a game that does not exist.

Rules:
- Reply with ONLY a JSON array. No prose, no notes, no code fences.
- One object per input entry, carrying the same "id" and the same keys.
- Keep the register: these are playful. Let a pun land in English rather than
  translating it word for word, and keep onomatopoeia lively. Never pad,
  explain, or add anything the original does not say.
- Use null for a value that is already English or that you cannot translate.
- Never translate or romanize a personal name.
- The entries are mostly Japanese, but not all: translate whatever language each
  field is actually written in.

Entries:
`;

/** Pull the JSON array out of a reply, tolerating stray prose or a code fence. */
function parseArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error(`no JSON array in reply: ${text.slice(0, 120)}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("reply was not an array");
  return parsed;
}

/**
 * Translate one batch by way of the Claude CLI in headless mode, which bills to
 * whatever subscription `claude` is already logged in with. The prompt goes in
 * on stdin: the text carries quotes, ※ and fullwidth punctuation, none of which
 * belongs in an argv string.
 */
async function translateBatch(items: Array<Fields & { id: string }>): Promise<Map<string, Fields>> {
  const payload = PROMPT + JSON.stringify(items, null, 2) + "\n";
  const run = await $`claude -p --output-format json < ${Buffer.from(payload)}`.quiet().nothrow();

  const stdout = run.stdout.toString().trim();
  if (!stdout) throw new Error(run.stderr.toString().trim() || `claude exited ${run.exitCode}`);

  // The envelope reports failure in-band, so an exit code alone is not enough:
  // an auth error still arrives as well-formed JSON.
  const env = JSON.parse(stdout) as { is_error?: boolean; result?: string };
  if (env.is_error || typeof env.result !== "string") {
    throw new Error(env.result ?? `claude exited ${run.exitCode}`);
  }

  const wanted = new Set(items.map((i) => i.id));
  const out = new Map<string, Fields>();
  for (const row of parseArray(env.result)) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const id = String(obj.id ?? "");
    if (!wanted.has(id)) continue; // never trust an id we did not send
    const fields: Fields = {};
    for (const f of TRANSLATABLE) {
      const value = obj[f];
      if (typeof value === "string" && value.trim()) fields[f] = value.trim();
    }
    if (Object.keys(fields).length) out.set(id, fields);
  }
  return out;
}

/** One retry, then give up on the batch. A translation is never worth failing a run over. */
async function tryBatch(
  items: Array<Fields & { id: string }>,
  note: (message: string) => void = console.log,
  onRetry: (() => void) | null = null,
): Promise<Map<string, Fields>> {
  for (let attempt = 1; attempt <= TRANSLATE_ATTEMPTS; attempt++) {
    try {
      return await translateBatch(items);
    } catch (err) {
      if (attempt === TRANSLATE_ATTEMPTS) {
        note(`  ! translation batch failed: ${err}`);
        return new Map();
      }
      onRetry?.();
      await Bun.sleep(1_000);
    }
  }
  return new Map();
}

/**
 * Fill in `en` on every record that needs one, mutating `records` in place.
 * Records already translated from the same source text are left untouched, so
 * a repeated run costs nothing.
 */
export async function translateRecords(records: GameRecord[]): Promise<boolean> {
  const japanese = records.filter((r) => pending(r).length > 0);
  const todo = japanese.filter(needsTranslation);
  const cached = japanese.length - todo.length;

  if (todo.length === 0) {
    console.log(`  translate: nothing to do (${cached} cached, ${records.length - japanese.length} English)`);
    return false;
  }
  if (!Bun.which("claude")) {
    console.log("  claude CLI not found - skipping translation. See https://claude.com/claude-code");
    return false;
  }

  const batches = Math.ceil(todo.length / TRANSLATE_BATCH);
  console.log(`  translate: ${todo.length} entries in ${batches} call(s), ${cached} cached`);

  // `occupation` is a small repeating vocabulary across the exhibition, so each
  // distinct one is translated once and reused for every record that shares it.
  const occupations = new Map<string, string>();
  let translated = 0;
  let failed = 0;

  const bar = new Progress(todo.length, "translate");
  // A batch is one long opaque call, so the stat segment reports which call is
  // in flight and how long it has been running rather than a byte count.
  let batchNo = 0;
  let batchStartedAt = performance.now();
  let phase = "";
  bar.setDetail(() => {
    const secs = (performance.now() - batchStartedAt) / 1000;
    return `call ${Math.max(1, batchNo)}/${batches}${phase} · ${fmtDuration(secs)}`;
  });

  for (let i = 0; i < todo.length; i += TRANSLATE_BATCH) {
    const slice = todo.slice(i, i + TRANSLATE_BATCH);
    const items = slice.map((rec) => {
      const item: Fields & { id: string } = { id: rec.id };
      for (const f of pending(rec)) {
        if (f === "occupation" && occupations.has(rec.occupation!)) continue;
        item[f] = rec[f]!;
      }
      return item;
    });

    // An entry whose only foreign field is an already-known occupation needs
    // no call of its own.
    const ask = items.filter((item) => Object.keys(item).length > 1);

    batchNo++;
    batchStartedAt = performance.now();
    phase = "";
    // Name the batch by its first title, since the whole slice is in flight at
    // once and there is no single "current" entry to point at.
    const lead = slice[0]?.title ?? "";
    const rest = slice.length - 1;
    bar.setCurrent(rest > 0 ? `${lead} +${rest}` : lead);
    bar.startTicker();

    const got = ask.length
      ? await tryBatch(
          ask,
          (message) => bar.note(message),
          () => {
            phase = " · retry";
          },
        )
      : new Map<string, Fields>();

    bar.stopTicker();

    for (const rec of slice) {
      const fields: Fields = { ...got.get(rec.id) };
      const occupation = rec.occupation;
      if (occupation && needsRendering(occupation)) {
        if (fields.occupation) occupations.set(occupation, fields.occupation);
        else if (occupations.has(occupation)) fields.occupation = occupations.get(occupation);
      }
      if (Object.keys(fields).length === 0) {
        failed++;
        bar.complete({ skipped: false, bytes: 0 });
        continue;
      }
      rec.en = {
        ...fields,
        src_hash: sourceHash(rec),
        engine: ENGINE,
        translated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
      translated++;
      bar.complete({ skipped: false, bytes: 0 });
    }
  }

  bar.finish();

  console.log(`  translate: ${translated} translated, ${cached} cached, ${failed} failed`);
  return translated > 0;
}

// ---------------------------------------------------------------------------
// metadata embedding (optional)
// ---------------------------------------------------------------------------

/** Merge title/creator/description into each JPEG's existing XMP packet. */
async function embedMetadata(records: GameRecord[], outdir: string): Promise<void> {
  if (!Bun.which("exiftool")) {
    console.log("  exiftool not found - skipping --embed. Install: brew install exiftool");
    return;
  }
  let done = 0;
  for (const rec of records) {
    const image = rec.image?.file;
    if (!image || !/\.jpe?g$/i.test(image)) continue;
    const path = `${outdir}/${image}`;
    if (!(await Bun.file(path).exists())) continue;

    const args = ["-overwrite_original_in_place", "-q", "-q", "-codedcharacterset=utf8"];
    if (rec.title) args.push(`-XMP-dc:Title=${rec.title}`, `-IPTC:ObjectName=${rec.title}`);
    if (rec.description) {
      args.push(
        `-XMP-dc:Description=${rec.description}`,
        `-IPTC:Caption-Abstract=${rec.description}`,
      );
    }
    if (rec.creator) args.push(`-XMP-dc:Creator=${rec.creator}`, `-IPTC:By-line=${rec.creator}`);
    if (rec.country) args.push(`-IPTC:Country-PrimaryLocationName=${rec.country}`);
    args.push(`-XMP-dc:Source=${rec.source_url}`);

    const result = await $`exiftool ${args} ${path}`.quiet().nothrow();
    if (result.exitCode === 0) done++;
    else console.log(`  exiftool failed on ${image}: ${result.stderr.toString().trim()}`);
  }
  console.log(`  embedded metadata into ${done} JPEG(s)`);
}

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

const BAR_WIDTH = 22;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Truncate to a terminal *display* width - CJK titles are double-width. */
export function truncateWidth(text: string, max: number): string {
  if (max <= 1) return "";
  if (Bun.stringWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = Bun.stringWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return out + "…";
}

let cursorHidden = false;
function showCursor(): void {
  if (cursorHidden) {
    process.stdout.write("\x1b[?25h");
    cursorHidden = false;
  }
}
process.on("exit", showCursor);
process.on("SIGINT", () => {
  showCursor();
  process.exit(130);
});

/**
 * Single-line live progress bar. Falls back to periodic plain lines when stdout
 * is not a TTY, so piping to a file or CI log stays readable.
 */
class Progress {
  private done = 0;
  private skipped = 0;
  private bytes = 0;
  private current = "";
  private detail: (() => string) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = performance.now();
  private lastRender = 0;
  private lineOpen = false;
  private readonly tty = Boolean(process.stdout.isTTY);
  private nextPlainAt = 0;

  constructor(private readonly total: number, private readonly label: string) {
    if (this.tty && this.total > 0) {
      process.stdout.write("\x1b[?25l");
      cursorHidden = true;
    }
  }

  /** Name the asset now being fetched. */
  setCurrent(name: string): void {
    this.current = name;
    this.render();
  }

  /**
   * Replace the byte counters with a caller-supplied stat segment. It is a
   * function, not a string, so a clock inside it advances on every repaint.
   */
  setDetail(fn: (() => string) | null): void {
    this.detail = fn;
    this.render(true);
  }

  /**
   * Repaint on a timer. A translation batch is one opaque call that can run for
   * a minute with nothing to report, and a bar that never moves reads as a
   * hang; ticking keeps the clock and the ETA honest. Unref'd so it can never
   * hold the process open.
   */
  startTicker(everyMs = 250): void {
    if (this.ticker || !this.tty) return;
    this.ticker = setInterval(() => this.render(true), everyMs);
    this.ticker.unref?.();
  }

  stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** Record one finished entry. */
  complete(opts: { skipped: boolean; bytes: number }): void {
    this.done++;
    this.bytes += opts.bytes;
    if (opts.skipped) this.skipped++;
    this.render(true);
  }

  /** Print a line above the bar without corrupting it. */
  note(message: string): void {
    this.clear();
    console.log(message);
    this.render(true);
  }

  private clear(): void {
    if (this.tty && this.lineOpen) {
      process.stdout.write("\r\x1b[K");
      this.lineOpen = false;
    }
  }

  private eta(): string {
    const elapsed = (performance.now() - this.startedAt) / 1000;
    if (this.done === 0) return "eta --";
    const remaining = ((this.total - this.done) * elapsed) / this.done;
    return this.done >= this.total ? fmtDuration(elapsed) : `eta ${fmtDuration(remaining)}`;
  }

  private render(force = false): void {
    if (this.total === 0) return;

    if (!this.tty) {
      // Plain mode: a line every 10% so logs stay short but informative.
      const step = Math.max(1, Math.ceil(this.total / 10));
      if (this.nextPlainAt === 0) this.nextPlainAt = step;
      if (force && (this.done >= this.nextPlainAt || this.done === this.total)) {
        this.nextPlainAt = this.done + step;
        const pct = Math.floor((this.done / this.total) * 100);
        const stats = this.detail ? this.detail() : `${fmtBytes(this.bytes)} · ${this.skipped} cached`;
        console.log(`  ${this.label} ${this.done}/${this.total} (${pct}%) · ${stats}`);
      }
      return;
    }

    const now = performance.now();
    if (!force && now - this.lastRender < 60) return;
    this.lastRender = now;

    const frac = Math.min(1, this.done / this.total);
    const filled = Math.round(frac * BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const pct = String(Math.floor(frac * 100)).padStart(3);
    const width = String(this.total).length;
    const count = `${String(this.done).padStart(width)}/${this.total}`;
    const stats = (
      this.detail
        ? [this.detail()]
        : [fmtBytes(this.bytes), this.skipped ? `${this.skipped} cached` : ""]
    )
      .concat(this.eta())
      .filter(Boolean)
      .join(" · ");

    const head = `  ${bar} ${pct}%  ${count}  ${stats}`;
    const cols = process.stdout.columns || 80;
    const room = cols - Bun.stringWidth(head) - 4;
    const tail = room > 8 && this.current ? `  ${truncateWidth(this.current, room)}` : "";

    process.stdout.write(`\r\x1b[K${head}${tail}`);
    this.lineOpen = true;
  }

  /** Clear the bar and leave the cursor on a fresh line. */
  finish(): void {
    this.stopTicker();
    this.clear();
    if (this.tty) showCursor();
  }
}

// ---------------------------------------------------------------------------
// static page
// ---------------------------------------------------------------------------

// White ground, no chrome, no borders: the cover art carries the page.
const PAGE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{color-scheme:light}
body{margin:0;background:#fff;color:#111;
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:44px 28px 88px}
header{margin-bottom:32px}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 4px}
.meta{font-size:12.5px;color:#888;margin:0}
.meta a{color:#888;text-decoration:underline;text-underline-offset:2px}
/* No grid gap: the card's own padding is the gutter, so tiles sit flush and the
   only whitespace is the breathing room inside each card. */
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0}

/* The tile is an absolutely-positioned card sitting over a placeholder that
   reserves the artwork box and the title. The card carries its padding at all
   times and only paints a background on hover, so the artwork cannot shift and
   revealing the details never reflows the grid. */
figure{margin:0;position:relative;padding:8px 10px}
figure::after{content:"";display:block;height:23px}
figure:hover{z-index:30}
.ph{width:100%}
.card{position:absolute;top:0;left:0;right:0;padding:10px;
  transition:background-color .16s ease,box-shadow .16s ease}
.card picture{display:block}
.card img{width:100%;height:auto;display:block;background:#e0e0e0;color:transparent;font-size:0}
.title{font-size:13px;font-weight:600;line-height:1.3;margin:6px 0 0;
  display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.title sup.lang{font-size:9px;font-weight:400;color:#999;margin-left:2px}
figure.on .title sup.lang{color:#9a9a9a}
.more{max-height:0;overflow:hidden;opacity:0;transition:opacity .16s ease}
.by{font-size:11.5px;color:#8a8a8a;margin:7px 0 0}
.desc{font-size:12px;line-height:1.55;color:#4a4a4a;margin:6px 0 0;white-space:pre-line}

figure:hover .card{background:#fff;
  box-shadow:0 8px 28px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.07)}
figure:hover .title{-webkit-line-clamp:unset;overflow:visible}
figure:hover .more{max-height:none;opacity:1}

/* Touch devices can't hover: lay the details out inline instead. */
@media(hover:none){
  figure::after{display:none}
  .ph{display:none}
  .card{position:static;padding:0}
  .title{-webkit-line-clamp:unset;overflow:visible}
  .more{max-height:none;opacity:1}
  figure:hover .card{background:none;box-shadow:none}
}
@media(max-width:1000px){.grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}
  .wrap{padding:32px 12px 64px}}
@media(max-width:440px){.grid{grid-template-columns:1fr}}

/* Click (or Enter/Space) marks a tile by inverting it. Last in the sheet, and
   repeated for the hover state, so it beats both the hover fill and the
   touch-mode reset above. The muted greys are lifted for contrast on black.
   Only the cover art itself is clickable, so it's the only part that gets
   the pointing-hand cursor; the rest of the card keeps the default (text
   over the prose). */
.card img{cursor:pointer}
figure.on .card,figure.on:hover .card{background:#000;color:#fff}
figure.on .by{color:#9a9a9a}
figure.on .desc{color:#d8d8d8}

/* Toolbar, shared by the year and master pages. */
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:14px}
button{font:inherit;font-size:12.5px;line-height:1;color:#111;background:#fff;
  border:1px solid #ddd;padding:8px 13px;cursor:pointer}
button:hover{border-color:#111}
button:focus-visible{outline:2px solid #111;outline-offset:2px}
button[aria-pressed="true"]{background:#111;color:#fff;border-color:#111}

/* Both languages ship in the markup and the toggle picks one. A field is only
   marked .ja when it actually has an English twin, so an entry that was always
   English never blanks out in EN mode. */
.en{display:none}
body.lang-en .ja{display:none}
body.lang-en .en{display:block}
body.lang-en .title.en{display:-webkit-box}

/* Dark theme: inverted colors matching favorited cards (#000 ground, #fff text,
   lifted greys for metadata and descriptions). Favorited tiles in dark mode invert
   back to white ground. */
html.theme-dark{color-scheme:dark}
html.theme-dark,body.theme-dark{background:#000;color:#fff}
body.theme-dark .meta,body.theme-dark .meta a{color:#9a9a9a}
body.theme-dark .card img{background:#222}
body.theme-dark figure:hover .card{background:#000;
  box-shadow:0 8px 28px rgba(255,255,255,.15),0 1px 3px rgba(255,255,255,.07)}
body.theme-dark .by{color:#9a9a9a}
body.theme-dark .desc{color:#d8d8d8}
body.theme-dark .title sup.lang{color:#9a9a9a}

/* In dark mode, favorited tiles (.on) invert back to white ground */
body.theme-dark figure.on .card,body.theme-dark figure.on:hover .card{background:#fff;color:#111}
body.theme-dark figure.on .by{color:#8a8a8a}
body.theme-dark figure.on .desc{color:#4a4a4a}
body.theme-dark figure.on .title sup.lang{color:#999}

/* Dark mode buttons and controls */
body.theme-dark button{color:#fff;background:#000;border-color:#333}
body.theme-dark button:hover{border-color:#fff}
body.theme-dark button:focus-visible{outline-color:#fff}
body.theme-dark button[aria-pressed="true"]{background:#fff;color:#111;border-color:#fff}
`.trim();

// Click-to-highlight, shared by every page. Purely visual and not persisted.
// No template literals: this string is interpolated into one.
const HIGHLIGHT_JS = `
(function () {
  var grid = document.querySelector('.grid');
  if (!grid) return;

  function toggle(target) {
    var tile = target.closest ? target.closest('figure') : null;
    if (tile) tile.classList.toggle('on');
  }

  grid.addEventListener('click', function (ev) {
    if (ev.target.tagName !== 'IMG') return; // only the cover art favorites the tile
    toggle(ev.target);
  });
  grid.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();                    // Space would scroll the page
    toggle(ev.target);
  });
})();
`.trim();

// Master-page favorites: the same marks as HIGHLIGHT_JS, but keyed by
// year/id in localStorage so they survive a reload, plus a filter that hides
// everything unmarked. Used instead of HIGHLIGHT_JS, never alongside it.
// No template literals: this string is interpolated into one.
const FAVORITES_JS = `
(function () {
  var grid = document.getElementById('grid');
  if (!grid) return;
  var btn = document.getElementById('favs');
  var KEY = 'famicase-favorites';

  var keys = [];
  try {
    var raw = localStorage.getItem(KEY);            // private mode throws
    if (raw) keys = JSON.parse(raw) || [];
  } catch (err) {}
  var marked = {};
  keys.forEach(function (k) { marked[k] = 1; });

  function save() {
    var out = Object.keys(marked);
    try {
      if (out.length) localStorage.setItem(KEY, JSON.stringify(out));
      else localStorage.removeItem(KEY);
    } catch (err) {}
  }

  function count() {
    return Object.keys(marked).length;
  }

  function label() {
    if (!btn) return;
    var n = count();
    btn.textContent = n ? 'Favorites (' + n + ')' : 'Favorites';
    btn.disabled = !n && !document.body.classList.contains('only-favs');
  }

  var byKey = {};
  Array.prototype.forEach.call(grid.children, function (tile) {
    var key = tile.getAttribute('data-key');
    if (key) byKey[key] = tile;
    if (marked[key]) tile.classList.add('on');
  });

  function toggle(target) {
    var tile = target.closest ? target.closest('figure') : null;
    if (!tile) return;
    var on = tile.classList.toggle('on');
    var key = tile.getAttribute('data-key');
    if (key) {
      if (on) marked[key] = 1;
      else delete marked[key];
      save();
    }
    label();
  }

  grid.addEventListener('click', function (ev) {
    if (ev.target.tagName !== 'IMG') return; // only the cover art favorites the tile
    toggle(ev.target);
  });
  grid.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();                    // Space would scroll the page
    toggle(ev.target);
  });

  if (btn) {
    btn.addEventListener('click', function () {
      var only = document.body.classList.toggle('only-favs');
      btn.setAttribute('aria-pressed', only ? 'true' : 'false');
      label();
      window.dispatchEvent(new Event('resize'));   // the scrubber remeasures
    });
  }

  // Import/export as a single comma-separated list of keys, via one
  // window.prompt so the user can copy or paste it by hand. A real
  // newline-separated list would read nicer, but prompt() collapses a
  // multi-line default value onto one line in most browsers, so commas are
  // the format that round-trips. The prompt is pre-filled with the current
  // list, doubling as export; on close, only a changed value is re-imported,
  // so simply reading and cancelling never touches the marks.
  var ioBtn = document.getElementById('favs-io');

  if (ioBtn) {
    ioBtn.addEventListener('click', function () {
      var before = Object.keys(marked).sort().join(', ');
      var input = window.prompt('Favorites (copy to export, edit and confirm to import):', before);
      if (input === null || input === before) return;   // cancelled, or unchanged
      Array.prototype.forEach.call(grid.children, function (tile) { tile.classList.remove('on'); });
      marked = {};
      input.split(',').forEach(function (raw) {
        var key = raw.trim();
        if (!key) return;
        marked[key] = 1;
        var tile = byKey[key];
        if (tile) tile.classList.add('on');
      });
      save();
      label();
    });
  }

  label();
})();
`.trim();

// Language toggle. Only bound when the page actually carries translations, and
// no template literals: this string is interpolated into one.
const LANG_JS = `
(function () {
  var btn = document.getElementById('lang');
  if (!btn) return;
  var KEY = 'famicase-lang';

  function set(lang, save) {
    var en = lang === 'en';
    document.body.classList.toggle('lang-en', en);
    btn.textContent = en ? 'Translated Text' : 'Original Text';   // offer the other one
    btn.setAttribute('aria-pressed', en ? 'true' : 'false');
    if (!save) return;
    try { localStorage.setItem(KEY, lang); } catch (err) {}  // private mode throws
  }

  btn.addEventListener('click', function () {
    set(document.body.classList.contains('lang-en') ? 'ja' : 'en', true);
  });

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (err) {}
  set(saved === 'en' ? 'en' : 'ja', false);
})();
`.trim();

const PRELOAD_THEME_JS = `<script>try{if(localStorage.getItem('famicase-theme')==='dark'){document.documentElement.classList.add('theme-dark');}}catch(e){}</script>`;

// Dark theme toggle script. Persists selection in localStorage.
// No template literals: this string is interpolated into one.
const THEME_JS = `
(function () {
  var btn = document.getElementById('theme');
  var KEY = 'famicase-theme';

  function set(theme, save) {
    var dark = theme === 'dark';
    document.documentElement.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-dark', dark);
    if (btn) {
      btn.textContent = dark ? 'Light Theme' : 'Dark Theme';
    }
    if (!save) return;
    try { localStorage.setItem(KEY, theme); } catch (err) {}
  }

  function getInitialTheme() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (err) {}
    return 'light';
  }

  var current = getInitialTheme();
  set(current, false);

  if (btn) {
    btn.addEventListener('click', function () {
      var isDark = document.body.classList.contains('theme-dark');
      set(isDark ? 'light' : 'dark', true);
    });
  }
})();
`.trim();

const esc = (s: string) => Bun.escapeHTML(s);

/**
 * One field, doubled when a translation exists. The original is tagged .ja only
 * in that case, so the toggle has something to swap it for. `enSuffix`, when
 * given, is raw markup appended inside the English paragraph (the "(JP)"
 * source-language tag on a translated title).
 */
function bilingual(cls: string, ja: string, en: string | null | undefined, enSuffix = ""): string[] {
  const paired = Boolean(en) && en !== ja;
  const original = `<p class="${cls}${paired ? " ja" : ""}"${paired ? ` lang="ja"` : ""}>${esc(ja)}</p>`;
  if (!paired) return [original];
  return [original, `<p class="${cls} en" lang="en">${esc(en!)}${enSuffix}</p>`];
}

/** The toggle button, rendered only when some record on the page has English. */
function langToggle(records: GameRecord[]): string {
  if (!records.some((r) => r.en)) return "";
  return `<button id="lang" type="button" aria-pressed="false">English</button>`;
}

const yearLabel = (year: string) => (year.length === 2 ? `20${year}` : year);

/**
 * Render the grid tiles. `dir` prefixes the image path (the master page lives a
 * level above the images); `withYear` prepends the year to the credit line.
 */
function renderCards(records: GameRecord[], dir = "", withYear = false): string {
  return records
    .filter((r) => r.image?.file)
    .map((r) => {
      const img = r.image!;
      const title = r.title ?? "Untitled";
      const year = String(r.year);
      const lang = r.en?.title ? sourceLanguage(title) : null;
      const titleSuffix = lang ? ` <sup class="lang">(${lang})</sup>` : "";
      // Only the occupation is translated, so the credit line is rebuilt around it.
      const credit = (occupation: string | null) =>
        [withYear ? year : null, r.creator, occupation, r.country]
          .filter(Boolean)
          .join(" · ");
      const by = credit(r.occupation);
      const byEn = r.en?.occupation ? credit(r.en.occupation) : null;
      // Filenames carry spaces and non-ASCII, so they must be encoded for src.
      const src = dir + encodeURIComponent(img.file);
      const avif = img.avif ? dir + encodeURIComponent(img.avif.file) : null;
      const dims = img.width && img.height ? ` width="${img.width}" height="${img.height}"` : "";
      // The <img> keeps the original JPEG, so a browser without AVIF (and any
      // reader of the saved page years from now) still gets the archival master.
      // Its markup is unchanged inside <picture>, and every selector on the page
      // is either .card img or figure-level, so the wrapper is inert to CSS/JS.
      const tag = `<img src="${src}"${dims} loading="lazy" decoding="async" alt="${esc(title)}">`;
      const picture = avif
        ? `<picture><source srcset="${avif}" type="image/avif">${tag}</picture>`
        : tag;

      const more = [
        ...(by ? bilingual("by", by, byEn) : []),
        ...(r.description ? bilingual("desc", r.description, r.en?.description) : []),
      ].join("\n            ");

      // The placeholder reserves the artwork box in normal flow while the card
      // floats above it, so use each image's own ratio rather than assuming one.
      const ratio = img.width && img.height ? `${img.width}/${img.height}` : "1230/810";

      // Short key for the favorites list: last two digits of the year plus the
      // id with leading zeros stripped, e.g. year 2026 id "008" -> "268".
      const favKey = year.slice(-2) + String(Number(r.id));
      return `      <figure tabindex="0" data-year="${esc(year)}" data-key="${esc(favKey)}">
        <div class="ph" style="aspect-ratio:${ratio}" aria-hidden="true"></div>
        <div class="card">
          ${picture}
          ${bilingual("title", title, r.en?.title, titleSuffix).join("\n          ")}
          ${more ? `<div class="more">\n            ${more}\n          </div>` : ""}
        </div>
      </figure>`;
    })
    .join("\n");
}

/** Build a self-contained index page; images are siblings on disk. */
export function renderYearPage(records: GameRecord[], year: string): string {
  const label = yearLabel(year);
  const cards = renderCards(records);
  const toggle = langToggle(records);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Famicase Exhibition ${label}</title>
<style>
${PAGE_CSS}
</style>
${PRELOAD_THEME_JS}
</head>
<body>
  <div class="wrap">
    <header>
      <h1>My Famicase Exhibition ${label}</h1>
      <p class="meta">${records.length} entries &middot; archived from
        <a href="${BASE}/${year}/index.html">famicase.com</a></p>
      <div class="tools">
        <button id="theme" type="button">Dark Theme</button>
        ${toggle}
      </div>
    </header>
    <div class="grid">
${cards}
    </div>
  </div>
<script>
${HIGHLIGHT_JS}
${LANG_JS}
${THEME_JS}
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// master page
// ---------------------------------------------------------------------------

// Toolbar for the master page: same white ground, so it stays out of the way.
const MASTER_CSS = `
/* Legal/credit blurb: a footnote under the stats line, quieter and narrower
   so it reads as fine print rather than competing with the header. */
.credit{max-width:640px;margin-top:6px;font-size:11.5px;line-height:1.5;color:#aaa}
.credit a{color:#aaa}

/* The year rail is this page's scrollbar, so the browser's own is redundant. */
html{scrollbar-width:none}
html::-webkit-scrollbar{display:none}

/* Shuffle, seed and reset read as one control: a single hairline box with
   flush segments, so three widgets cost the space of one. The seed field is
   the status readout too - empty means exhibition order. */
.group{display:inline-flex;align-items:stretch;border:1px solid #ddd}
.group:focus-within{border-color:#111}
.group button{border:0;border-left:1px solid #ddd}
.group button:first-child{border-left:0}
.group button:hover:not(:disabled){background:#f4f4f4}
.group button:disabled{color:#bbb;cursor:default}
.group input{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;
  border:0;border-left:1px solid #ddd;padding:8px;width:12ch;text-align:center;
  background:#fff}
.group input:focus{outline:0}
.group input::placeholder{color:#aaa}

/* Announced to screen readers; the controls themselves show the state. */
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}

/* Year scrubber: a Google-Photos-style rail pinned to the right edge. Ticks sit
   where each year begins, proportional to the scroll range, and the rail only
   fades in while you're scrolling or pointing at it. */
.scrub{position:fixed;top:0;right:0;bottom:0;width:74px;z-index:60;
  font:11.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
/* Shuffled or filtered, the years no longer run in order, so the rail drops to
   a plain handle: no ticks, no year on the bubble. It stays put either way,
   since it is the only scrollbar this page has. */
body.shuffled .tick,body.only-favs .tick{display:none}
body.shuffled .scrub .now,body.only-favs .scrub .now{
  background:none;color:transparent;padding:0;width:0}

/* Favorites filter: the marks themselves are the selection, so hiding the rest
   is all the filter has to do. */
body.only-favs figure:not(.on){display:none}
/* The hit area is the whole rail; the ticks themselves must not swallow clicks. */
.scrub .rail{position:absolute;inset:0;cursor:pointer}
/* The rail rests out of sight; only the handle stays on screen to mark where
   you are. Scrolling or pointing at the rail brings the year labels in. */
.scrub .tick{position:absolute;right:14px;z-index:1;transform:translateY(-50%);color:#b4b4b4;
  white-space:nowrap;pointer-events:none;opacity:0;
  transition:color .16s ease,opacity .25s ease}
.scrub.on .tick,.scrub:hover .tick{opacity:1}
.scrub .tick::after{content:"";position:absolute;right:-9px;top:50%;
  width:5px;height:1px;background:#d5d5d5;transform:translateY(-50%)}
.scrub .tick.cur{color:#111;font-weight:600}
.scrub .tick.cur::after{background:#111;width:8px;right:-12px}
/* The bubble tracks the scroll position and always names the year you're in. */
/* Sits at the very edge so its arrow points off-screen, and above the ticks it
   slides over. */
.scrub .now{position:absolute;right:7px;z-index:2;transform:translateY(-50%);
  background:#111;color:#fff;padding:5px 8px;font-weight:600;
  pointer-events:none;white-space:nowrap;
  transition:background-color .25s ease,color .25s ease,padding .25s ease}
.scrub .now::after{content:"";position:absolute;right:-4px;top:50%;
  width:8px;height:8px;background:#111;transform:translate(0,-50%) rotate(45deg)}
/* Collapsed: the label folds away and the arrow alone is left pointing at the
   edge, so the scroll position is always readable without the rail showing. */
.scrub:not(.on):not(:hover) .now{background:none;color:transparent;padding:0;width:0}
@media(hover:none){.scrub{width:58px}}
@media(max-width:440px){.scrub{display:none}}

/* Dark mode for master page credit blurb, input groups, and year scrubber */
body.theme-dark .credit,body.theme-dark .credit a{color:#9a9a9a}
body.theme-dark .group{border-color:#333}
body.theme-dark .group:focus-within{border-color:#fff}
body.theme-dark .group button{border-left-color:#333}
body.theme-dark .group button:hover:not(:disabled){background:#1a1a1a}
body.theme-dark .group button:disabled{color:#444}
body.theme-dark .group input{color:#fff;background:#000;border-left-color:#333}
body.theme-dark .group input::placeholder{color:#555}

body.theme-dark .scrub .tick{color:#555}
body.theme-dark .scrub .tick::after{background:#333}
body.theme-dark .scrub .tick.cur{color:#fff}
body.theme-dark .scrub .tick.cur::after{background:#fff}
body.theme-dark .scrub .now{background:#fff;color:#111}
body.theme-dark .scrub .now::after{background:#fff}
`.trim();

// Deterministic shuffle so a seed in the URL reproduces an exact order.
// No template literals here: this string is itself inside one.
const MASTER_JS = `
(function () {
  var grid = document.getElementById('grid');
  var tiles = Array.prototype.slice.call(grid.children);
  var input = document.getElementById('seed');
  var status = document.getElementById('status');
  var reset = document.getElementById('reset');

  function rng(seed) {                      // mulberry32
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(text) {                 // any string -> 32-bit seed
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function apply(seed) {
    document.body.classList.toggle('shuffled', Boolean(seed));
    if (!seed) {                            // document order
      tiles.forEach(function (t) { t.style.order = ''; });
      status.textContent = 'in exhibition order';
      window.dispatchEvent(new Event('resize'));   // the scrubber remeasures
      return;
    }
    var next = rng(hashSeed(seed));
    var order = tiles.map(function (_, i) { return i; });
    for (var i = order.length - 1; i > 0; i--) {   // Fisher-Yates
      var j = Math.floor(next() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    order.forEach(function (position, i) { tiles[i].style.order = position; });
    status.textContent = 'shuffled';
  }

  function readSeed() {
    var hash = location.hash.replace(/^#/, '');
    var match = /(?:^|&)seed=([^&]*)/.exec(hash);
    return match ? decodeURIComponent(match[1]) : (hash && hash.indexOf('=') < 0 ? decodeURIComponent(hash) : '');
  }

  function writeSeed(seed) {
    var url = location.pathname + location.search + (seed ? '#seed=' + encodeURIComponent(seed) : '');
    try {
      history.replaceState(null, '', url);   // throws on opaque origins (data:, sandboxes)
    } catch (err) {
      if (seed) location.hash = 'seed=' + encodeURIComponent(seed);
    }
  }

  var current = null;

  function set(seed, push) {
    if (seed === current) return;
    current = seed;
    input.value = seed;
    reset.disabled = !seed;
    apply(seed);
    if (push) writeSeed(seed);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.getElementById('shuffle').addEventListener('click', function () {
    set(Math.random().toString(36).slice(2, 8), true);
  });
  reset.addEventListener('click', function () {
    set('', true);
  });
  input.addEventListener('change', function () {
    set(input.value.trim(), true);
  });
  window.addEventListener('hashchange', function () {
    // Only react to a hash someone else changed; our own writeSeed already applied.
    var seed = readSeed();
    if (seed !== current && !(seed === '' && location.href.indexOf('#') < 0)) set(seed, false);
  });

  set(readSeed(), false);                   // honor a shared link on load
})();
`.trim();

// Year scrubber for the master page: a right-edge rail that says which year you
// are looking at and jumps to any other. Only meaningful in exhibition order,
// so it steps aside once the grid is shuffled. No template literals: this
// string is interpolated into one.
const SCRUB_JS = `
(function () {
  var grid = document.getElementById('grid');
  var scrub = document.getElementById('scrub');
  if (!grid || !scrub) return;
  var rail = scrub.querySelector('.rail');
  var bubble = scrub.querySelector('.now');

  // First tile of each year, in document order. That tile's top is where the
  // year starts; everything else is derived from it.
  var years = [], seen = {};
  Array.prototype.forEach.call(grid.children, function (tile) {
    var y = tile.getAttribute('data-year');
    if (!y || seen[y]) return;
    seen[y] = 1;
    years.push({ year: y, tile: tile, top: 0, tick: null });
  });
  if (years.length < 2) return;             // nothing to scrub through

  years.forEach(function (entry) {
    var tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = entry.year.length === 2 ? '20' + entry.year : entry.year;
    rail.appendChild(tick);
    entry.tick = tick;
  });

  function range() {                        // scrollable distance, never zero
    return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  }

  // Keep labels off the very edges: they are centred on their own position, so
  // an unclamped tick at 0 or 1 would sit half outside the viewport.
  function place(fraction) {
    var railHeight = rail.clientHeight;
    // The outer clamp only matters for a rail too short to inset into.
    return Math.max(0, Math.min(railHeight - 14, Math.max(14, fraction * railHeight)));
  }

  function measure() {
    var span = range();
    var lastPlaced = -Infinity;
    years.forEach(function (entry) {
      entry.top = entry.tile.getBoundingClientRect().top + window.scrollY;
      var y = place(Math.min(1, Math.max(0, entry.top / span)));
      entry.y = y;
      entry.tick.style.top = y + 'px';
      // Crowded years would overprint each other; drop the ones that collide.
      var room = y - lastPlaced >= 16;
      entry.tick.style.visibility = room ? '' : 'hidden';
      if (room) lastPlaced = y;
    });
    paint();
  }

  var current = null;

  function paint() {
    var probe = window.scrollY + 140;       // just under the sticky-ish header band
    var active = years[0];
    for (var i = 0; i < years.length; i++) {
      if (years[i].top <= probe) active = years[i];
    }
    bubble.style.top = place(window.scrollY / range()) + 'px';
    bubble.textContent = active.tick.textContent;
    if (active === current) return;
    if (current) current.tick.classList.remove('cur');
    active.tick.classList.add('cur');
    // A hidden tick is the one you are actually in: show it while it is current.
    current = active;
    years.forEach(function (entry) {
      if (entry === active && entry.tick.style.visibility === 'hidden') entry.tick.style.visibility = '';
    });
  }

  var hideTimer = null;

  function reveal() {
    scrub.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { scrub.classList.remove('on'); }, 1200);
  }

  function jump(ev) {
    var box = rail.getBoundingClientRect();
    var frac = Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height));
    window.scrollTo({ top: frac * range() });
    reveal();
  }

  var dragging = false;
  rail.addEventListener('pointerdown', function (ev) {
    dragging = true;
    rail.setPointerCapture(ev.pointerId);
    jump(ev);
    ev.preventDefault();                    // no text selection while dragging
  });
  rail.addEventListener('pointermove', function (ev) { if (dragging) jump(ev); });
  rail.addEventListener('pointerup', function () { dragging = false; });
  rail.addEventListener('pointercancel', function () { dragging = false; });

  var ticking = false;
  window.addEventListener('scroll', function () {
    reveal();
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; paint(); });
  }, { passive: true });

  var settle = null;
  window.addEventListener('resize', function () {
    clearTimeout(settle);
    settle = setTimeout(measure, 120);
  });
  // Lazy artwork keeps changing the page height under us, so remeasure as it lands.
  window.addEventListener('load', measure);
  grid.addEventListener('load', function () {
    clearTimeout(settle);
    settle = setTimeout(measure, 120);
  }, true);                                  // image loads don't bubble

  measure();
  reveal();
})();
`.trim();

/** Build the master page listing every archived year, newest first. */
export function renderMasterPage(byYear: Map<string, GameRecord[]>): string {
  const years = [...byYear.keys()].sort().reverse();
  const all = years.flatMap((y) => byYear.get(y)!);
  // Images live one directory down, under the year folder.
  const cards = years
    .map((y) => renderCards(byYear.get(y)!, `${encodeURIComponent(y)}/`, true))
    .join("\n");
  const oldest = years.length ? yearLabel(years[years.length - 1]!) : "";
  const newest = years.length ? yearLabel(years[0]!) : "";
  const span = oldest === newest ? oldest : `${oldest}–${newest}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Famicase Exhibition Archive</title>
<meta name="description" content="An unofficial, fan-made archive of My Famicase Exhibition, preserving ${all.length} imaginary Famicom cartridge labels across ${years.length} ${years.length === 1 ? "year" : "years"}${span ? ` (${esc(span)})` : ""} for personal reference and appreciation.">
<link rel="canonical" href="${BASE}/">
<meta property="og:type" content="website">
<meta property="og:title" content="My Famicase Exhibition Archive">
<meta property="og:description" content="An unofficial, fan-made archive of My Famicase Exhibition, preserving imaginary Famicom cartridge labels for personal reference and appreciation.">
<style>
${PAGE_CSS}
${MASTER_CSS}
</style>
${PRELOAD_THEME_JS}
</head>
<body>
  <div class="wrap">
    <header>
      <h1>My Famicase Exhibition Archive</h1>
      <p class="meta">${all.length} entries across ${years.length}
        ${years.length === 1 ? "year" : "years"}${span ? ` (${esc(span)})` : ""}
      <p class="meta credit">All artwork and text here belongs to the original
        <a href="${BASE}/">My Famicase Exhibition</a> and its contributing artists.
        This is an unofficial, non-commercial mirror kept for personal
        reference and preservation &mdash; not affiliated with the original site.
        Please visit and support the source at <a href="${BASE}/">famicase.com</a>.
        Non-English titles and descriptions include AI-generated translations,
        which may contain inaccuracies and may not fully capture the original
        artist's intent &mdash; when in doubt, refer to the original text.</p>
      <div class="tools">
        <button id="favs" type="button" aria-pressed="false" disabled>Favorites</button>
        <button id="favs-io" type="button">Import/export favorites</button>
        <button id="theme" type="button">Dark Theme</button>
        ${langToggle(all)}
        <span class="group" role="group" aria-label="Order">
          <button id="shuffle" type="button">Shuffle</button>
          <input id="seed" type="text" spellcheck="false" autocomplete="off"
            aria-label="Shuffle seed" placeholder="seed">
          <button id="reset" type="button" disabled>Reset</button>
        </span>
        <span id="status" role="status" class="sr-only"></span>
      </div>
    </header>
    <div class="grid" id="grid">
${cards}
    </div>
  </div>
  <div class="scrub" id="scrub" aria-hidden="true">
    <div class="rail"><span class="now"></span></div>
  </div>
<script>
${FAVORITES_JS}
${MASTER_JS}
${SCRUB_JS}
${LANG_JS}
${THEME_JS}
</script>
</body>
</html>
`;
}

/** Collect every year's index.json and write archive/index.html. */
export async function writeMasterPage(): Promise<void> {
  console.log(`\n=== master page ===`);
  const byYear = new Map<string, GameRecord[]>();

  const glob = new Bun.Glob("*/index.json");
  const found: string[] = [];
  for await (const rel of glob.scan({ cwd: ARCHIVE })) found.push(rel);
  found.sort();

  for (const rel of found) {
    const year = rel.slice(0, rel.indexOf("/"));
    try {
      byYear.set(year, (await Bun.file(`${ARCHIVE}${rel}`).json()) as GameRecord[]);
    } catch (err) {
      console.log(`  ! ${rel} unreadable: ${err}`);
    }
  }

  if (byYear.size === 0) {
    console.log("  no archived years found - archive a year first");
    return;
  }

  const path = `${ARCHIVE}index.html`;
  await Bun.write(path, renderMasterPage(byYear));
  const total = [...byYear.values()].reduce((n, recs) => n + recs.length, 0);
  const plural = byYear.size === 1 ? "year" : "years";
  console.log(`  page: ${path} (${total} entries, ${byYear.size} ${plural})`);
}

/** Write the year's page next to its images. */
async function writeYearPage(records: GameRecord[], year: string, outdir: string): Promise<void> {
  await Bun.write(`${outdir}/index.html`, renderYearPage(records, year));
  console.log(`  page: ${outdir}/index.html`);
}

// ---------------------------------------------------------------------------
// per-year driver
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function archiveYear(year: string, opts: Options): Promise<void> {
  const indexUrl = `${BASE}/${year}/index.html`;
  console.log(`\n=== ${indexUrl} ===`);

  let entries = await parseIndex(await fetchText(indexUrl));
  if (entries.length === 0) {
    console.log("  no entries found - check the year");
    return;
  }
  console.log(`  ${entries.length} entries`);

  // Some years mix id widths (2015: 01..99 then 100..149). Pad to a uniform
  // width so filenames sort in exhibition order; source_url keeps the truth.
  const width = Math.max(...entries.map(([id]) => id.length));
  entries = entries.map(([id, href]) => [id.padStart(width, "0"), href]);

  const outdir = `${ARCHIVE}${year}`;
  const manifestPath = `${outdir}/_manifest.json`;
  const existing = new Map<string, AssetInfo>();

  if (!opts.dryRun) {
    const manifest = Bun.file(manifestPath);
    if (await manifest.exists()) {
      try {
        const prior = (await manifest.json()) as { entries?: GameRecord[] };
        for (const rec of prior.entries ?? []) {
          for (const asset of [rec.image, rec.logo]) {
            if (asset?.file) existing.set(asset.file, asset);
          }
        }
      } catch {
        // an unreadable manifest just means nothing gets skipped
      }
    }
    await $`mkdir -p ${outdir}`.quiet();
  }

  const failures: Array<{ id: string; url: string; error: string }> = [];
  const progress = new Progress(entries.length, opts.dryRun ? "scanned" : "archived");

  const results = await mapPool(entries, MAX_WORKERS, async ([id, href]) => {
    const pageUrl = new URL(href, indexUrl).href;
    try {
      const rec = await archiveEntry(id, pageUrl, year, outdir, existing, opts, progress);
      // Count only bytes actually pulled over the network, so a resumed run
      // honestly reports how little it transferred.
      const bytes =
        (rec.image?.skipped ? 0 : (rec.image?.bytes ?? 0)) +
        (rec.logo?.skipped ? 0 : (rec.logo?.bytes ?? 0));
      progress.complete({ skipped: Boolean(rec.image?.skipped), bytes });
      return rec;
    } catch (err) {
      failures.push({ id, url: pageUrl, error: String(err) });
      progress.note(`  ! ${id} failed: ${err}`);
      progress.complete({ skipped: false, bytes: 0 });
      return null;
    }
  });
  progress.finish();

  const records = results.filter((r): r is GameRecord => r !== null);
  records.sort((a, b) => a.id.localeCompare(b.id));

  // Translate before writing, so index.json, the manifest and the page all
  // carry the same records. Sidecars were written during the fetch, so any
  // record that gained a translation needs its sidecar refreshed.
  if (opts.translate && !opts.dryRun) {
    const changed = await translateRecords(records);
    if (changed) {
      for (const rec of records) {
        if (rec.en) await writeSidecar(rec, outdir, opts);
      }
    }
  }

  if (opts.dryRun) {
    console.log(`  dry run: ${records.length} filenames planned, nothing written`);
    return;
  }

  await Bun.write(`${outdir}/index.json`, JSON.stringify(records, null, 2) + "\n");
  await Bun.write(
    manifestPath,
    JSON.stringify(
      {
        year,
        index_url: indexUrl,
        run_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        entry_count: records.length,
        entries: records,
        failures,
      },
      null,
      2,
    ) + "\n",
  );

  await writeYearPage(records, year, outdir);

  if (opts.embed) await embedMetadata(records, outdir);

  console.log(`  done: ${records.length} archived, ${failures.length} failed -> ${outdir}`);
}

/**
 * Forget the AVIF renditions, so the page renders plain <img> tags against the
 * originals. The files stay on disk; this only drops them from these in-memory
 * records, which is what `--no-avif` means on a path that renders rather than
 * downloads.
 */
function stripAvif(records: GameRecord[]): void {
  for (const rec of records) {
    delete rec.image?.avif;
    delete rec.logo?.avif;
  }
}

/** Rebuild a year's page from its existing index.json, without any network. */
export async function rebuildYearPage(year: string, opts: Options): Promise<void> {
  const outdir = `${ARCHIVE}${year}`;
  const index = Bun.file(`${outdir}/index.json`);
  console.log(`\n=== ${year} (html only) ===`);
  if (!(await index.exists())) {
    console.log(`  no index.json in ${outdir} - archive the year first`);
    return;
  }
  const records = (await index.json()) as GameRecord[];
  if (!opts.avif) stripAvif(records);
  await writeYearPage(records, year, outdir);
  console.log(`  done: ${records.length} entries rendered`);
}

/**
 * Convert a year already on disk to AVIF, then rewrite its JSON, sidecars and
 * page. No network at all: this is the backfill path for the years that were
 * archived before AVIF existed, and the way to re-encode after changing a
 * preset. `_manifest.json` is left alone on purpose - it is a log of a scrape
 * run, and this run scraped nothing.
 *
 * Encoding is CPU-bound rather than network-bound, so it runs a wider pool than
 * the scraper's MAX_WORKERS. libvips threads each encode internally and
 * saturates the machine at any pool size past a handful, so this is deliberately
 * modest: the win is keeping the cores fed across the per-file I/O, not piling
 * up concurrent encodes.
 */
const AVIF_WORKERS = 8;

export async function avifYear(year: string, opts: Options): Promise<void> {
  const outdir = `${ARCHIVE}${year}`;
  const index = Bun.file(`${outdir}/index.json`);
  console.log(`\n=== ${year} (avif only) ===`);
  if (!(await index.exists())) {
    console.log(`  no index.json in ${outdir} - archive the year first`);
    return;
  }
  const records = (await index.json()) as GameRecord[];

  if (!opts.avif) {
    console.log("  --avif-only with --no-avif does nothing");
    return;
  }

  // One work item per asset, not per record, so a record with both art and a
  // logo does not serialise the two behind each other.
  const jobs: Array<{ rec: GameRecord; asset: AssetInfo; preset: AvifPreset }> = [];
  for (const rec of records) {
    if (rec.image?.file) jobs.push({ rec, asset: rec.image, preset: AVIF_ART });
    if (rec.logo?.file) jobs.push({ rec, asset: rec.logo, preset: AVIF_LOGO });
  }

  const progress = new Progress(jobs.length, "converted");
  const touched = new Set<GameRecord>();
  let srcBytes = 0;
  let avifBytes = 0;
  let reused = 0;
  let dropped = 0;
  let failed = 0;

  await mapPool(jobs, AVIF_WORKERS, async ({ rec, asset, preset }) => {
    progress.setCurrent(asset.file);
    const src = Bun.file(`${outdir}/${asset.file}`);
    try {
      if (!(await src.exists())) {
        progress.note(`  ! ${asset.file} missing on disk`);
        failed++;
        progress.complete({ skipped: true, bytes: 0 });
        return;
      }
      const data = await src.bytes();

      // Reuse an existing sibling: this makes the whole command cheap to re-run
      // and safe to point at a year that is already converted.
      const prior = asset.avif;
      if (prior && (await Bun.file(`${outdir}/${prior.file}`).exists())) {
        reused++;
        srcBytes += data.length;
        avifBytes += prior.bytes;
        progress.complete({ skipped: true, bytes: 0 });
        return;
      }

      const info = await encodeAvif(data, outdir, asset.file, preset);
      if (info) {
        asset.avif = info;
        srcBytes += data.length;
        avifBytes += info.bytes;
      } else {
        delete asset.avif;
        dropped++;
      }
      touched.add(rec);
      progress.complete({ skipped: false, bytes: info?.bytes ?? 0 });
    } catch (err) {
      progress.note(`  ! ${asset.file} failed: ${err}`);
      failed++;
      progress.complete({ skipped: true, bytes: 0 });
    }
  });
  progress.finish();

  await Bun.write(`${outdir}/index.json`, JSON.stringify(records, null, 2) + "\n");
  // Sidecars carry the per-asset info too, so they drift if left behind. Only
  // the records that actually changed need rewriting.
  let missing = 0;
  for (const rec of touched) {
    if (!(await writeSidecar(rec, outdir, opts, true))) missing++;
  }
  if (missing) {
    console.log(`  ! ${missing} sidecar(s) not found - re-run without --plain-names mismatch`);
  }

  await writeYearPage(records, year, outdir);

  const pct = srcBytes ? ((avifBytes / srcBytes) * 100).toFixed(1) : "0";
  console.log(
    `  done: ${jobs.length} assets (${reused} reused, ${dropped} not smaller, ${failed} failed)`,
  );
  console.log(`  ${fmtBytes(srcBytes)} originals -> ${fmtBytes(avifBytes)} avif (${pct}%)`);
}

/**
 * Translate a year already on disk, then rewrite its JSON and page. No network
 * beyond the Claude CLI, so this is the cheap loop for iterating on wording.
 * `_manifest.json` is left alone on purpose: it is a log of a scrape run.
 */
export async function translateYear(year: string, opts: Options): Promise<void> {
  const outdir = `${ARCHIVE}${year}`;
  const index = Bun.file(`${outdir}/index.json`);
  console.log(`\n=== ${year} (translate only) ===`);
  if (!(await index.exists())) {
    console.log(`  no index.json in ${outdir} - archive the year first`);
    return;
  }
  const records = (await index.json()) as GameRecord[];

  // Only rewrite the records when something actually changed, but always
  // re-render the page, so it can never drift from the index it is built from.
  if (await translateRecords(records)) {
    await Bun.write(`${outdir}/index.json`, JSON.stringify(records, null, 2) + "\n");
    let missing = 0;
    for (const rec of records) {
      if (rec.en && !(await writeSidecar(rec, outdir, opts, true))) missing++;
    }
    if (missing) {
      console.log(`  ! ${missing} sidecar(s) not found - re-run without --plain-names mismatch`);
    }
  }
  await writeYearPage(records, year, outdir);
  console.log(`  done: ${records.length} entries rendered`);
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

const USAGE = `Usage: bun run famicase-archive.ts <year...> [options]

  <year...>        two-digit site years, e.g. 26 25 15

  --embed          also write XMP/IPTC into the JPEGs via exiftool
  --dry-run        print planned filenames without downloading images
  --plain-names    use bare NNN.jpg instead of "NNN - Title.jpg"
  --translate      also translate the non-English entries to English
  --translate-only translate an existing index.json in place, no scraping
  --html-only      rebuild index.html from an existing index.json, no network
  --no-avif        skip AVIF conversion; the page then loads the JPEGs
  --avif-only      convert an already-archived year to AVIF, no scraping
  --master         rebuild archive/index.html across all archived years
  --help           show this message

  --master may be used on its own, with no years.

  Downloads are kept as-is and an AVIF sibling is written beside each one for
  the page to serve, which runs about 6-7% of the original bytes at visually
  matched quality. The page uses <picture>, so the original JPEG stays the
  fallback. Re-runs reuse siblings that are already on disk, so only genuinely
  new or changed assets are encoded.

  Translation shells out to the Claude CLI (\`claude\`), so it bills to whatever
  subscription that CLI is logged in with. Results are cached in index.json and
  keyed by the source text, so re-running never re-translates.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      embed: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "plain-names": { type: "boolean", default: false },
      translate: { type: "boolean", default: false },
      "translate-only": { type: "boolean", default: false },
      "html-only": { type: "boolean", default: false },
      // Negated flag: AVIF is the default, so this only ever turns it off.
      "no-avif": { type: "boolean", default: false },
      "avif-only": { type: "boolean", default: false },
      master: { type: "boolean", default: false },
      help: { type: "boolean", default: false, short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || (positionals.length === 0 && !values.master)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  if (positionals.length === 0) {
    await writeMasterPage();
    return 0;
  }

  const opts: Options = {
    embed: values.embed,
    dryRun: values["dry-run"],
    plainNames: values["plain-names"],
    translate: values.translate,
    avif: !values["no-avif"],
  };

  for (const year of positionals) {
    try {
      if (values["translate-only"]) await translateYear(year, opts);
      else if (values["avif-only"]) await avifYear(year, opts);
      else if (values["html-only"]) await rebuildYearPage(year, opts);
      else await archiveYear(year, opts);
    } catch (err) {
      console.error(`  year ${year} failed: ${err}`);
      return 1;
    }
  }

  // The master page spans every year on disk, so refresh it after any run.
  if (!values["dry-run"]) await writeMasterPage();
  return 0;
}

if (import.meta.main) process.exit(await main());
