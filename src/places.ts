import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./paths.js";
import { placesKey, ratedAround, samePlace, goodness, priceSigns, type Rated } from "./ratings.js";

/**
 * Places near him, and the live map she shows them on.
 *
 * Asked where to eat, she used to grep his own projects and answer from two
 * clients' opening hours, because nothing told her where he lived or gave her
 * a way to look anything up. This is that way: OpenStreetMap for what is
 * where and when it opens, his home for what "near" means, and one map that
 * stays up and is moved rather than redrawn — "expand the search" zooms the
 * same map out, "go further down" slides it along the street he is looking at.
 *
 * Everything here is data and arithmetic; the page that draws it is map.html,
 * and it is told about changes, never rebuilt by them.
 */

export interface Point {
  lat: number;
  lon: number;
}

/** A place as Google sees it, put on the map because OpenStreetMap missed it. */
function fromRated(r: Rated, home: Point): MapPlace {
  const distanceM = Math.round(metresBetween(home, r));
  return {
    id: `g:${r.gid}`,
    name: r.name,
    kind: r.kind ?? "Place",
    lat: r.lat,
    lon: r.lon,
    walkMin: walkMinutes(distanceM),
    distanceM,
    status: { open: null, label: "Hours not listed" },
    ...(r.address ? { address: r.address } : {}),
  };
}

/**
 * A place with Google's rating on it. Google's open-now fills in where
 * OpenStreetMap has no hours; where it has them, they stay, because they are
 * the ones the card can show.
 */
function withRating(p: MapPlace, r: Rated): MapPlace {
  if (r.rating !== undefined) p.rating = r.rating;
  if (r.reviews !== undefined) p.reviews = r.reviews;
  if (r.price) p.price = r.price;
  if (r.mapsUrl) p.mapsUrl = r.mapsUrl;
  if (p.status.open === null && r.openNow !== undefined) {
    p.status = { open: r.openNow, label: r.openNow ? "Open now" : "Closed now" };
  }
  return p;
}

export interface Home extends Point {
  label: string;
  city?: string;
}

type Tags = Record<string, string>;

/** One place as the cache holds it: what OpenStreetMap says, nothing derived. */
export interface Spot extends Point {
  id: string;
  name: string;
  tags: Tags;
}

export interface PlaceStatus {
  /** True open, false closed, null when the hours are missing or unreadable. */
  open: boolean | null;
  /** What the page prints: "Open · till 11 pm", "Closed · opens 4 pm". */
  label: string;
  /** Today's hours in words, for the card. */
  today?: string;
}

/** One place as the page draws it: measured from his door, judged against now. */
export interface MapPlace extends Point {
  id: string;
  name: string;
  kind: string;
  cuisine?: string;
  address?: string;
  walkMin: number;
  distanceM: number;
  status: PlaceStatus;
  phone?: string;
  website?: string;
  /** Google's, when the area has been rated. See ratings.ts. */
  rating?: number;
  reviews?: number;
  /** 1 to 4, as dollar signs. */
  price?: number;
  mapsUrl?: string;
}

export interface MapState {
  /** Bumped on every change, so the page can tell a move from a repeat. */
  seq: number;
  title: string;
  subtitle: string;
  home: Home;
  center: Point;
  radiusM: number;
  places: MapPlace[];
  focus: string | null;
  /** The street he is looking along, drawn faintly, or null. */
  street: Point[] | null;
  updatedAt: number;
}

/* ══════════════════════════════════════════════════════════════════════════
   What counts as what
   ══════════════════════════════════════════════════════════════════════════ */

export type Kind =
  | "food"
  | "restaurant"
  | "fast_food"
  | "cafe"
  | "bar"
  | "dessert"
  | "groceries"
  | "pharmacy";

const amenity = (...values: string[]) => (t: Tags) => values.includes(t.amenity ?? "");
const shop = (...values: string[]) => (t: Tags) => values.includes(t.shop ?? "");
const either =
  (...tests: ((t: Tags) => boolean)[]) =>
  (t: Tags) =>
    tests.some((test) => test(t));

export const KINDS: Record<Kind, { title: string; match: (t: Tags) => boolean }> = {
  food: { title: "Food", match: amenity("restaurant", "fast_food", "cafe", "food_court", "pub") },
  restaurant: { title: "Restaurants", match: amenity("restaurant") },
  fast_food: { title: "Quick food", match: amenity("fast_food", "food_court") },
  cafe: { title: "Cafés", match: amenity("cafe") },
  bar: { title: "Bars", match: amenity("bar", "pub", "biergarten") },
  dessert: {
    title: "Something sweet",
    match: either(amenity("ice_cream"), shop("bakery", "pastry", "confectionery", "chocolate")),
  },
  groceries: { title: "Groceries", match: shop("supermarket", "convenience", "greengrocer", "grocery") },
  pharmacy: { title: "Pharmacies", match: either(amenity("pharmacy"), shop("chemist")) },
};

/** Every tag value the kinds above use, so one cached query answers all of them. */
const AMENITIES = "restaurant|fast_food|cafe|food_court|pub|bar|biergarten|ice_cream|pharmacy";
const SHOPS = "bakery|pastry|confectionery|chocolate|supermarket|convenience|greengrocer|grocery|chemist";

