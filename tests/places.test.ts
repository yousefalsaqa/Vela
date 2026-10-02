import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  statusAt,
  parseHours,
  spotsFrom,
  fits,
  toMapPlace,
  walkMinutes,
  streetLine,
  positionOn,
  pointAt,
  lineLength,
  boxAround,
  loadHome,
  createPlaces,
  type Home,
  type MapState,
  type Spot,
} from "../src/places.js";

/**
 * Places near him, and the map that moves rather than being redrawn.
 *
 * The hours strings are real: every one below came off OpenStreetMap within
 * a kilometre and a half of his door. The dates are fixed, and local, the way
 * the service reads its own clock.
 */

// Wednesday 30 September 2026, which is the day this was written.
const at = (day: number, hh: number, mm = 0) => new Date(2026, 8, 30 + day, hh, mm);
const WED = 0;
const THU = 1;
const SAT = 3;
const SUN = 4;
const MON = 5;
const TUE = 6;

describe("opening hours", () => {
  test("open past midnight is still open after midnight, on the next day's clock", () => {
    // "11:00-02:00" belongs to the day it starts on. At 1:30 on Thursday the
    // place is open because of Wednesday's hours, and a parser that only looks
    // at today's calls it shut.
    assert.equal(statusAt("Mo-Su 11:00-02:00", at(WED, 14, 30)).label, "Open · till 2 am");
    assert.deepEqual(statusAt("Mo-Su 11:00-02:00", at(THU, 1, 30)), {
      open: true,
      label: "Open · till 2 am",
      today: "11 am – 2 am",
    });
  });

  test("a comma between rules adds days, and a public-holiday rule says nothing about Sunday", () => {
    const spec = "Mo-Th 11:00-23:00, Fr,Sa 11:00-24:00, Su,PH 11:00-22:00";
    assert.equal(statusAt(spec, at(SAT, 23, 30)).label, "Open · till midnight");
    assert.equal(statusAt(spec, at(SUN, 10)).label, "Closed · opens 11 am");
    assert.equal(statusAt(spec, at(SUN, 21)).label, "Open · till 10 pm");
  });

  test("a day range can wrap round the weekend", () => {
    const spec = "We-Sa 11:00-00:00; Su-Tu 11:00-23:00";
    assert.equal(statusAt(spec, at(MON, 22)).label, "Open · till 11 pm");
    assert.equal(statusAt(spec, at(TUE, 23, 30)).label, "Closed · opens tomorrow 11 am");
  });

  test("a later rule replaces an earlier one for the days it names", () => {
    // "; Tu off" means Tuesday is shut, not Tuesday is also shut.
    assert.equal(statusAt("Mo-Su 10:00-20:00; Tu off", at(TUE, 12)).open, false);
    assert.equal(statusAt("Mo-Su 10:00-20:00; Tu off", at(WED, 12)).open, true);
  });

  test("an open end is open, and says it does not know when it shuts", () => {
    const spec = "Mo-We 16:00-22:00; Th 16:00+; Fr-Sa 11:00+; Su off";
    assert.equal(statusAt(spec, at(THU, 20)).label, "Open · closing time not listed");
    assert.equal(statusAt(spec, at(SUN, 12)).label, "Closed · opens tomorrow 4 pm");
  });

  test("a split day is shut in the gap and says when it opens again", () => {
    const spec = "Tu-Sa 11:30-14:30,16:30-21:30";
    assert.equal(statusAt(spec, at(WED, 12)).label, "Open · till 2:30 pm");
    assert.equal(statusAt(spec, at(WED, 15)).label, "Closed · opens 4:30 pm");
    assert.equal(statusAt(spec, at(WED, 15)).today, "11:30 am – 2:30 pm, 4:30 pm – 9:30 pm");
  });

  test("the day it opens next is named when it is not today or tomorrow", () => {
    assert.equal(statusAt("Th-Sa 17:00-23:00", at(MON, 12)).label, "Closed · opens Thu 5 pm");
  });

  test("24/7, closed, missing and unreadable each say so", () => {
    assert.equal(statusAt("24/7", at(WED, 3)).label, "Open 24 hours");
    assert.deepEqual(statusAt("closed", at(WED, 12)), { open: false, label: "Closed", today: "closed today" });
    assert.deepEqual(statusAt(undefined, at(WED, 12)), { open: null, label: "Hours not listed" });
    // Months, sunrise, week numbers: not guessed at. A map that says a place
    // is open when it is shut is worse than one that shrugs.
    for (const spec of ["Mo-Fr 08:00-17:00; Jan off", "sunrise-sunset", "Mo[1] 10:00-12:00", "Mo-Fr"]) {
      assert.deepEqual(statusAt(spec, at(WED, 12)), { open: null, label: "Hours unclear" }, spec);
    }
  });

  test("a day open round the clock says so, while the week around it keeps its hours", () => {
    const spec = "Mo-Fr 00:00-24:00; Sa,Su 10:00-18:00";
    assert.equal(statusAt(spec, at(WED, 3)).label, "Open all day");
    assert.equal(statusAt(spec, at(SAT, 12)).label, "Open · till 6 pm");
  });

  test("noon and midnight are said as words, not as 12 o'clock", () => {
    assert.equal(statusAt("Mo-Su 08:00-12:00", at(WED, 9)).label, "Open · till noon");
    assert.equal(statusAt("Mo-Su 18:00-24:00", at(WED, 19)).label, "Open · till midnight");
  });

  test("a week that is shut every day says closed, with no opening to promise", () => {
    assert.deepEqual(statusAt("Mo-Su off", at(WED, 12)), { open: false, label: "Closed", today: "closed today" });
  });

  test("impossible or contradictory hours are unclear, not guessed at", () => {
    // A map that says a place is open when it is shut is worse than one that
    // shrugs, so anything that can't be read straight is "Hours unclear".
    for (const spec of [
      "Mo-Fr 25:00-26:00", // no such hour
      "Mo-Fr 10:75-12:00", // no such minute
      "Mo 10:00-12:00 off", // open and off in one rule
      "Mo off 10:00-12:00",
      "Mo-Fr 10:00-12:00; Sa", // days with nothing after them
      "PH off", // holidays alone say nothing about an ordinary week
    ]) {
      assert.deepEqual(statusAt(spec, at(WED, 11)), { open: null, label: "Hours unclear" }, spec);
    }
  });

  test("a holidays rule beside a week is ignored for the week, not taken as the week", () => {
    assert.equal(statusAt("Mo-Fr 09:00-17:00; PH off", at(WED, 12)).label, "Open · till 5 pm");
  });

  test("a bare time range is every day", () => {
    assert.deepEqual(parseHours("11:30-22:00")?.map((d) => d.length), [1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("what OpenStreetMap sends back", () => {
  test("a building has a centre, a point has a position, and a place with no name is skipped", () => {
    const spots = spotsFrom([
      { type: "node", id: 1, lat: 44.23, lon: -76.48, tags: { name: "Chit Chat Café", amenity: "cafe" } },
      { type: "way", id: 2, center: { lat: 44.24, lon: -76.49 }, tags: { name: "Tango", amenity: "restaurant" } },
      { type: "node", id: 3, lat: 44.25, lon: -76.47, tags: { amenity: "fast_food" } },
    ]);
    assert.deepEqual(
      spots.map((s) => [s.id, s.name, s.lat]),
      [["node/1", "Chit Chat Café", 44.23], ["way/2", "Tango", 44.24]],
    );
  });

  test("a cuisine he names is looked for in the cuisine and in the name", () => {
    const spot = (name: string, cuisine?: string): Spot => ({
      id: "n", name, lat: 0, lon: 0, tags: { name, ...(cuisine ? { cuisine } : {}) },
    });
    assert.equal(fits(spot("Zen", "japanese;sushi"), "sushi"), true);
    assert.equal(fits(spot("Pizza Pizza"), "pizza"), true);
    assert.equal(fits(spot("Harper's", "burger"), "burgers"), true);
    assert.equal(fits(spot("Harper's", "burger"), "sushi"), false);
    // A wish is not a cuisine: "somewhere good to eat" narrows nothing.
    assert.equal(fits(spot("Harper's", "burger"), "somewhere good to eat"), true);
  });

  test("a place on the map is measured from his door and described in words", () => {
    const home = { lat: 44.2300000, lon: -76.4800000 };
    const place = toMapPlace(
      {
        id: "node/9",
        name: "SIMA Sushi",
        lat: 44.2338,
        lon: -76.4812,
        tags: {
          amenity: "restaurant",
          cuisine: "japanese;sushi",
          "addr:housenumber": "64",
          "addr:street": "Princess Street",
          opening_hours: "Mo-Su 11:30-21:15",
        },
      },
      home,
      at(WED, 14),
    );
    assert.equal(place.kind, "Restaurant");
    assert.equal(place.cuisine, "Japanese, sushi");
    assert.equal(place.address, "64 Princess Street");
    assert.equal(place.walkMin, walkMinutes(place.distanceM));
    assert.equal(place.status.label, "Open · till 9:15 pm");
  });

  test("minutes on foot allow for the grid: a straight 400 m is a six-minute walk", () => {
    assert.equal(walkMinutes(400), 6);
    assert.equal(walkMinutes(10), 1, "nothing is nearer than a minute");
  });

  test("the box around a circle is the circle's width each way", () => {
    const [s, w, n, e] = boxAround({ lat: 44.23, lon: -76.48 }, 1000).split(",").map(Number);
    assert.ok(Math.abs(n - s - 2000 / 111_320) < 1e-5);
    assert.ok(w < -76.48 && e > -76.48);
  });
});

describe("a street as one line", () => {
  // An east-west street in three pieces, sent out of order, the way
  // OpenStreetMap keeps a real one.
  const pieces = [
    { type: "way", id: 2, geometry: [{ lat: 44.23, lon: -76.47 }, { lat: 44.23, lon: -76.46 }] },
    { type: "way", id: 1, geometry: [{ lat: 44.23, lon: -76.49 }, { lat: 44.23, lon: -76.48 }] },
    { type: "way", id: 3, geometry: [{ lat: 44.23, lon: -76.48 }, { lat: 44.23, lon: -76.47 }] },
  ];

  test("comes out in order along the street, with the shared corners once", () => {
    const line = streetLine(pieces);
    assert.equal(line.length, 4);
    const lons = line.map((p) => p.lon);
    assert.ok(
      lons.every((v, i) => i === 0 || v > lons[i - 1]) || lons.every((v, i) => i === 0 || v < lons[i - 1]),
      `ordered along the street: ${lons}`,
    );
  });

  test("knows where a point is along it, and where a distance along it lands", () => {
    const line = streetLine(pieces);
    const total = lineLength(line);
    const middle = pointAt(line, total / 2);
    assert.ok(Math.abs(middle.lon - -76.475) < 1e-4, `middle at ${middle.lon}`);
    const where = positionOn(line, { lat: 44.2305, lon: -76.475 });
    assert.ok(Math.abs(where.at - total / 2) < 5, "half way along");
    assert.ok(Math.abs(where.off - 55.7) < 2, "about 56 m off the line");
    assert.deepEqual(pointAt(line, -50), line[0], "clamped at the ends");
  });
});

describe("the live map", () => {
  const home: Home = { lat: 44.2300000, lon: -76.4800000, label: "1 Example St" };
  /** Metres east and north of home, as a position. */
  const off = (east: number, north: number) => ({
    lat: home.lat + north / 111_320,
    lon: home.lon + east / (111_320 * Math.cos((home.lat * Math.PI) / 180)),
  });
  const node = (id: number, name: string, east: number, north: number, tags: Record<string, string> = {}) => ({
    type: "node", id, ...off(east, north), tags: { name, amenity: "restaurant", ...tags },
  });
  // Princess Street, running due west from his door for 2 km, with places
  // along it and one well off it.
  const street = Array.from({ length: 21 }, (_, i) => off(-i * 100, 0));
  const around = [
    node(1, "Door Café", 30, 10, { amenity: "cafe", opening_hours: "24/7" }),
    node(2, "Near Grill", -150, 20),
    node(3, "Mid Sushi", -900, 30, { cuisine: "sushi" }),
    // Outside a fifteen-minute walk (960 m), inside one expand of it (1,536 m).
    node(4, "Far Pizza", -1400, -40, { cuisine: "pizza" }),
    node(5, "Off Street Diner", -600, 500),
    node(6, "Pharmacy", 100, 100, { amenity: "pharmacy" }),
  ];

  function harness(opts: { noNetwork?: boolean; cacheFile?: string } = {}) {
    const calls: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      if (opts.noNetwork) throw new Error("offline");
      const body = typeof init?.body === "string" ? decodeURIComponent(init.body) : "";
      calls.push(url.includes("nominatim") ? "geocode" : body.includes('"highway"') ? "street" : "places");
      const json = url.includes("nominatim")
        ? [{ lat: String(street[5].lat), lon: String(street[5].lon), name: "Princess Street", category: "highway" }]
        : body.includes('"highway"')
          ? { elements: [{ type: "way", id: 99, geometry: street }] }
          : { elements: around };
      return new Response(JSON.stringify(json), { status: 200 });
    };
    const dir = mkdtempSync(join(tmpdir(), "vela-places-"));
    const seen: MapState[] = [];
    const map = createPlaces({
      fetcher,
      home: () => home,
      cacheFile: opts.cacheFile ?? join(dir, "cache.json"),
      now: () => at(WED, 14),
    });
    map.onChange((s) => seen.push(s));
    return { map, calls, seen, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("a search puts places on the map, nearest his door first, and tells her how to go on", async () => {
    const h = harness();
    const said = await h.map.find({ what: "food" });
    const state = h.map.state()!;
    assert.deepEqual(
      state.places.map((p) => p.name),
      ["Door Café", "Near Grill", "Off Street Diner", "Mid Sushi"],
      "food, not the pharmacy; within a fifteen-minute walk; in walking order",
    );
    assert.equal(state.title, "Food near home");
    assert.match(said, /use map_view on this same map/, "the refinements have to move this map, not make another");
    assert.equal(h.seen.length, 1, "and the page is told");
    h.done();
  });

  test("expanding widens the same map instead of starting a new one", async () => {
    const h = harness();
    await h.map.find({ what: "food" });
    const before = h.map.state()!;
    await h.map.view({ action: "expand" });
    const after = h.map.state()!;
    assert.ok(after.seq > before.seq, "a change the page can see");
    assert.deepEqual(after.center, before.center, "the same place, looked at from further out");
    assert.equal(after.radiusM, Math.round(before.radiusM * 1.6));
    assert.ok(after.places.some((p) => p.name === "Far Pizza"), "and further places come into it");
    h.done();
  });

  test("a street search starts at his door and 'further' walks away from it, 'back' walks home", async () => {
    const h = harness();
    await h.map.find({ what: "food", near: "Princess Street" });
    const start = h.map.state()!;
    assert.equal(start.title, "Food on Princess Street");
    assert.ok(start.street && start.street.length > 2, "the street is drawn");
    assert.ok(!start.places.some((p) => p.name === "Off Street Diner"), "on the street means on the street");

    const dist = () => {
      const c = h.map.state()!.center;
      return Math.hypot((c.lon - home.lon) * 111_320 * Math.cos((home.lat * Math.PI) / 180), (c.lat - home.lat) * 111_320);
    };
    const d0 = dist();
    await h.map.view({ action: "move", direction: "further" });
    const d1 = dist();
    await h.map.view({ action: "move" });
    const d2 = dist();
    // 900 m along the street: out of the first stretch, in the one two steps on.
    assert.ok(!start.places.some((p) => p.name === "Mid Sushi"));
    assert.ok(h.map.state()!.places.some((p) => p.name === "Mid Sushi"), "places along the way come into view");
    await h.map.view({ action: "move", direction: "back" });
    const d3 = dist();
    assert.ok(d1 > d0 + 300 && d2 > d1 + 300, `further twice goes further: ${d0} → ${d1} → ${d2}`);
    assert.ok(d3 < d2 - 300, `and back comes back: ${d2} → ${d3}`);
    h.done();
  });

  test("picking one out opens its card on the map and gives her the directions", async () => {
    const h = harness();
    await h.map.find({ what: "food" });
    const said = await h.map.view({ action: "focus", place: "2" });
    assert.equal(h.map.state()!.focus, h.map.state()!.places[1].id);
    assert.match(said, /google\.com\/maps\/dir\/.*travelmode=walking/);
    const byName = await h.map.view({ action: "focus", place: "door café" });
    assert.match(byName, /Door Café/);
    assert.match(await h.map.view({ action: "focus", place: "Nowhere" }), /No "Nowhere" on the map/);
    h.done();
  });

  test("with no map up, a change says so rather than inventing one", async () => {
    const h = harness();
    assert.match(await h.map.view({ action: "expand" }), /no map up/i);
    h.done();
  });

  test("what was fetched once is answered from the cache next time, network or not", async () => {
    const first = harness();
    await first.map.warm();
    assert.ok(existsSync(join(first.dir, "cache.json")));
    const again = harness({ noNetwork: true, cacheFile: join(first.dir, "cache.json") });
    await again.map.find({ what: "cafe" });
    assert.deepEqual(again.map.state()!.places.map((p) => p.name), ["Door Café"]);
    first.done();
    again.done();
  });
});

describe("the live map, off the happy path", () => {
  const home: Home = { lat: 44.2300000, lon: -76.4800000, label: "1 Example St" };
  const east = (m: number) => home.lon + m / (111_320 * Math.cos((home.lat * Math.PI) / 180));
  const places = [
    { type: "node", id: 1, lat: home.lat, lon: east(-200), tags: { name: "West Sushi", amenity: "restaurant", cuisine: "sushi" } },
    { type: "node", id: 2, lat: home.lat, lon: east(300), tags: { name: "East Café", amenity: "cafe" } },
  ];
  const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

  function mapWith(fetcher: (url: string, init?: RequestInit) => Promise<Response>, h: Home | null = home) {
    const dir = mkdtempSync(join(tmpdir(), "vela-places-"));
    return {
      map: createPlaces({ fetcher, home: () => h, cacheFile: join(dir, "cache.json"), now: () => at(WED, 14) }),
      done: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("a cuisine names the map, and only that cuisine is on it", async () => {
    const { map, done } = mapWith(async () => ok({ elements: places }));
    await map.find({ what: "food", cuisine: "sushi" });
    assert.equal(map.state()!.title, "Sushi near home");
    assert.deepEqual(map.state()!.places.map((p) => p.name), ["West Sushi"]);
    done();
  });

  test("closer tightens, a compass move slides, and home comes back to his door", async () => {
    const { map, done } = mapWith(async () => ok({ elements: places }));
    await map.find({ what: "food" });
    const start = map.state()!;
    await map.view({ action: "closer" });
    assert.equal(map.state()!.radiusM, Math.round(start.radiusM / 1.6));
    await map.view({ action: "move", direction: "east", meters: 500 });
    assert.ok(map.state()!.center.lon > start.center.lon, "east is east");
    assert.match(await map.view({ action: "move", direction: "sideways" }), /Move which way/);
    await map.view({ action: "home" });
    assert.deepEqual(map.state()!.center, { lat: home.lat, lon: home.lon });
    done();
  });

  test("the end of a street is said, not walked past", async () => {
    const line = [0, -100, -200].map((m) => ({ lat: home.lat, lon: east(m) }));
    const { map, done } = mapWith(async (url, init) => {
      if (url.includes("nominatim")) return ok([{ lat: String(home.lat), lon: String(home.lon), name: "Short Lane", category: "highway" }]);
      const body = decodeURIComponent(String(init?.body ?? ""));
      return ok(body.includes('"highway"') ? { elements: [{ type: "way", id: 7, geometry: line }] } : { elements: places });
    });
    await map.find({ what: "food", near: "Short Lane" });
    await map.view({ action: "move", meters: 500 });
    assert.match(await map.view({ action: "move", meters: 500 }), /end of Short Lane/);
    done();
  });

  test("a place that cannot be found is a question for him, not a map of nowhere", async () => {
    const { map, done } = mapWith(async () => ok([]));
    assert.match(await map.find({ what: "food", near: "Atlantis" }), /Couldn't find "Atlantis".*Ask him/);
    assert.equal(map.state(), null);
    done();
  });

  test("when the first map server fails, the second one answers", async () => {
    const asked: string[] = [];
    const { map, done } = mapWith(async (url, init) => {
      // Only the places queries: the streets learned in the background are
      // their own concern.
      if (!decodeURIComponent(String(init?.body ?? "")).includes("amenity")) return ok({ elements: [] });
      asked.push(new URL(url).host);
      return asked.length === 1 ? new Response("busy", { status: 429 }) : ok({ elements: places });
    });
    await map.warm();
    await map.find({ what: "cafe" });
    assert.deepEqual(map.state()!.places.map((p) => p.name), ["East Café"]);
    assert.equal(asked.length, 2, "one refusal, one answer");
    assert.notEqual(asked[0], asked[1]);
    done();
  });

  test("with no home set, it says where to put one", async () => {
    const { map, done } = mapWith(async () => ok({ elements: places }), null);
    await assert.rejects(map.find({ what: "food" }), /data\/home\.json/);
    done();
  });
});

describe("the map's memory", () => {
  const home: Home = { lat: 44.2300000, lon: -76.4800000, label: "1 Example St" };
  const cafe = { type: "node", id: 1, lat: home.lat + 0.001, lon: home.lon, tags: { name: "Door Café", amenity: "cafe" } };

  test("his home is read from its file, and a missing or broken one is no home rather than a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "vela-home-"));
    const file = join(dir, "home.json");
    assert.equal(loadHome(file), null, "no file");
    writeFileSync(file, "{ not json");
    assert.equal(loadHome(file), null, "a file that isn't JSON");
    writeFileSync(file, JSON.stringify({ label: "1 Example St", lat: 44.23, lon: -76.48 }));
    assert.deepEqual(loadHome(file), { label: "1 Example St", lat: 44.23, lon: -76.48 });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a cache from yesterday, or from somewhere else, is fetched again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vela-places-"));
    const cacheFile = join(dir, "cache.json");
    let fetched = 0;
    const fetcher = async (_url: string, init?: RequestInit) => {
      if (decodeURIComponent(String(init?.body ?? "")).includes("amenity")) fetched++;
      return new Response(JSON.stringify({ elements: [cafe] }), { status: 200 });
    };
    const make = () => createPlaces({ fetcher, home: () => home, cacheFile });
    const old = { center: home, radiusM: 3500, at: Date.now() - 25 * 3600_000, spots: [] };
    writeFileSync(cacheFile, JSON.stringify(old));
    await make().warm();
    assert.equal(fetched, 1, "a day old is too old");
    writeFileSync(cacheFile, JSON.stringify({ ...old, at: Date.now(), center: { lat: 45.5, lon: -73.6 } }));
    await make().warm();
    assert.equal(fetched, 2, "a cache built around Montreal says nothing about Kingston");
    await make().warm();
    assert.equal(fetched, 2, "and a fresh one around his door is used as it is");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a search that finds nothing tells her to offer a wider one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vela-places-"));
    const map = createPlaces({
      fetcher: async () => new Response(JSON.stringify({ elements: [cafe] }), { status: 200 }),
      home: () => home,
      cacheFile: join(dir, "cache.json"),
    });
    assert.match(await map.find({ what: "pharmacy" }), /Nothing matched here.*map_view expand/s);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a page that stops listening is not told about the next change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vela-places-"));
    const map = createPlaces({
      fetcher: async () => new Response(JSON.stringify({ elements: [cafe] }), { status: 200 }),
      home: () => home,
      cacheFile: join(dir, "cache.json"),
    });
    let told = 0;
    const stop = map.onChange(() => told++);
    await map.find({ what: "cafe" });
    stop();
    await map.view({ action: "expand" });
    assert.equal(told, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("streets are known before he names them", () => {
  test("a street near home is learned in the background, so naming it never waits on the network", async () => {
    // Asked for at the moment he named it, Princess Street waited 8 seconds on
    // a server that answered everything else in one — and the fallback put the
    // search at the wrong end of the street. Learned at startup, it costs
    // nothing when he asks, whatever the servers are doing by then.
    const home: Home = { lat: 44.2300000, lon: -76.4800000, label: "1 Example St" };
    const east = (m: number) => home.lon + m / (111_320 * Math.cos((home.lat * Math.PI) / 180));
    const line = [0, -300, -600].map((m) => ({ lat: home.lat, lon: east(m) }));
    const dir = mkdtempSync(join(tmpdir(), "vela-places-"));
    let down = false;
    let asked = 0;
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.includes("nominatim")) {
        return new Response(JSON.stringify([{ lat: String(home.lat), lon: String(home.lon), name: "Princess Street", category: "highway" }]));
      }
      if (down) throw new Error("timed out");
      const body = decodeURIComponent(String(init?.body ?? ""));
      if (body.includes("[\"name\"=")) asked++;
      const streets = [{ type: "way", id: 1, tags: { name: "Princess Street", highway: "primary" }, geometry: line }];
      return new Response(JSON.stringify({ elements: body.includes("\"highway\"") ? streets : [] }));
    };
    const make = () => createPlaces({ fetcher, home: () => home, cacheFile: join(dir, "cache.json") });
    const first = make();
    await first.warm();
    await new Promise((r) => setTimeout(r, 0));
    down = true;
    const later = make();
    await later.find({ what: "food", near: "Princess Street" });
    assert.equal(asked, 0, "never asked for by name");
    assert.equal(later.state()!.street!.length, 3, "and drawn from what was learned, by a fresh start, offline");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("what she is told", () => {
  test("her numbers are the list's numbers, and she is told which is the nearest open one", async () => {
    // Her summary once ranked open places first, so "number one" to her was
    // a different place from number one on his screen, and focusing it picked
    // the wrong one. The list is in walking order; so are her numbers.
    const home: Home = { lat: 44.2300000, lon: -76.4800000, label: "1 Example St" };
    const north = (m: number) => home.lat + m / 111_320;
    const elements = [
      { type: "node", id: 1, lat: north(80), lon: home.lon, tags: { name: "Shut Sushi", amenity: "restaurant", opening_hours: "Mo-Su 17:00-22:00" } },
      { type: "node", id: 2, lat: north(300), lon: home.lon, tags: { name: "Open Sushi", amenity: "restaurant", opening_hours: "Mo-Su 11:00-22:00" } },
    ];
    const dir = mkdtempSync(join(tmpdir(), "vela-places-"));
    const map = createPlaces({
      fetcher: async () => new Response(JSON.stringify({ elements })),
      home: () => home,
      cacheFile: join(dir, "cache.json"),
      now: () => at(WED, 14),
    });
    const said = await map.find({ what: "food" });
    assert.match(said, /1\. Shut Sushi[\s\S]*2\. Open Sushi/);
    assert.match(said, /Nearest open, already picked out on his map with its card open: number 2, Open Sushi/);
    await map.view({ action: "focus", place: "1" });
    assert.equal(map.state()!.places.find((p) => p.id === map.state()!.focus)!.name, "Shut Sushi");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the edges of finding places", () => {
  test("a place drawn as an outline goes on the map at its centre; one with no position or no name doesn't", () => {
    const spots = spotsFrom([
      { type: "way", id: 1, center: { lat: 44.23, lon: -76.49 }, tags: { name: "Outlined Café", amenity: "cafe" } },
      { type: "node", id: 2, tags: { name: "Nowhere Diner", amenity: "restaurant" } },
      { type: "node", id: 3, lat: 44.23, lon: -76.49, tags: { amenity: "restaurant" } },
      { type: "node", id: 4, lat: 44.23, lon: -76.49, tags: { name: "   ", amenity: "bar" } },
    ]);
    assert.deepEqual(
      spots.map((s) => [s.id, s.name, s.lat]),
      [["way/1", "Outlined Café", 44.23]],
      "a pin with no place to go, or no name to say, is a pin he can't use",
    );
  });

  test("asking for 'something good to eat' narrows nothing, since none of it is a kind of food", () => {
    const pizza = { id: "n/1", name: "Pizza Pizza", tags: { cuisine: "pizza" }, lat: 0, lon: 0 };
    assert.equal(fits(pizza, "something good to eat"), true);
    assert.equal(fits(pizza, "sushi"), false);
    assert.equal(fits(pizza, "pizzas"), true, "a plural is the same food");
  });

  test("walking a street stops at its ends, and a repeated point doesn't stall the walk", () => {
    const a = { lat: 44.23, lon: -76.49 };
    const b = { lat: 44.24, lon: -76.49 };
    assert.deepEqual(pointAt([a, b], -50), a, "before the start is the start");
    assert.deepEqual(pointAt([a, b], 1e6), b, "past the end is the end");
    const doubled = pointAt([a, a, b], 100);
    assert.ok(doubled.lat > a.lat && doubled.lat < b.lat, "a zero-length step must not end the walk at its first point");
  });
});
