import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTiles, isTile, TILE_HOST, TILE_MAX_AGE_MS } from "../src/tiles.js";
import { USER_AGENT } from "../src/places.js";

/**
 * The map's tiles, fetched by Vela on the page's behalf.
 *
 * OpenStreetMap's tile servers are run by volunteers and block what does not
 * follow their policy: say who you are, cache what you fetch, do not hammer.
 * Every test below is one of those rules, or what happens when OSM says no.
 */

const PNG = Buffer.from("\x89PNG a street");
const png = (body = PNG, status = 200, type = "image/png") =>
  new Response(body, { status, headers: { "content-type": type } });

/** A fake OSM that answers with whatever the test hands it and keeps a log. */
function osm(answer: () => Promise<Response> | Response = () => png()) {
  const asked: { url: string; init?: RequestInit }[] = [];
  return {
    asked,
    fetcher: async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return answer();
    },
  };
}

describe("isTile", () => {
  test("a tile inside the world at its zoom is one, and anything else is refused before it is fetched", () => {
    assert.equal(isTile(0, 0, 0), true);
    assert.equal(isTile(16, 18844, 23773), true);
    assert.equal(isTile(2, 4, 0), false, "zoom 2 is four tiles across, numbered 0 to 3");
    assert.equal(isTile(2, -1, 0), false);
    assert.equal(isTile(20, 0, 0), false, "OSM draws nothing past zoom 19");
    assert.equal(isTile(1.5, 0, 0), false);
  });
});

describe("createTiles", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "vela-tiles-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("asks OpenStreetMap for the tile by name, as Vela, because an unnamed request is what gets blocked", async () => {
    const fake = osm();
    const tile = await createTiles({ fetcher: fake.fetcher, dir })(16, 18844, 23773);
    assert.deepEqual(tile, PNG);
    assert.equal(fake.asked[0].url, `${TILE_HOST}/16/18844/23773.png`);
    assert.equal(new Headers(fake.asked[0].init?.headers).get("user-agent"), USER_AGENT);
  });

  test("a tile it already has is served from disk, not fetched again", async () => {
    const fake = osm();
    const tiles = createTiles({ fetcher: fake.fetcher, dir });
    await tiles(16, 18844, 23773);
    // A new instance, as after a restart: the disk is the cache, not memory.
    const again = await createTiles({ fetcher: fake.fetcher, dir })(16, 18844, 23773);
    assert.deepEqual(again, PNG);
    assert.equal(fake.asked.length, 1, "fetching the same tile repeatedly is one of OSM's named reasons to block");
  });

  test("a refusal is not kept, because OSM sends it as a picture and it would outlast the block by a week", async () => {
    let answer = png(Buffer.from("\x89PNG Access blocked"), 403);
    const fake = osm(() => answer);
    const tiles = createTiles({ fetcher: fake.fetcher, dir });
    assert.equal(await tiles(16, 18844, 23773), null);
    assert.equal(existsSync(join(dir, "16", "18844", "23773.png")), false);

    answer = png();
    assert.deepEqual(await tiles(16, 18844, 23773), PNG, "once the block lifts, the next ask gets the real tile");
  });

  test("an answer that is not an image is not a tile, whatever its status", async () => {
    const fake = osm(() => png(Buffer.from("<html>busy</html>"), 200, "text/html"));
    assert.equal(await createTiles({ fetcher: fake.fetcher, dir })(16, 18844, 23773), null);
  });

  test("a tile older than a week is fetched again", async () => {
    const fake = osm();
    await createTiles({ fetcher: fake.fetcher, dir })(16, 18844, 23773);
    const later = () => Date.now() + TILE_MAX_AGE_MS + 60_000;
    await createTiles({ fetcher: fake.fetcher, dir, now: later })(16, 18844, 23773);
    assert.equal(fake.asked.length, 2);
  });

  test("with OSM unreachable, an old tile beats a black square", async () => {
    await createTiles({ fetcher: osm().fetcher, dir })(16, 18844, 23773);
    const down = osm(() => Promise.reject(new Error("offline")));
    const later = () => Date.now() + TILE_MAX_AGE_MS + 60_000;
    assert.deepEqual(await createTiles({ fetcher: down.fetcher, dir, now: later })(16, 18844, 23773), PNG);
  });

  test("with OSM unreachable and nothing on disk, there is no tile, and no throw", async () => {
    const down = osm(() => Promise.reject(new Error("offline")));
    assert.equal(await createTiles({ fetcher: down.fetcher, dir })(16, 18844, 23773), null);
  });

  test("two asks for one tile at once are one request to OSM", async () => {
    // Every request held open until both asks are in, then all released, so
    // a second request fails the count below instead of hanging the suite.
    const held: ((r: Response) => void)[] = [];
    const fake = osm(() => new Promise<Response>((r) => held.push(r)));
    const tiles = createTiles({ fetcher: fake.fetcher, dir });
    const both = Promise.all([tiles(16, 18844, 23773), tiles(16, 18844, 23773)]);
    for (const release of held) release(png());
    assert.deepEqual(await both, [PNG, PNG]);
    assert.equal(fake.asked.length, 1, "Leaflet re-asks for tiles mid-zoom; OSM should see one request");
  });

  test("a tile outside the world is never asked for", async () => {
    const fake = osm();
    assert.equal(await createTiles({ fetcher: fake.fetcher, dir })(2, 4, 0), null);
    assert.equal(fake.asked.length, 0);
  });
});
