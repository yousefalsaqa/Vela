import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { present } from "./screen.js";
import { SCREEN_DIR } from "./paths.js";

/**
 * A picture card: the real photograph of a thing, and the few facts about it
 * that matter, on her screen in seconds.
 *
 * show_screen can already draw anything, but it draws by writing a page, and
 * a page is a few hundred lines of output — tens of seconds of her typing
 * before he sees a thing. For the commonest case, "tell me about <some famous
 * project>", the picture already exists. This fetches it, and the summary
 * beside it, from Wikipedia, and lays them out from a fixed template; all she
 * writes is the subject and whatever facts she wants under it.
 *
 * The card is written to a file and shown like any other screen, so it gets
 * the same sandbox and the same scoped key. The photograph is inlined as a
 * data: URI, because the page's requests carry nothing and could not load it.
 */

export interface Fact {
  label: string;
  value: string;
}

export interface Moment {
  when: string;
  what: string;
}

export interface Card {
  title: string;
  /** A short line under the title: what kind of thing this is. */
  kicker?: string;
  /** A paragraph about it. */
  summary?: string;
  /** The photograph, as a data: URI. */
  image?: string;
  facts: Fact[];
  timeline: Moment[];
  caption?: string;
  /** Where the words and the picture came from, for the line at the bottom. */
  source?: string;
}