const KIND_WORDS: Record<string, string> = {
  restaurant: "Restaurant",
  fast_food: "Fast food",
  cafe: "Café",
  food_court: "Food court",
  pub: "Pub",
  bar: "Bar",
  biergarten: "Beer garden",
  ice_cream: "Ice cream",
  pharmacy: "Pharmacy",
  bakery: "Bakery",
  pastry: "Pastry",
  confectionery: "Sweets",
  chocolate: "Chocolate",
  supermarket: "Supermarket",
  convenience: "Convenience",
  greengrocer: "Greengrocer",
  grocery: "Grocery",
  chemist: "Chemist",
};

/* ══════════════════════════════════════════════════════════════════════════
   Distance
   ══════════════════════════════════════════════════════════════════════════ */

export function metresBetween(a: Point, b: Point): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/**
 * Minutes on foot. Straight-line distance undersells a walk through a street
 * grid by about a quarter, and 80 m a minute is an unhurried 4.8 km/h.
 */
export const WALK_M_PER_MIN = 80;
export const DETOUR = 1.25;
export const walkMinutes = (metres: number) => Math.max(1, Math.round((metres * DETOUR) / WALK_M_PER_MIN));
/** The straight-line radius a walk of this many minutes covers. */
export const walkRadius = (minutes: number) => (minutes * WALK_M_PER_MIN) / DETOUR;

/* ══════════════════════════════════════════════════════════════════════════
   Opening hours

   OpenStreetMap's opening_hours is a whole language. This reads the part of
   it Kingston actually uses — measured, 70 of 182 places near him carry it —
   and says "unclear" for anything else rather than guess, because a map that
   says a place is open when it is shut is worse than one that shrugs.
   ══════════════════════════════════════════════════════════════════════════ */

/** Minutes from the start of a day. An end past 1440 runs into the next day. */
type Range = [number, number];

interface Rule {
  days: number[];
  ranges: Range[];
  off: boolean;
  /** "," before it: adds to the days it names. ";" before it: replaces them. */
  additive: boolean;
}

/** A week of hours: index 0 is Sunday, as Date.getDay() counts. */
export type Week = Range[][];

const DAY_CODES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Token =
  | { t: "days"; days: number[] }
  | { t: "holiday" }
  | { t: "time"; range: Range }
  | { t: "off" }
  | { t: "comma" }
  | { t: "semi" };

function dayRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; ; d = (d + 1) % 7) {
    out.push(d);
    if (d === to) return out;
  }
}

function lex(spec: string): Token[] | null {
  const out: Token[] = [];
  let rest = spec;
  const eat = (re: RegExp) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };
  while (rest.length) {
    let m: RegExpExecArray | null;
    if (eat(/^\s+/)) continue;
    if (eat(/^;/)) out.push({ t: "semi" });
    else if (eat(/^,/)) out.push({ t: "comma" });
    else if ((m = eat(/^(Su|Mo|Tu|We|Th|Fr|Sa)(?:-(Su|Mo|Tu|We|Th|Fr|Sa))?(?![a-zA-Z[])/))) {
      const from = DAY_CODES.indexOf(m[1]);
      out.push({ t: "days", days: m[2] ? dayRange(from, DAY_CODES.indexOf(m[2])) : [from] });
    } else if (eat(/^(PH|SH)(?![a-zA-Z])/)) out.push({ t: "holiday" });
    else if ((m = eat(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?!\+)/))) {
      const start = Number(m[1]) * 60 + Number(m[2]);
      let end = Number(m[3]) * 60 + Number(m[4]);
      if (start > 1440 || end > 1440 || Number(m[2]) > 59 || Number(m[4]) > 59) return null;
      if (end <= start) end += 1440;
      out.push({ t: "time", range: [start, end] });
    } else if ((m = eat(/^(\d{1,2}):(\d{2})\+/))) {
      out.push({ t: "time", range: [Number(m[1]) * 60 + Number(m[2]), Infinity] });
    } else if (eat(/^(off|closed)(?![a-zA-Z])/i)) out.push({ t: "off" });
    else return null;
  }
  return out;
}

/** Read an opening_hours value into a week, or null if it says something this cannot. */
export function parseHours(spec: string | undefined): Week | null {
  const s = (spec ?? "").trim();
  if (!s) return null;
  if (s === "24/7") return Array.from({ length: 7 }, () => [[0, 1440] as Range]);
  const tokens = lex(s);
  if (!tokens) return null;

  const rules: Rule[] = [];
  let rule: Rule = { days: [], ranges: [], off: false, additive: false };
  let holiday = false;
  const close = () => {
    const said = rule.ranges.length > 0 || rule.off;
    if (!said && !rule.days.length && !holiday) return true;
    if (!said) return false; // days with nothing after them
    // A rule for holidays alone says nothing about an ordinary week.
    if (holiday && !rule.days.length) return true;
    if (!rule.days.length) rule.days = [0, 1, 2, 3, 4, 5, 6];
    rules.push(rule);
    return true;
  };
  for (const tok of tokens) {
    if (tok.t === "semi") {
      if (!close()) return null;
      rule = { days: [], ranges: [], off: false, additive: false };
      holiday = false;
    } else if (tok.t === "days" || tok.t === "holiday") {
      if (rule.ranges.length || rule.off) {
        // A day after times can only follow a comma: an additional rule.
        if (!close()) return null;
        rule = { days: [], ranges: [], off: false, additive: true };
        holiday = false;
      }
      if (tok.t === "days") rule.days.push(...tok.days);
      else holiday = true;
    } else if (tok.t === "time") {
      if (rule.off) return null;
      rule.ranges.push(tok.range);
    } else if (tok.t === "off") {
      if (rule.ranges.length) return null;
      rule.off = true;
    }
  }
  if (!close()) return null;
  if (!rules.length) return null;

  const week: Week = Array.from({ length: 7 }, () => []);
  const named = new Set<number>();
  for (const r of rules) {
    for (const d of new Set(r.days)) {
      const add = r.off ? [] : r.ranges.map((x) => [...x] as Range);
      week[d] = r.additive && named.has(d) && !r.off ? [...week[d], ...add] : add;
      named.add(d);
    }
  }
  return week;
}

