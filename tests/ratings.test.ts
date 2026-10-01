import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { samePlace, goodness, fromGoogle, ratedAround, placesKey, nameWords, GOOGLE_TYPES } from "../src/ratings.js";

/** A spot this many metres north of his door. */
const home = { lat: 44.2300000, lon: -76.4800000 };
const north = (m: number) => ({ lat: home.lat + m / 111_320, lon: home.lon });

describe("samePlace", () => {
  test("the same restaurant under two spellings is one place", () => {
    // OpenStreetMap and Google never agree on a name to the letter: an
    // apostrophe, a trailing "Restaurant". A rating that cannot cross that
    // gap is a map of dashes.
    assert.ok(samePlace({ name: "Peter's Place", ...north(0) }, { name: "Peters Place Restaurant", ...north(25) }));
  });

  test("two places on the same corner are not one, however close", () => {
    // The failure the other way round is worse: the bar next door's 4.8 on a
    // café that has never been rated, sold to him as a fact.
    assert.ok(!samePlace({ name: "Sipps Coffee", ...north(0) }, { name: "Tir nan Og", ...north(10) }));
  });

  test("the same name a block away is a different branch", () => {
    assert.ok(!samePlace({ name: "Tim Hortons", ...north(0) }, { name: "Tim Hortons", ...north(300) }));
  });

  test("a name that is only a word like 'Restaurant' matches nothing", () => {
    assert.deepEqual(nameWords("The Restaurant"), []);
    assert.ok(!samePlace({ name: "The Restaurant", ...north(0) }, { name: "Restaurant", ...north(5) }));
  });
});

describe("goodness", () => {
  test("a 4.6 from nine hundred people outranks a 5.0 from three", () => {
    // The whole reason for weighing by count. Sorted by the raw number, the
    // top of his list would be whatever opened last week and asked its
    // friends.
    assert.ok(goodness(4.6, 900) > goodness(5.0, 3));
  });

  test("with the same number of reviews, the higher rating ranks higher", () => {
    assert.ok(goodness(4.7, 200) > goodness(4.2, 200));
  });

  test("anything rated ranks above anything unrated", () => {
    assert.ok(goodness(2.1, 4) > goodness(undefined, undefined));
  });
});

describe("fromGoogle", () => {
  test("keeps what a map uses and turns the price into a number", () => {
    const r = fromGoogle({
      id: "abc",
      displayName: { text: "Chez Piggy" },
      location: { latitude: 44.23, longitude: -76.48 },
      rating: 4.5,
      userRatingCount: 1203,
      priceLevel: "PRICE_LEVEL_MODERATE",
      googleMapsUri: "https://maps.google.com/?cid=1",
      currentOpeningHours: { openNow: true },
      primaryTypeDisplayName: { text: "Restaurant" },
    });
    assert.deepEqual(r, {
      gid: "abc", name: "Chez Piggy", lat: 44.23, lon: -76.48, rating: 4.5, reviews: 1203,
      price: 2, mapsUrl: "https://maps.google.com/?cid=1", openNow: true, kind: "Restaurant",
    });
  });

  test("a place with no position cannot go on a map, so it is dropped", () => {
    assert.equal(fromGoogle({ id: "x", displayName: { text: "Somewhere" } }), null);
  });
});

describe("ratedAround", () => {
  test("is one call, asking only for the fields the map shows, ranked by popularity", async () => {
    // The fields are the bill: rating puts the call in Google's Enterprise
    // tier, 1,000 free a month. A field nobody draws is money for nothing,
    // and a second call per search halves the free month.
    const calls: { url: string; init: RequestInit }[] = [];
    const rated = await ratedAround({
      key: "k",
      center: home,
      radiusM: 1200,
      kind: "food",
      fetcher: async (url, init) => {
        calls.push({ url, init: init! });
        return new Response(JSON.stringify({ places: [{ id: "a", displayName: { text: "A" }, location: { latitude: 1, longitude: 2 }, rating: 4 }] }));
      },
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /places:searchNearby$/);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], "k");
    assert.ok(headers["x-goog-fieldmask"].includes("places.rating"));
    assert.ok(!headers["x-goog-fieldmask"].includes("reviews"), "the review texts are a pricier tier and nothing shows them");
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.rankPreference, "POPULARITY");
    assert.deepEqual(body.includedTypes, GOOGLE_TYPES.food);
    assert.equal(rated.length, 1);
  });

  test("a cuisine is a text search, because no place type says 'sushi'", async () => {
    let url = "";
    let body: { textQuery?: string } = {};
    await ratedAround({
      key: "k", center: home, radiusM: 800, kind: "food", cuisine: "sushi",
      fetcher: async (u, init) => {
        url = u;
        body = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ places: [] }));
      },
    });
    assert.match(url, /places:searchText$/);
    assert.match(body.textQuery ?? "", /sushi/);
  });

  test("Google refusing is an error that says why, not an empty map", async () => {
    // Billing off is the likeliest first failure, and "no ratings" with no
    // reason would leave him guessing which of three things is wrong.
    await assert.rejects(
      ratedAround({
        key: "k", center: home, radiusM: 800, kind: "food",
        fetcher: async () => new Response('{"error":{"status":"PERMISSION_DENIED","message":"Billing not enabled"}}', { status: 403 }),
      }),
      /403.*Billing not enabled/,
    );
  });
});

describe("placesKey", () => {
  test("is read from data/ when the environment does not set it, and is null when neither does", () => {
    const dir = mkdtempSync(join(tmpdir(), "vela-key-"));
    const file = join(dir, "google-places-key");
    const saved = process.env.VELA_GOOGLE_PLACES_KEY;
    delete process.env.VELA_GOOGLE_PLACES_KEY;
    try {
      assert.equal(placesKey(file), null, "no key is no ratings, not a crash");
      writeFileSync(file, "  abc123\n");
      assert.equal(placesKey(file), "abc123");
      process.env.VELA_GOOGLE_PLACES_KEY = "from-env";
      assert.equal(placesKey(file), "from-env");
    } finally {
      if (saved === undefined) delete process.env.VELA_GOOGLE_PLACES_KEY;
      else process.env.VELA_GOOGLE_PLACES_KEY = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
