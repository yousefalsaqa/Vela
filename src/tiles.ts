import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./paths.js";
import { USER_AGENT, type Fetcher } from "./places.js";

/**
 * The map's pictures, fetched by Vela rather than by the page that draws them.
 *
 * The map page runs in the stage's sandboxed frame, which gives it an opaque
 * origin, and a browser sends no Referer from an opaque origin. OpenStreetMap
 * asks every tile request to say who it is — a Referer from a website, a
 * User-Agent of its own from an app — and a browser with neither is one they
 * cannot tell apart from a scraper. Every tile came back 403, with "Access
 * blocked" painted across it (osm.wiki/Blocked, the general block). The frame
 * cannot be given an origin without giving her own pages one too, so the
 * request moves here instead, where it can name itself. The policy also asks
 * for caching, which a frame torn down on every show does badly and a folder
 * on disk does well.
 *
 * The page asks this server for /tiles/z/x/y.png, with the screen's own key;
 * see the route in server.ts.
 */
export const TILE_HOST = "https://tile.openstreetmap.org";

/** OpenStreetMap's deepest zoom, and the map page's. */
export const TILE_MAX_ZOOM = 19;

/**
 * How long a tile on disk is used before it is asked for again.
 *
 * A week, which is OpenStreetMap's own allowance: their tiles carry
 * stale-while-revalidate=604800. Streets do not move faster than that.
 */
export const TILE_MAX_AGE_MS = 7 * 24 * 3600_000;

/** Long enough for a slow tile server, short enough that a dead one is a gap. */
export const TILE_TIMEOUT_MS = 8_000;

/** A tile that exists: whole numbers, inside the world at that zoom. */
export function isTile(z: number, x: number, y: number): boolean {
  if (![z, x, y].every(Number.isInteger)) return false;
  if (z < 0 || z > TILE_MAX_ZOOM) return false;
  const across = 2 ** z;
  return x >= 0 && x < across && y >= 0 && y < across;
}

/** A tile's PNG, or null when there is none to give. */
export type TileSource = (z: number, x: number, y: number) => Promise<Buffer | null>;

export function createTiles(deps: {
  fetcher?: Fetcher;
  dir?: string;
  now?: () => number;
} = {}): TileSource {
  const fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
  const dir = deps.dir ?? join(DATA_DIR, "tiles");
  const now = deps.now ?? Date.now;
  /** Tiles on their way, so two asks for one tile are one request to OSM. */
  const pending = new Map<string, Promise<Buffer | null>>();

  const load = async (z: number, x: number, y: number): Promise<Buffer | null> => {
    const file = join(dir, String(z), String(x), `${y}.png`);
    let stale: Buffer | null = null;
    try {
      const bytes = readFileSync(file);
      if (now() - statSync(file).mtimeMs < TILE_MAX_AGE_MS) return bytes;
      stale = bytes;
    } catch {
      /* not on disk yet */
    }

    try {
      const res = await fetcher(`${TILE_HOST}/${z}/${x}/${y}.png`, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
      });
      // A refusal arrives as a picture of the refusal. Kept, it would be
      // served from disk for a week after the block had lifted.
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return stale;
      const bytes = Buffer.from(await res.arrayBuffer());
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      } catch {
        /* the cache is a courtesy; the tile still gets drawn */
      }
      return bytes;
    } catch {
      // Offline, or OSM is slow: last week's street beats a black square.
      return stale;
    }
  };

  return (z, x, y) => {
    if (!isTile(z, x, y)) return Promise.resolve(null);
    const key = `${z}/${x}/${y}`;
    const already = pending.get(key);
    if (already) return already;
    const fetching = load(z, x, y).finally(() => pending.delete(key));
    pending.set(key, fetching);
    return fetching;
  };
}