const clockWords = (mins: number): string => {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h === 0 && mm === 0) return "midnight";
  if (h === 12 && mm === 0) return "noon";
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
};

const rangeWords = ([from, to]: Range) =>
  from === 0 && to >= 1440 && to !== Infinity
    ? "open 24 hours"
    : `${clockWords(from)} – ${to === Infinity ? "late" : clockWords(to)}`;

/** Open or shut at this moment, and what to say about it. */
export function statusAt(spec: string | undefined, now: Date): PlaceStatus {
  if (!(spec ?? "").trim()) return { open: null, label: "Hours not listed" };
  const week = parseHours(spec);
  if (!week) return { open: null, label: "Hours unclear" };

  const day = now.getDay();
  const minute = now.getHours() * 60 + now.getMinutes();
  const todays = week[day];
  const today = todays.length ? todays.map(rangeWords).join(", ") : "closed today";

  if (week.every((ranges) => ranges.some(([a, b]) => a === 0 && b >= 1440))) {
    return { open: true, label: "Open 24 hours", today: "open 24 hours" };
  }

  // Open now: inside one of today's ranges, or inside last night's run past midnight.
  const inToday = todays.find(([a, b]) => a <= minute && minute < b);
  const yesterday = week[(day + 6) % 7].find(([, b]) => b > 1440 && b !== Infinity && minute < b - 1440);
  if (inToday || yesterday) {
    const end = inToday ? inToday[1] : yesterday![1] - 1440;
    if (end === Infinity) return { open: true, label: "Open · closing time not listed", today };
    if (inToday && inToday[0] === 0 && end >= 1440) return { open: true, label: "Open all day", today };
    return { open: true, label: `Open · till ${clockWords(end)}`, today };
  }

  // Shut: say when it next opens, within the week.
  for (let ahead = 0; ahead < 7; ahead++) {
    const ranges = week[(day + ahead) % 7]
      .map(([a]) => a)
      .filter((a) => ahead > 0 || a > minute)
      .sort((x, y) => x - y);
    if (!ranges.length) continue;
    const when = clockWords(ranges[0]);
    const which = ahead === 0 ? "" : ahead === 1 ? "tomorrow " : `${DAY_NAMES[(day + ahead) % 7]} `;
    return { open: false, label: `Closed · opens ${which}${when}`, today };
  }
  return { open: false, label: "Closed", today };
}

/* ══════════════════════════════════════════════════════════════════════════
   OpenStreetMap
   ══════════════════════════════════════════════════════════════════════════ */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "Vela personal assistant (local, one user)";

/**
 * Two public Overpass servers, tried in order. The main one sheds load with a
 * 429 at busy times, and a second server is the difference between a slow
 * answer and none. Measured 2026-09-30: kumi.systems and private.coffee hung
 * for the full timeout, which is worse than failing, so they are not here.
 */
export const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];

/**
 * The box around a circle, as Overpass wants it: south, west, north, east.
 *
 * A box, not "around": measured on the same 3.5 km of Kingston, around took
 * 14.8s and the box 2.6s. The corners it adds are filtered out afterwards.
 */
export function boxAround(center: Point, radiusM: number): string {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  return [center.lat - dLat, center.lon - dLon, center.lat + dLat, center.lon + dLon].map((n) => n.toFixed(6)).join(",");
}

export function overpassQuery(center: Point, radiusM: number, timeoutS = 20): string {
  const around = `(${boxAround(center, radiusM)})`;
  return (
    `[out:json][timeout:${timeoutS}];(` +
    `nwr["amenity"~"^(${AMENITIES})$"]${around};` +
    `nwr["shop"~"^(${SHOPS})$"]${around};` +
    `);out center tags qt;`
  );
}

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: Point;
  tags?: Tags;
  geometry?: Point[];
}

/** What came back, reduced to named places with a position. */
export function spotsFrom(elements: OsmElement[]): Spot[] {
  const out: Spot[] = [];
  for (const e of elements) {
    const at = e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : e.center;
    const name = e.tags?.name?.trim();
    if (!at || !name) continue;
    out.push({ id: `${e.type}/${e.id}`, name, tags: e.tags!, lat: at.lat, lon: at.lon });
  }
  return out;
}

/**
 * A live query he is waiting on gives each server this long. Measured
 * 2026-09-30: a healthy answer takes 1.5-2.5s, and a busy server that has
 * not answered in 8s is not about to — the 12s this replaced, twice over,
 * turned one slow moment into 35 seconds of her saying nothing.
 */
export const LIVE_TIMEOUT_MS = 8_000;

