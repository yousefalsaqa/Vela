import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestImage, lookUp, inlineImage, esc, pictureCard, gist, showPicture, type Fetcher } from "../src/picture.js";
import { clear, current } from "../src/screen.js";

/**
 * A Wikipedia that answers from a table: a URL fragment to what comes back.
 * Every URL asked for is recorded, so a test can say what was never fetched.
 */
function wiki(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    for (const [part, answer] of Object.entries(routes)) if (url.includes(part)) return answer();
    return new Response("not found", { status: 404 });
  };
  return { fetcher, asked };
}
const json = (body: unknown) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const png = (bytes = 64) => () => new Response(Buffer.alloc(bytes, 7), { headers: { "content-type": "image/png" } });

const APOLLO = {
  type: "standard",
  title: "Apollo 11",
  description: "First crewed Moon landing",
  extract: "Apollo 11 was the first spaceflight to land humans on the Moon. It launched in July 1969. It returned safely.",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Apollo_11" } },
  thumbnail: { source: "https://upload.wikimedia.org/thumb/a/320px-Aldrin.jpg" },
  originalimage: { source: "https://upload.wikimedia.org/a/Aldrin.jpg", width: 3000 },
};

describe("bestImage", () => {
  test("the original when it is small enough to be worth fetching whole", () => {
    assert.equal(bestImage({ originalimage: { source: "o.jpg", width: 800 } }), "o.jpg");
  });

  test("a large original is fetched as a thumbnail at a width Wikimedia actually serves", () => {
    // 960 loads; 1000 comes back 400.
    assert.equal(bestImage(APOLLO), "https://upload.wikimedia.org/thumb/a/960px-Aldrin.jpg");
  });

  test("an original with nothing smaller is still better than no picture", () => {
    assert.equal(bestImage({ originalimage: { source: "huge.jpg", width: 9000 } }), "huge.jpg");
    assert.equal(bestImage({}), undefined);
  });
});

describe("lookUp", () => {
  test("finds the article by its title, with what the card needs", async () => {
    const { fetcher } = wiki({ "page/summary/Apollo_11": json(APOLLO) });
    assert.deepEqual(await lookUp("Apollo 11", fetcher), {
      title: "Apollo 11",
      description: "First crewed Moon landing",
      extract: APOLLO.extract,
      page: "https://en.wikipedia.org/wiki/Apollo_11",
      image: "https://upload.wikimedia.org/thumb/a/960px-Aldrin.jpg",
    });
  });

  test("a near title falls back to the first thing a title search finds", async () => {
    const { fetcher } = wiki({
      "page/summary/the_moon_landing": () => new Response("", { status: 404 }),
      "search/title": json({ pages: [{ key: "Apollo_11" }] }),
      "page/summary/Apollo_11": json(APOLLO),
    });
    assert.equal((await lookUp("the moon landing", fetcher))?.title, "Apollo 11");
  });

  test("a disambiguation page is refused with how to fix it, because a card of 'may refer to' is worse than asking", async () => {
    const { fetcher } = wiki({ "page/summary/Mercury": json({ type: "disambiguation", title: "Mercury" }) });
    await assert.rejects(lookUp("Mercury", fetcher), /several things called "Mercury".*"Mercury \(planet\)"/);
  });

  test("nothing found anywhere is null, not a card of nothing", async () => {
    assert.equal(await lookUp("xqzzy", wiki({ "search/title": json({ pages: [] }) }).fetcher), null);
    assert.equal(await lookUp("xqzzy", wiki({}).fetcher), null, "a search that fails is nothing found");
    assert.equal(await lookUp("Odd", wiki({ "page/summary/Odd": json({ type: "standard" }) }).fetcher), null);
  });
});

describe("inlineImage", () => {
  test("an image comes back as a data: URI, so the sandboxed page needs no network", async () => {
    const uri = await inlineImage("https://x/a.png", wiki({ "a.png": png(3) }).fetcher);
    assert.equal(uri, `data:image/png;base64,${Buffer.alloc(3, 7).toString("base64")}`);
  });

  test("anything that isn't an http image, or is empty or enormous, is refused", async () => {
    const { fetcher, asked } = wiki({
      "page.html": () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      "empty.png": png(0),
      "huge.png": png(6 * 1024 * 1024 + 1),
      "gone.png": () => new Response("", { status: 404 }),
    });
    assert.equal(await inlineImage("file:///C:/secret.png", fetcher), null);
    assert.deepEqual(asked, [], "a local path is never fetched");
    for (const url of ["https://x/page.html", "https://x/empty.png", "https://x/huge.png", "https://x/gone.png"]) {
      assert.equal(await inlineImage(url, fetcher), null, url);
    }
  });
});