/** What Wikipedia says about a subject, cut down to what a card uses. */
export interface Summary {
  title: string;
  description?: string;
  extract?: string;
  page?: string;
  image?: string;
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/**
 * Wikimedia asks every client to name itself, and refuses some that do not.
 * Deliberately without his address: the API does not need to know who he is.
 */
const HEADERS = { "user-agent": "Vela-assistant (personal use)", accept: "application/json" };

/**
 * Wikimedia serves thumbnails only at standard widths now: 960 and 1280 load,
 * 1000 comes back 400. 960 is wider than the stage ever is.
 */
const THUMB_WIDTH = 960;
const LARGEST_ORIGINAL = 1280;
/** Larger than any photograph worth inlining into a page. */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;

/** The best picture in a summary, at a size worth fetching. */
export function bestImage(data: {
  thumbnail?: { source?: string };
  originalimage?: { source?: string; width?: number };
}): string | undefined {
  const original = data.originalimage;
  if (original?.source && (original.width ?? Infinity) <= LARGEST_ORIGINAL) return original.source;
  const thumb = data.thumbnail?.source;
  if (thumb) return thumb.replace(/\/\d+px-/, `/${THUMB_WIDTH}px-`);
  return original?.source;
}

/**
 * Find a subject on Wikipedia: the article by that title, or failing that the
 * first one a title search finds. Null when there is nothing. A disambiguation
 * page is thrown, with the fix in the message, because a card of "Mercury may
 * refer to" is worse than asking.
 */
export async function lookUp(subject: string, fetcher: Fetcher = fetch): Promise<Summary | null> {
  const summary = async (title: string): Promise<Summary | null> => {
    const res = await fetcher(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`,
      { headers: HEADERS },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      type?: string;
      title?: string;
      description?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
      thumbnail?: { source?: string };
      originalimage?: { source?: string; width?: number };
    };
    if (data.type === "disambiguation") {
      throw new Error(
        `Wikipedia has several things called "${data.title ?? title}". Give the full article title, ` +
          `e.g. "Mercury (planet)" rather than "Mercury".`,
      );
    }
    if (!data.title) return null;
    return {
      title: data.title,
      ...(data.description ? { description: data.description } : {}),
      ...(data.extract ? { extract: data.extract } : {}),
      ...(data.content_urls?.desktop?.page ? { page: data.content_urls.desktop.page } : {}),
      ...(bestImage(data) ? { image: bestImage(data) } : {}),
    };
  };

  const direct = await summary(subject.trim());
  if (direct) return direct;
  const res = await fetcher(
    `https://en.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(subject.trim())}&limit=1`,
    { headers: HEADERS },
  );
  if (!res.ok) return null;
  const found = (await res.json()) as { pages?: { key?: string }[] };
  const key = found.pages?.[0]?.key;
  return key ? summary(key) : null;
}

/** Fetch an image and hand it back as a data: URI. Null for anything that is not one. */
export async function inlineImage(url: string, fetcher: Fetcher = fetch): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const res = await fetcher(url, { headers: { "user-agent": HEADERS["user-agent"] } });
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return null;
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/** Everything that goes into the page goes through this. Wikipedia's words are not ours. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The card, as a self-contained page in her colours. */
export function pictureCard(card: Card): string {
  const facts = card.facts
    .map((f, i) => `<div class="fact" style="--i:${i}"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`)
    .join("");
  const timeline = card.timeline
    .map((m, i) => `<li style="--i:${i}"><span class="when">${esc(m.when)}</span><span class="what">${esc(m.what)}</span></li>`)
    .join("");
  // A data: URI is safe in an attribute once escaped; nothing in base64 needs
  // it, but the media type came from a server.
  const picture = card.image
    ? `<figure class="photo"><img src="${esc(card.image)}" alt="${esc(card.title)}">${
        card.caption ? `<figcaption>${esc(card.caption)}</figcaption>` : ""
      }</figure>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(card.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root { --bg:#05090d; --ink:#eef5f8; --dim:#8a9aa3; --faint:#3a4a53; --cyan:#4fd1db; --gold:#f5b95f;
  --serif:"Instrument Serif", Georgia, serif; --mono:"JetBrains Mono", Consolas, monospace; }
* { box-sizing: border-box; margin: 0; }
html, body { background: var(--bg); color: var(--ink); height: 100%; }
body { font: 400 14px/1.6 var(--mono); padding: clamp(16px, 3vw, 36px); overflow: auto; }
.card { display: grid; grid-template-columns: ${picture ? "minmax(0, 1.1fr) minmax(0, 1fr)" : "minmax(0, 1fr)"}; gap: clamp(18px, 3vw, 40px); align-items: start; max-width: 1200px; margin: 0 auto; }
@media (max-width: 760px) { .card { grid-template-columns: minmax(0, 1fr); } }
.photo { position: sticky; top: 0; animation: settle .9s cubic-bezier(.2,.7,.2,1) both; }
.photo img { display: block; width: 100%; max-height: 78vh; object-fit: contain; border-radius: 6px; background: #0b1218; }
.photo figcaption { margin-top: .6rem; color: var(--dim); font-size: .72rem; letter-spacing: .04em; }
.kicker { color: var(--cyan); font: 500 .68rem/1.4 var(--mono); letter-spacing: .14em; text-transform: uppercase; animation: rise .6s .05s both; }
h1 { font: 400 clamp(2rem, 4.2vw, 3.4rem)/1.05 var(--serif); margin: .35rem 0 1rem; animation: rise .6s .1s both; }
.summary { color: #c9d6dc; max-width: 62ch; animation: rise .6s .18s both; }
dl { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .9rem 1.4rem; margin: 1.6rem 0 0; }
.fact { border-top: 1px solid var(--faint); padding-top: .55rem; animation: rise .5s calc(.28s + var(--i) * .06s) both; }
dt { color: var(--dim); font-size: .64rem; letter-spacing: .12em; text-transform: uppercase; }
dd { font: 400 1.25rem/1.25 var(--serif); margin-top: .2rem; }
ol { list-style: none; padding: 0; margin: 1.8rem 0 0; border-left: 1px solid var(--faint); }
li { position: relative; padding: 0 0 .9rem 1.2rem; animation: rise .5s calc(.4s + var(--i) * .07s) both; }
li::before { content: ""; position: absolute; left: -4px; top: .5em; width: 7px; height: 7px; border-radius: 50%; background: var(--gold); }
.when { display: block; color: var(--gold); font-size: .72rem; letter-spacing: .06em; }
.what { color: #c9d6dc; }
.source { margin-top: 1.8rem; color: var(--faint); font-size: .66rem; letter-spacing: .06em; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes settle { from { opacity: 0; transform: scale(.985); filter: blur(6px); } to { opacity: 1; transform: none; filter: none; } }
</style></head>
<body><main class="card">
${picture}
<section>
${card.kicker ? `<p class="kicker">${esc(card.kicker)}</p>` : ""}
<h1>${esc(card.title)}</h1>
${card.summary ? `<p class="summary">${esc(card.summary)}</p>` : ""}
${facts ? `<dl>${facts}</dl>` : ""}
${timeline ? `<ol>${timeline}</ol>` : ""}
${card.source ? `<p class="source">${esc(card.source)}</p>` : ""}
</section>
</main></body></html>
`;
}

/** The first couple of sentences, for her to speak from. */
export function gist(text: string, sentences = 2): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  return (parts ? parts.slice(0, sentences).join("") : text).trim();
}

const MOST = 8;

/**
 * Look the subject up, build the card, put it on the screen. Every failure is
 * a sentence for the model, never a throw, and a failure to find a photo is
 * not a failure: the card goes up with words, and she is told it has none.
 */
export async function showPicture(
  spec: {
    subject: string;
    title?: string;
    facts?: Fact[];
    timeline?: Moment[];
    imageUrl?: string;
    caption?: string;
  },
  deps: { fetcher?: Fetcher; dir?: string } = {},
): Promise<string> {
  const fetcher = deps.fetcher ?? fetch;
  let found: Summary | null = null;
  try {
    found = await lookUp(spec.subject, fetcher);
  } catch (err) {
    const why = (err as Error).message;
    // A disambiguation is the one refusal worth passing on whole.
    if (why.startsWith("Wikipedia has several")) return why;
    found = null;
  }
  if (!found && !spec.imageUrl && !spec.facts?.length) {
    return (
      `Wikipedia has nothing called "${spec.subject}", and there was no image_url or facts to make a card from. ` +
      `Try its exact article title, or pass image_url with a picture you found.`
    );
  }

  const imageFrom = spec.imageUrl ?? found?.image;
  const image = imageFrom ? await inlineImage(imageFrom, fetcher).catch(() => null) : null;
  const title = spec.title ?? found?.title ?? spec.subject;
  const card: Card = {
    title,
    ...(found?.description ? { kicker: found.description } : {}),
    ...(found?.extract ? { summary: found.extract } : {}),
    ...(image ? { image } : {}),
    facts: (spec.facts ?? []).slice(0, MOST),
    timeline: (spec.timeline ?? []).slice(0, MOST),
    ...(spec.caption ? { caption: spec.caption } : {}),
    ...(found ? { source: `Wikipedia · ${found.page ?? found.title}` } : {}),
  };

  const dir = deps.dir ?? SCREEN_DIR;
  mkdirSync(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const path = join(dir, `picture-${slug || "card"}-${randomBytes(3).toString("hex")}.html`);
  writeFileSync(path, pictureCard(card));
  const shown = present({ title, path, ...(found?.description ? { note: found.description } : {}) });

  const notes = [
    shown,
    image ? "" : imageFrom ? "The photo would not load, so the card has words only." : "There is no photo for it on Wikipedia; the card has words only.",
    found?.extract ? `Wikipedia: ${gist(found.extract)}` : "",
  ].filter(Boolean);
  return notes.join(" ");
}