async function overpass(fetcher: Fetcher, query: string, timeoutMs = LIVE_TIMEOUT_MS): Promise<OsmElement[]> {
  let last: unknown = null;
  for (const url of OVERPASS) {
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        last = new Error(`${new URL(url).host} answered ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { elements?: OsmElement[] };
      return body.elements ?? [];
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("OpenStreetMap did not answer");
}

/** A street as one ordered line, from however many pieces OpenStreetMap keeps it in. */
export function streetLine(elements: OsmElement[]): Point[] {
  const points = elements.flatMap((e) => e.geometry ?? []);
  if (points.length < 2) return points;
  // Order the points along the street's main axis, which is the direction they
  // spread furthest in. Kingston's streets are straight enough for this to be
  // the street, and it needs none of the joining-up the raw ways would.
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon0 = points.reduce((s, p) => s + p.lon, 0) / points.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const x = (p.lon - lon0) * k;
    const y = p.lat - lat0;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ax = Math.cos(angle);
  const ay = Math.sin(angle);
  const along = (p: Point) => (p.lon - lon0) * k * ax + (p.lat - lat0) * ay;
  const seen = new Set<string>();
  return points
    .filter((p) => {
      const key = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => along(a) - along(b));
}

/* ── Walking along a line, in metres, on a flat patch of Kingston ─────────── */

interface Flat {
  toXY: (p: Point) => [number, number];
  toPoint: (x: number, y: number) => Point;
}

function flatAround(origin: Point): Flat {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  const my = 111_320;
  return {
    toXY: (p) => [(p.lon - origin.lon) * k * my, (p.lat - origin.lat) * my],
    toPoint: (x, y) => ({ lat: origin.lat + y / my, lon: origin.lon + x / (k * my) }),
  };
}

/** Where along the line a point falls, in metres from its start, and how far off it is. */
export function positionOn(line: Point[], p: Point): { at: number; off: number } {
  const flat = flatAround(line[0]);
  const [px, py] = flat.toXY(p);
  let walked = 0;
  let best = { at: 0, off: Infinity };
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = flat.toXY(line[i]);
    const [bx, by] = flat.toXY(line[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (len * len))) : 0;
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (off < best.off) best = { at: walked + t * len, off };
    walked += len;
  }
  return best;
}

/** The point this many metres along the line, clamped to its ends. */
export function pointAt(line: Point[], metres: number): Point {
  const flat = flatAround(line[0]);
  let walked = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = flat.toXY(line[i]);
    const [bx, by] = flat.toXY(line[i + 1]);
    const len = Math.hypot(bx - ax, by - ay);
    if (walked + len >= metres && len > 0) {
      const t = Math.max(0, (metres - walked) / len);
      return flat.toPoint(ax + t * (bx - ax), ay + t * (by - ay));
    }
    walked += len;
  }
  return metres <= 0 ? line[0] : line[line.length - 1];
}

export const lineLength = (line: Point[]) => {
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) total += metresBetween(line[i], line[i + 1]);
  return total;
};

/* ══════════════════════════════════════════════════════════════════════════
   Choosing what goes on the map
   ══════════════════════════════════════════════════════════════════════════ */

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Words that describe a wish rather than a kind of food. */
const VAGUE = new Set([
  "food", "foods", "restaurant", "restaurants", "place", "places", "something", "somewhere", "good",
  "best", "near", "nearby", "me", "some", "a", "an", "the", "to", "eat", "get", "for", "and", "or",
]);

/** Does this place fit "sushi", "pizza", "indian"? Checked against its cuisine and its name. */
export function fits(spot: Spot, cuisine: string | undefined): boolean {
  const want = words(cuisine ?? "").filter((w) => !VAGUE.has(w));
  if (!want.length) return true;
  const have = new Set(words(`${spot.tags.cuisine ?? ""} ${spot.name}`.replace(/[;_]/g, " ")));
  return want.some((w) => have.has(w) || have.has(w.replace(/s$/, "")) || [...have].some((h) => h.startsWith(w)));
}

function describeCuisine(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/[;,]/)
    .map((p) => p.trim().replace(/_/g, " "))
    .filter(Boolean);
  if (!parts.length) return undefined;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function toMapPlace(spot: Spot, home: Point, now: Date): MapPlace {
  const t = spot.tags;
  const distanceM = Math.round(metresBetween(home, spot));
  const street = t["addr:street"];
  const address = street ? `${t["addr:housenumber"] ? `${t["addr:housenumber"]} ` : ""}${street}` : undefined;
  const kindKey = t.amenity ?? t.shop ?? "";
  const place: MapPlace = {
    id: spot.id,
    name: spot.name,
    kind: KIND_WORDS[kindKey] ?? "Place",
    lat: spot.lat,
    lon: spot.lon,
    walkMin: walkMinutes(distanceM),
    distanceM,
    status: statusAt(t.opening_hours, now),
  };
  const cuisine = describeCuisine(t.cuisine);
  if (cuisine) place.cuisine = cuisine;
  if (address) place.address = address;
  const phone = t.phone ?? t["contact:phone"];
  if (phone) place.phone = phone;
  const website = t.website ?? t["contact:website"];
  if (website) place.website = website;
  return place;
}

/**
 * The most one map holds. Downtown is dense — 182 places to eat within 1.5 km
 * of his door — and a cap of 40 meant "expand the search" showed the same 40.
 * The page tags the nearest and draws the rest as quiet dots.
 */
export const MAX_PLACES = 150;

/* ══════════════════════════════════════════════════════════════════════════
   The live map
   ══════════════════════════════════════════════════════════════════════════ */

export interface FindArgs {
  what: Kind;
  cuisine?: string;
  /** A street, landmark or area to search around instead of home. */
  near?: string;
  radiusM?: number;
}

export type ViewAction = "expand" | "closer" | "move" | "focus" | "home";

export interface ViewArgs {
  action: ViewAction;
  /** For move: "further", "back", or a compass direction. */
  direction?: string;
  meters?: number;
  /** For focus: a name, part of one, or the list number. */
  place?: string;
}

export interface Places {
  /** Fill the cache around home now, so the first question is answered from memory. */
  warm: () => Promise<void>;
  find: (args: FindArgs) => Promise<string>;
  view: (args: ViewArgs) => Promise<string>;
  state: () => MapState | null;
  onChange: (fn: (state: MapState) => void) => () => void;
}

/** How far around home the cache reaches: half an hour's walk and then some. */
export const CACHE_RADIUS_M = 3_500;
/** Hours and names change slowly; a day old is fresh enough. */
export const CACHE_MAX_AGE_MS = 24 * 3600_000;
/** The default reach of a search around a point: a fifteen-minute walk. */
export const DEFAULT_RADIUS_M = Math.round(walkRadius(15));
/** Along a street the window is shorter: the stretch he could see from one spot. */
export const STREET_WINDOW_M = 450;
/** How close to the street's line a place has to be to count as on it. */
export const ON_STREET_M = 90;

const COMPASS: Record<string, [number, number]> = {
  north: [0, 1],
  south: [0, -1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [Math.SQRT1_2, Math.SQRT1_2],
  northwest: [-Math.SQRT1_2, Math.SQRT1_2],
  southeast: [Math.SQRT1_2, -Math.SQRT1_2],
  southwest: [-Math.SQRT1_2, -Math.SQRT1_2],
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function loadHome(file = join(DATA_DIR, "home.json")): Home | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Home>;
    if (typeof raw.lat !== "number" || typeof raw.lon !== "number") return null;
    return { lat: raw.lat, lon: raw.lon, label: raw.label ?? "Home", ...(raw.city ? { city: raw.city } : {}) };
  } catch {
    return null;
  }
}

export function createPlaces(deps: {
  fetcher?: Fetcher;
  home?: () => Home | null;
  cacheFile?: string;
  now?: () => Date;
  /**
   * Ratings for an area. Defaults to Google's when a key is set and to none
   * when it is not; tests pass their own. See ratings.ts.
   */
  rate?: (q: { center: Point; radiusM: number; kind: Kind; cuisine?: string }) => Promise<Rated[]>;
} = {}): Places {
  const fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
  const rate =
    deps.rate ??
    ((q: { center: Point; radiusM: number; kind: Kind; cuisine?: string }) => {
      const key = placesKey();
      // Through the same fetcher as everything else here, so a test that
      // fakes the network fakes this too and can never reach Google.
      return key ? ratedAround({ key, ...q, fetcher }) : Promise.resolve([] as Rated[]);
    });
  const getHome = deps.home ?? (() => loadHome());
  const cacheFile = deps.cacheFile ?? join(DATA_DIR, "places-cache.json");
  const now = deps.now ?? (() => new Date());
  const listeners = new Set<(s: MapState) => void>();

  /** Everything known, by id, and the circle around home the cache vouches for. */
  const known = new Map<string, Spot>();
  let coverage: { center: Point; radiusM: number; at: number } | null = null;
  let warming: Promise<void> | null = null;

  let current: MapState | null = null;
  let seq = 0;
  /** What the map is showing, so a refinement can keep the rest of it. */
  let query: { what: Kind; cuisine?: string; near?: string } | null = null;
  let street: { name: string; line: Point[] } | null = null;
  /** Which way along the street the last move went: +1 or -1. */
  let heading = 0;

  /** Google's view of the area on the map, and what went wrong getting it. */
  let rated: Rated[] = [];
  let ratingTrouble = "";
  /**
   * Areas already rated, for half an hour, in memory only. "Wider" and then
   * "back" should not cost a call each way; Google's terms rule out keeping
   * them longer, or on disk.
   */
  const ratedAreas = new Map<string, { at: number; rated: Rated[] }>();

  const rateArea = async (center: Point, radiusM: number) => {
    const q = query!;
    const key = `${q.what}|${q.cuisine ?? ""}|${center.lat.toFixed(4)},${center.lon.toFixed(4)}|${Math.round(radiusM)}`;
    const seen = ratedAreas.get(key);
    if (seen && Date.now() - seen.at < 30 * 60_000) {
      rated = seen.rated;
      ratingTrouble = "";
      return;
    }
    try {
      rated = await rate({ center, radiusM, kind: q.what, ...(q.cuisine ? { cuisine: q.cuisine } : {}) });
      ratingTrouble = "";
      ratedAreas.set(key, { at: Date.now(), rated });
    } catch (err) {
      // The map without ratings is the map he had yesterday, not a failure.
      rated = [];
      ratingTrouble = (err as Error).message;
    }
  };

  const needHome = () => {
    const home = getHome();
    if (!home) throw new Error("No home is set. Put his address in data/home.json as {label, lat, lon}.");
    return home;
  };

  const remember = (spots: Spot[]) => {
    for (const s of spots) known.set(s.id, s);
  };

  const warm = (): Promise<void> => {
    if (warming) return warming;
    warming = (async () => {
      const home = needHome();
      // Streets alongside, not in front: nothing waits on them.
      void learnStreets(home);
      try {
        const saved = JSON.parse(readFileSync(cacheFile, "utf8")) as {
          center: Point;
          radiusM: number;
          at: number;
          spots: Spot[];
        };
        const fresh = Date.now() - saved.at < CACHE_MAX_AGE_MS;
        const same = metresBetween(saved.center, home) < 50 && saved.radiusM >= CACHE_RADIUS_M;
        if (fresh && same) {
          remember(saved.spots);
          coverage = { center: saved.center, radiusM: saved.radiusM, at: saved.at };
          return;
        }
      } catch {
        /* no cache yet, or an unreadable one: fetch */
      }
      // In the background, so it can take its time: nobody is waiting on it.
      const spots = spotsFrom(await overpass(fetcher, overpassQuery(home, CACHE_RADIUS_M, 60), 70_000));
      remember(spots);
      coverage = { center: home, radiusM: CACHE_RADIUS_M, at: Date.now() };
      try {
        if (!existsSync(dirname(cacheFile))) mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify({ ...coverage, spots }));
      } catch {
        /* the cache is a speed-up; failing to save it costs the next start a fetch */
      }
    })().catch((err) => {
      warming = null;
      throw err;
    });
    return warming;
  };

  /** Make sure everything inside this circle is known, from the cache or from a live query. */
  const cover = async (center: Point, radiusM: number) => {
    await warm().catch(() => {});
    if (coverage && metresBetween(coverage.center, center) + radiusM <= coverage.radiusM) return;
    remember(spotsFrom(await overpass(fetcher, overpassQuery(center, radiusM))));
  };

  const nominatim = async (text: string, home: Home): Promise<{ point: Point; name: string; road: boolean } | null> => {
    const where = /kingston|ontario|,/i.test(text) ? text : `${text}, ${home.city ?? "Kingston, Ontario"}`;
    const box = [home.lon - 0.25, home.lat + 0.18, home.lon + 0.25, home.lat - 0.18].map((n) => n.toFixed(4)).join(",");
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(where)}` +
      `&viewbox=${box}&bounded=0`;
    const res = await fetcher(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`the address search answered ${res.status}`);
    const hits = (await res.json()) as { lat: string; lon: string; name?: string; category?: string; class?: string }[];
    const hit = hits[0];
    if (!hit) return null;
    return {
      point: { lat: Number(hit.lat), lon: Number(hit.lon) },
      name: hit.name || text,
      road: (hit.category ?? hit.class) === "highway",
    };
  };

  /**
   * Street shapes, by name, kept on disk beside the places. A street does not
   * move, and fetching one is the only part of a street search that has to
   * reach Overpass — so each is fetched once, ever, and a busy server can only
   * cost the first time he names it.
   */
  const streetFile = join(dirname(cacheFile), "streets-cache.json");
  let streets: Record<string, Point[]> | null = null;
  let streetsAt = 0;
  const knownStreets = () => {
    if (!streets) {
      try {
        const saved = JSON.parse(readFileSync(streetFile, "utf8")) as { at?: number; lines?: Record<string, Point[]> };
        streets = saved.lines ?? {};
        streetsAt = saved.at ?? 0;
      } catch {
        streets = {};
      }
    }
    return streets;
  };
  const saveStreets = () => {
    try {
      writeFileSync(streetFile, JSON.stringify({ at: streetsAt || Date.now(), lines: streets }));
    } catch {
      /* kept in memory; the next start fetches again */
    }
  };

  /**
   * Every named street near his door, learned in the background.
   *
   * Asking for one street at the moment he names it went to a server that,
   * measured, answered other queries in a second and made that one wait
   * eight — and falling back to a single point put the search at the wrong
   * end of Princess Street. So the streets are known before he asks: one
   * query at startup, kept a week, and naming a nearby street never touches
   * the network.
   */
  const STREETS_RADIUS_M = 2_500;
  const STREETS_MAX_AGE_MS = 7 * 24 * 3600_000;
  let learningStreets: Promise<void> | null = null;
  const learnStreets = (home: Point): Promise<void> => {
    knownStreets();
    if (Date.now() - streetsAt < STREETS_MAX_AGE_MS && Object.keys(streets!).length) return Promise.resolve();
    learningStreets ??= (async () => {
      const q = `[out:json][timeout:60];way["highway"]["name"](${boxAround(home, STREETS_RADIUS_M)});out geom qt;`;
      const elements = await overpass(fetcher, q, 70_000);
      const byName = new Map<string, OsmElement[]>();
      for (const e of elements) {
        const name = e.tags?.name?.trim().toLowerCase();
        if (!name || !e.geometry?.length) continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(e);
      }
      for (const [name, ways] of byName) {
        const line = streetLine(ways);
        if (line.length >= 2) streets![name] = line;
      }
      streetsAt = Date.now();
      saveStreets();
    })().catch(() => {
      learningStreets = null;
    });
    return learningStreets;
  };

  const fetchStreet = async (name: string, home: Point): Promise<Point[]> => {
    const key = name.trim().toLowerCase();
    const kept = knownStreets()[key];
    if (kept && kept.length >= 2) return kept;
    // An exact name, which Overpass answers from its index. The case-blind
    // pattern this replaced took 19.8s for Princess Street.
    const exact = name.replace(/["\\]/g, "");
    const q = `[out:json][timeout:15];way["highway"]["name"="${exact}"](${boxAround(home, 8_000)});out geom qt;`;
    const line = streetLine(await overpass(fetcher, q));
    if (line.length >= 2) {
      knownStreets()[key] = line;
      saveStreets();
    }
    return line;
  };

  /** Build the state for the current query, view and focus, and tell everyone. */
  const publish = (center: Point, radiusM: number, focus: string | null | "best") => {
    const home = needHome();
    const when = now();
    const q = query!;
    let pool = [...known.values()].filter((s) => KINDS[q.what].match(s.tags) && fits(s, q.cuisine));
    if (street) {
      // On the street and inside the stretch being looked at: the places he
      // would pass, not everything within a circle.
      const here = positionOn(street.line, center).at;
      pool = pool.filter((s) => {
        const p = positionOn(street!.line, s);
        return p.off <= ON_STREET_M && Math.abs(p.at - here) <= radiusM;
      });
    } else {
      pool = pool.filter((s) => metresBetween(center, s) <= radiusM);
    }
    // The nearest to where he is looking, then in walking order from his door.
    const places = pool
      .sort((a, b) => metresBetween(center, a) - metresBetween(center, b))
      .slice(0, MAX_PLACES)
      .map((s) => toMapPlace(s, home, when))
      .sort((a, b) => a.walkMin - b.walkMin || a.distanceM - b.distanceM || a.name.localeCompare(b.name));

    // Google's ratings onto the places they belong to, and Google's places
    // that OpenStreetMap does not have, if they are inside what he is looking at.
    const inView = (p: Point) =>
      street
        ? (() => {
            const here = positionOn(street!.line, center).at;
            const at = positionOn(street!.line, p);
            return at.off <= ON_STREET_M && Math.abs(at.at - here) <= radiusM;
          })()
        : metresBetween(center, p) <= radiusM;
    for (const r of rated) {
      const match = places.find((p) => p.rating === undefined && samePlace(p, r));
      if (match) withRating(match, r);
      else if (inView(r)) places.push(withRating(fromRated(r, home), r));
    }
    // Ranked once there is anything to rank by: open first, then how good,
    // then how near. Before ratings, walking order is the only order there is.
    if (places.some((p) => p.rating !== undefined)) {
      const openness = (p: MapPlace) => (p.status.open === true ? 0 : p.status.open === null ? 1 : 2);
      places.sort(
        (a, b) =>
          openness(a) - openness(b) ||
          goodness(b.rating, b.reviews) - goodness(a.rating, a.reviews) ||
          a.walkMin - b.walkMin,
      );
    }
    // "best" is find_places choosing for him: the top of that ranking that is
    // open, or failing that the top. Picked out on the map, with its card,
    // so the answer is on screen before she has said it.
    if (focus === "best") focus = (places.find((p) => p.status.open === true) ?? places[0])?.id ?? null;

    const subject = q.cuisine?.trim()
      ? q.cuisine.trim().charAt(0).toUpperCase() + q.cuisine.trim().slice(1)
      : KINDS[q.what].title;
    const where = street ? `on ${street.name}` : q.near ? `near ${q.near}` : "near home";
    const open = places.filter((p) => p.status.open === true).length;
    const clock = when.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }).replace(/\./g, "");
    current = {
      seq: ++seq,
      title: `${subject} ${where}`,
      subtitle: `${places.length} ${places.length === 1 ? "place" : "places"} · ${open} open now · as of ${clock}`,
      home,
      center,
      radiusM: Math.round(radiusM),
      places,
      focus: focus && places.some((p) => p.id === focus) ? focus : null,
      street: street?.line ?? null,
      updatedAt: Date.now(),
    };
    for (const fn of [...listeners]) fn(current);
    return current;
  };

  /** What the model is told: enough to say one line, and how to move the map next. */
  const describe = (state: MapState, lead: string) => {
    // Numbered as the list on his screen reads, top to bottom, so "the first
    // one" means the same place to both of them. Ranking the open ones first
    // here made her number one a different place from the map's.
    const lines = state.places.slice(0, 6).map((p, i) => {
      const bits = [
        ...(p.rating !== undefined ? [`${p.rating.toFixed(1)}★ from ${p.reviews ?? 0}`] : []),
        ...(priceSigns(p.price) ? [priceSigns(p.price)] : []),
        p.cuisine ?? p.kind,
        `${p.walkMin} min walk`,
        p.status.label.replace(" · ", ", ").toLowerCase(),
      ];
      return `${i + 1}. ${p.name} — ${bits.join(", ")}${p.address ? ` — ${p.address}` : ""}`;
    });
    const more = state.places.length > 6 ? `\n…and ${state.places.length - 6} more on the map.` : "";
    const none = state.places.length
      ? ""
      : "\nNothing matched here. Offer to widen it (map_view expand) or look somewhere else.";
    // The one line she says should name somewhere he can actually go.
    const open = state.places.findIndex((p) => p.status.open === true);
    const ranked = state.places.some((p) => p.rating !== undefined);
    const picked = state.focus ? state.places.findIndex((p) => p.id === state.focus) : -1;
    const pick =
      picked >= 0
        ? `\n${ranked ? "Top pick" : "Nearest open"}, already picked out on his map with its card open: number ${picked + 1}, ${
            state.places[picked].name
          }. Answer from this; map_view is only for when he asks to move or pick another.`
        : open >= 0
          ? `\nNearest open: number ${open + 1}, ${state.places[open].name} (${state.places[open].walkMin} min walk).`
          : state.places.length
            ? "\nNone of these is known to be open right now."
            : "";
    const rating = ranked
      ? " Ranked by Google rating (weighted by how many reviews), open places first."
      : ratingTrouble
        ? ` No ratings: ${ratingTrouble}.`
        : "";
    return (
      `${lead}: ${state.title} — ${state.subtitle}. Walking times are from his door.${rating}\n` +
      `${lines.join("\n")}${more}${none}${pick}\n` +
      `The map is on his screen. Say one short line; the map carries the list. ` +
      `For "wider", "further down", "closer" or "that one", use map_view on this same map.`
    );
  };

  return {
    warm,

    async find(args) {
      const home = needHome();
      query = { what: args.what, ...(args.cuisine ? { cuisine: args.cuisine } : {}) };
      street = null;
      heading = 0;
      // A position, not his home record: the label has no business in a centre.
      let center: Point = { lat: home.lat, lon: home.lon };
      let radius = clamp(args.radiusM ?? DEFAULT_RADIUS_M, 200, 5_000);
      if (args.near?.trim()) {
        const found = await nominatim(args.near.trim(), home);
        if (!found) return `Couldn't find "${args.near}" near Kingston. Ask him where he means.`;
        query.near = found.name;
        center = found.point;
        if (found.road) {
          const line = await fetchStreet(found.name, home).catch(() => [] as Point[]);
          if (line.length >= 2) {
            street = { name: found.name, line };
            // Start at the part of the street nearest his door; "further"
            // then means away from it.
            center = pointAt(line, positionOn(line, home).at);
            radius = clamp(args.radiusM ?? STREET_WINDOW_M, 200, 2_000);
          }
        }
      }
      await cover(center, street ? radius + ON_STREET_M : radius);
      await rateArea(center, street ? radius + ON_STREET_M : radius);
      return describe(publish(center, radius, "best"), "Map updated");
    },

    async view(args) {
      if (!current || !query) return "There is no map up. Use find_places first.";
      const home = needHome();
      let center = current.center;
      let radius = current.radiusM;
      let focus = current.focus;
      let lead = "Map updated";

      if (args.action === "expand") {
        radius = clamp(radius * 1.6, 200, 5_000);
        lead = "Widened";
      } else if (args.action === "closer") {
        radius = clamp(radius / 1.6, 150, 5_000);
        lead = "Closed in";
      } else if (args.action === "home") {
        street = null;
        heading = 0;
        query = { what: query.what, ...(query.cuisine ? { cuisine: query.cuisine } : {}) };
        center = { lat: home.lat, lon: home.lon };
        radius = DEFAULT_RADIUS_M;
        focus = null;
        lead = "Back home";
      } else if (args.action === "move") {
        const step = clamp(args.meters ?? Math.max(250, radius * 0.9), 50, 5_000);
        const dir = (args.direction ?? "further").toLowerCase().replace(/[\s-]+/g, "");
        if (street) {
          const line = street.line;
          const here = positionOn(line, center).at;
          const homeAt = positionOn(line, home).at;
          let sign: number;
          if (COMPASS[dir]) {
            // Which way along the street is closest to the direction asked for.
            const a = line[0];
            const b = line[line.length - 1];
            const flat = flatAround(a);
            const [bx, by] = flat.toXY(b);
            const len = Math.hypot(bx, by) || 1;
            sign = Math.sign((bx / len) * COMPASS[dir][0] + (by / len) * COMPASS[dir][1]) || 1;
          } else if (/back|toward.*home|closer/.test(dir)) {
            sign = here >= homeAt ? -1 : 1;
          } else if (heading) {
            sign = heading;
          } else if (Math.abs(here - homeAt) < 60) {
            // Standing where the street meets his door, "away from home" has
            // no side yet: go the way there is more street.
            sign = lineLength(line) - here >= here ? 1 : -1;
          } else {
            sign = here > homeAt ? 1 : -1;
          }
          heading = sign;
          const total = lineLength(line);
          const to = clamp(here + sign * step, 0, total);
          if (Math.abs(to - here) < 20) return `That's the end of ${street.name}. Offer to look somewhere else.`;
          center = pointAt(line, to);
          lead = `Moved ${Math.round(Math.abs(to - here))} m along ${street.name}`;
        } else {
          const v = COMPASS[dir];
          if (!v) return `Move which way? Give a compass direction (north, southeast…) or "further" along a street.`;
          const flat = flatAround(center);
          center = flat.toPoint(v[0] * step, v[1] * step);
          lead = `Moved ${Math.round(step)} m ${dir}`;
        }
        focus = null;
      } else if (args.action === "focus") {
        const wanted = (args.place ?? "").trim();
        const byNumber = /^\d+$/.test(wanted) ? current.places[Number(wanted) - 1] : undefined;
        const want = words(wanted).join(" ");
        const match =
          byNumber ??
          current.places.find((p) => words(p.name).join(" ") === want) ??
          current.places.find((p) => words(p.name).join(" ").includes(want)) ??
          current.places.find((p) => want.includes(words(p.name).join(" ")));
        if (!wanted || !match) return `No "${wanted}" on the map. The places up are: ${current.places.map((p) => p.name).join(", ")}.`;
        focus = match.id;
        const state = publish(center, radius, focus);
        const p = state.places.find((x) => x.id === focus)!;
        const directions =
          `https://www.google.com/maps/dir/?api=1&origin=${home.lat},${home.lon}` +
          `&destination=${p.lat},${p.lon}&travelmode=walking`;
        return (
          `Picked out ${p.name} on the map: ${[p.cuisine ?? p.kind, `${p.walkMin} min walk`, p.status.label].join(" · ")}` +
          `${p.status.today ? ` (today ${p.status.today})` : ""}${p.address ? `, ${p.address}` : ""}` +
          `${p.phone ? `, ${p.phone}` : ""}${p.website ? `, ${p.website}` : ""}.\n` +
          `Walking directions, if he wants them (open with launch_app): ${directions}\n` +
          `For reviews, menus or prices, look it up on the web.`
        );
      }

      await cover(center, street ? radius + ON_STREET_M : radius);
      await rateArea(center, street ? radius + ON_STREET_M : radius);
      return describe(publish(center, radius, focus), lead);
    },

    state: () => current,

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The one map, shared by her tools, the server, and the hub it streams to. */
let shared: Places | null = null;
export function places(): Places {
  shared ??= createPlaces();
  return shared;
}