describe("esc and pictureCard", () => {
  test("Wikipedia's words are escaped before they reach her screen", () => {
    assert.equal(esc(`<b>"Tom" & 'Jerry'</b>`), "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
    const page = pictureCard({ title: "<script>alert(1)</script>", facts: [], timeline: [] });
    assert.ok(!page.includes("<script>alert"), "a title must not be able to run in her page");
  });

  test("lays out a photo beside the words when there is one, and the words alone when not", () => {
    const withPhoto = pictureCard({
      title: "Apollo 11",
      image: "data:image/png;base64,AAAA",
      caption: "Aldrin on the Moon",
      kicker: "First crewed Moon landing",
      summary: "The first landing.",
      facts: [{ label: "Crew", value: "3" }],
      timeline: [{ when: "1969", what: "Launch" }],
      source: "Wikipedia · Apollo 11",
    });
    assert.match(withPhoto, /<figure class="photo"><img src="data:image\/png;base64,AAAA" alt="Apollo 11"><figcaption>Aldrin on the Moon<\/figcaption>/);
    assert.match(withPhoto, /minmax\(0, 1\.1fr\) minmax\(0, 1fr\)/);
    assert.match(withPhoto, /<dt>Crew<\/dt><dd>3<\/dd>/);
    assert.match(withPhoto, /<span class="when">1969<\/span><span class="what">Launch<\/span>/);
    const wordsOnly = pictureCard({ title: "Apollo 11", facts: [], timeline: [] });
    assert.ok(!wordsOnly.includes("<figure") && !wordsOnly.includes("<dl>") && !wordsOnly.includes("<ol>"));
  });
});

describe("gist", () => {
  test("the first two sentences, for her to speak from", () => {
    assert.equal(gist(APOLLO.extract), "Apollo 11 was the first spaceflight to land humans on the Moon. It launched in July 1969.");
  });

  test("text with no sentence ending is given whole", () => {
    assert.equal(gist("  Apollo 11  "), "Apollo 11");
  });
});

describe("showPicture", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vela-picture-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => clear());

  test("finds it, builds the card with the photo inlined, puts it up, and hands her the gist", async () => {
    const { fetcher } = wiki({ "page/summary/Apollo_11": json(APOLLO), "960px-Aldrin.jpg": png() });
    const said = await showPicture({ subject: "Apollo 11", facts: [{ label: "Crew", value: "3" }] }, { fetcher, dir });
    const shown = current();
    assert.ok(shown, "the card is on her screen");
    assert.match(shown!.path, /picture-apollo-11-[0-9a-f]{6}\.html$/);
    const page = readFileSync(shown!.path, "utf8");
    assert.match(page, /data:image\/png;base64,/, "the photo is inside the page, not linked");
    assert.match(page, /Wikipedia · https:\/\/en\.wikipedia\.org\/wiki\/Apollo_11/);
    assert.match(said, /Wikipedia: Apollo 11 was the first spaceflight/);
    assert.ok(!/words only/.test(said));
  });

  test("a disambiguation is passed on whole, and nothing goes up", async () => {
    const { fetcher } = wiki({ "page/summary/Mercury": json({ type: "disambiguation", title: "Mercury" }) });
    const said = await showPicture({ subject: "Mercury" }, { fetcher, dir: join(dir, "none") });
    assert.match(said, /several things called "Mercury"/);
    assert.equal(current(), null);
  });

  test("nothing on Wikipedia and nothing given to build from says so, and tries nothing else", async () => {
    const said = await showPicture({ subject: "xqzzy" }, { fetcher: wiki({}).fetcher, dir });
    assert.match(said, /Wikipedia has nothing called "xqzzy".*image_url/);
    assert.equal(current(), null);
  });

  test("a photo that won't load still leaves a card, and she is told it has words only", async () => {
    const { fetcher } = wiki({ "page/summary/Apollo_11": json(APOLLO), "960px-Aldrin.jpg": () => new Response("", { status: 500 }) });
    const said = await showPicture({ subject: "Apollo 11" }, { fetcher, dir });
    assert.ok(current());
    assert.match(said, /The photo would not load, so the card has words only/);
  });

  test("a subject with no photo at all says that, not that one failed", async () => {
    const { fetcher } = wiki({ "page/summary/Pi": json({ type: "standard", title: "Pi", extract: "Pi is a number." }) });
    assert.match(await showPicture({ subject: "Pi" }, { fetcher, dir }), /There is no photo for it on Wikipedia/);
  });

  test("Wikipedia being down doesn't stop a card made from what she brought", async () => {
    // A lookup that throws is nothing found, not the end: her facts and her
    // own photo are still a card.
    const fetcher: Fetcher = async (url) => {
      if (url.includes("wikipedia.org")) throw new Error("offline");
      return png()();
    };
    const facts = Array.from({ length: 12 }, (_, i) => ({ label: `F${i}`, value: String(i) }));
    const said = await showPicture({ subject: "My Robot", facts, imageUrl: "https://x/robot.png", title: "My robot arm" }, { fetcher, dir });
    const page = readFileSync(current()!.path, "utf8");
    assert.match(page, /My robot arm/);
    assert.equal((page.match(/class="fact"/g) ?? []).length, 8, "a card holds at most eight facts");
    assert.ok(!/Wikipedia/.test(said));
  });

  test("each card is its own file, so showing another never overwrites the one before", async () => {
    const { fetcher } = wiki({ "page/summary/Pi": json({ type: "standard", title: "Pi" }) });
    const own = join(dir, "twice");
    await showPicture({ subject: "Pi" }, { fetcher, dir: own });
    await showPicture({ subject: "Pi" }, { fetcher, dir: own });
    assert.equal(readdirSync(own).length, 2);
  });
});
