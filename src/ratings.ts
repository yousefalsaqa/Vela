import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.js";

/**
 * Google's ratings, laid over OpenStreetMap's places.
 *
 * The map is built from OpenStreetMap, which knows where everything is and
 * when it opens and has no idea whether any of it is good. He looked at the
 * map and asked for the ratings, not the walking minutes the markers were
 * showing. So one call to Google's Places API per area searched: the twenty
 * most popular places there, with their rating and how many people gave it,
 * matched back onto the places already on the map by name and distance.
 *
 * Costed on 2026-10-01: rating and userRatingCount are "Enterprise" fields,
 * 1,000 calls a month free, $35 per 1,000 after. A search is one call. Kept in
 * memory only, for as long as the map is looking at that area, because
 * Google's terms do not allow storing them.
 */

export interface Point {
  lat: number;
  lon: number;
}

/** One place as Google rates it. */
export interface Rated extends Point {
  gid: string;
  name: string;
  rating?: number;
  reviews?: number;
  /** 0 (free) to 4 (very expensive), when Google knows. */
  price?: number;
  mapsUrl?: string;
  openNow?: boolean;
  kind?: string;
  address?: string;
}

/** What the map's kinds mean to Google. Every one is in Places Table A. */
export const GOOGLE_TYPES: Record<string, string[]> = {
  food: ["restaurant", "fast_food_restaurant", "cafe", "bakery", "meal_takeaway"],
  restaurant: ["restaurant"],
  fast_food: ["fast_food_restaurant", "meal_takeaway"],
  cafe: ["cafe", "coffee_shop"],
  bar: ["bar", "pub"],
  dessert: ["ice_cream_shop", "dessert_shop", "bakery", "confectionery"],
  groceries: ["supermarket", "grocery_store", "convenience_store"],
  pharmacy: ["pharmacy", "drugstore"],
};

const FIELDS = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.googleMapsUri",
  "places.currentOpeningHours.openNow",
  "places.primaryTypeDisplayName",
  "places.shortFormattedAddress",
].join(",");

const PRICE: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/**
 * The key, from VELA_GOOGLE_PLACES_KEY or data/google-places-key. Null when
 * neither is there, and the map simply has no ratings — it worked without
 * them before and still does.
 */
export function placesKey(file = join(DATA_DIR, "google-places-key")): string | null {
  const fromEnv = process.env.VELA_GOOGLE_PLACES_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    return saved || null;
  } catch {
    return null;
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** One Google place, as the API sends it, cut to what a map uses. */
export function fromGoogle(p: {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  googleMapsUri?: string;
  currentOpeningHours?: { openNow?: boolean };
  primaryTypeDisplayName?: { text?: string };
  shortFormattedAddress?: string;
}): Rated | null {
  const name = p.displayName?.text?.trim();
  const lat = p.location?.latitude;
  const lon = p.location?.longitude;
  if (!p.id || !name || typeof lat !== "number" || typeof lon !== "number") return null;
  const r: Rated = { gid: p.id, name, lat, lon };
  if (typeof p.rating === "number") r.rating = p.rating;
  if (typeof p.userRatingCount === "number") r.reviews = p.userRatingCount;
  if (p.priceLevel && p.priceLevel in PRICE) r.price = PRICE[p.priceLevel];
  if (p.googleMapsUri) r.mapsUrl = p.googleMapsUri;
  if (typeof p.currentOpeningHours?.openNow === "boolean") r.openNow = p.currentOpeningHours.openNow;
  if (p.primaryTypeDisplayName?.text) r.kind = p.primaryTypeDisplayName.text;
  if (p.shortFormattedAddress) r.address = p.shortFormattedAddress;
  return r;
}

/**
 * The most popular places of a kind in a circle: one call. With a cuisine, a
 * text search for it instead, since a type cannot say "sushi".
 */
export async function ratedAround(opts: {
  key: string;
  center: Point;
  radiusM: number;
  kind: string;
  cuisine?: string;
  fetcher?: Fetcher;
}): Promise<Rated[]> {
  const fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const circle = {
    center: { latitude: opts.center.lat, longitude: opts.center.lon },
    radius: Math.min(50_000, Math.max(50, Math.round(opts.radiusM))),
  };
  const cuisine = opts.cuisine?.trim();
  const url = cuisine
    ? "https://places.googleapis.com/v1/places:searchText"
    : "https://places.googleapis.com/v1/places:searchNearby";
  const body = cuisine
    ? { textQuery: `${cuisine} ${opts.kind === "food" ? "food" : opts.kind.replace("_", " ")}`, pageSize: 20, locationBias: { circle } }
    : {
        includedTypes: GOOGLE_TYPES[opts.kind] ?? GOOGLE_TYPES.food,
        maxResultCount: 20,
        rankPreference: "POPULARITY",
        locationRestriction: { circle },
      };
  const res = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": opts.key, "x-goog-fieldmask": FIELDS },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) {
    const why = await res.text().catch(() => "");
    throw new Error(`Google Places said ${res.status}${why ? `: ${why.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { places?: Parameters<typeof fromGoogle>[0][] };
  return (data.places ?? []).map(fromGoogle).filter((r): r is Rated => r !== null);
}

/** A name as words, without the parts two sources disagree on. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !["the", "restaurant", "cafe", "bar", "and", "kingston", "of"].includes(w));
}

/**
 * Are these the same place? Close together and named alike: "Peter's Place"
 * and "Peters Place Restaurant" are; two cafés on one corner are not.
 */
export function samePlace(a: { name: string } & Point, b: { name: string } & Point, withinM = 80): boolean {
  if (metres(a, b) > withinM) return false;
  const x = nameWords(a.name);
  const y = nameWords(b.name);
  if (!x.length || !y.length) return false;
  const shared = x.filter((w) => y.includes(w)).length;
  return shared / Math.min(x.length, y.length) >= 0.6;
}

function metres(a: Point, b: Point): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/**
 * How good a place is, for ranking, from its rating and how many gave it.
 *
 * A 5.0 from three people is not better than a 4.6 from nine hundred. Each
 * rating is pulled towards a middling 4.0 by the weight of forty imaginary
 * reviews, so a few votes barely move it and a lot of votes speak for
 * themselves. Unrated is ranked below everything rated.
 */
export function goodness(rating?: number, reviews?: number): number {
  if (typeof rating !== "number") return -1;
  const v = Math.max(0, reviews ?? 0);
  const m = 40;
  return (v / (v + m)) * rating + (m / (v + m)) * 4.0;
}

/** "$$" for a price level, "" when unknown or free. */
export const priceSigns = (price?: number) => (price ? "$".repeat(price) : "");
