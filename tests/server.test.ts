import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serve,
  readEndpoint,
  CUT_OFF,
  type RunningServer,
  type ServableCore,
} from "../src/server.js";
import { connect, reachable, parseFrames } from "../src/client.js";
import type { CoreEvent } from "../src/core.js";

/** A core that records what it was told and emits whatever the test wants. */
function fakeCore() {
  const sent: string[] = [];
  const listeners = new Set<(e: CoreEvent) => void>();
  let busy = false;
  const core: ServableCore = {
    send: (text) => {
      sent.push(text);
      busy = true;
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    isBusy: () => busy,
  };
  return {
    core,
    sent,
    setBusy: (b: boolean) => (busy = b),
    emit: (e: CoreEvent) => listeners.forEach((l) => l(e)),
    listenerCount: () => listeners.size,
  };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("parseFrames", () => {
  test("splits complete frames and keeps the remainder", () => {
    const { events, rest } = parseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
    assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
    assert.equal(rest, 'data: {"c"');
  });

  test("ignores comment keep-alives", () => {
    const { events } = parseFrames(": connected\n\ndata: {}\n\n");
    assert.deepEqual(events, ["{}"]);
  });

  test("returns nothing for a partial frame", () => {
    const { events, rest } = parseFrames("data: {\"half\"");
    assert.deepEqual(events, []);
    assert.equal(rest, 'data: {"half"');
  });
});

describe("the local server", () => {
  let dir: string;
  let endpointFile: string;
  let fake: ReturnType<typeof fakeCore>;
  let running: RunningServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-server-"));
    endpointFile = join(dir, "server.json");
    fake = fakeCore();
    running = await serve({ core: fake.core, endpointFile });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("listens on loopback only", () => {
    assert.ok(running.endpoint.port > 0);
    assert.ok(running.endpoint.token.length >= 32, "token must not be guessable");
  });

  test("advertises itself in a file, and cleans up on close", async () => {
    const advertised = readEndpoint(endpointFile);
    assert.equal(advertised?.port, running.endpoint.port);
    assert.equal(advertised?.token, running.endpoint.token);
    await running.close();
    assert.equal(existsSync(endpointFile), false, "a stale endpoint file misleads clients");
    running = await serve({ core: fake.core, endpointFile }); // for afterEach
  });

  test("readEndpoint returns null when nothing is running", () => {
    assert.equal(readEndpoint(join(dir, "nope.json")), null);
  });

  describe("the token", () => {
    const url = (r: RunningServer, path: string) => `http://127.0.0.1:${r.endpoint.port}${path}`;

    test("refuses a request without one", async () => {
      const res = await fetch(url(running, "/health"));
      assert.equal(res.status, 401);
    });

    test("refuses a wrong one", async () => {
      const res = await fetch(url(running, "/health"), {
        headers: { authorization: "Bearer not-the-token" },
      });
      assert.equal(res.status, 401);
    });

    test("accepts the right one", async () => {
      assert.equal(await reachable(running.endpoint), true);
    });

    test("reachable is false for a port with nothing on it", async () => {
      assert.equal(await reachable({ port: 1, token: "x", pid: 0 }), false);
    });
  });

  describe("a connected client", () => {
    test("receives events as the core emits them", async () => {
      const client = await connect(running.endpoint);
      const seen: CoreEvent[] = [];
      client.subscribe((e) => seen.push(e));
      await until(() => fake.listenerCount() > 0, "the server to subscribe");

      fake.emit({ type: "delta", text: "hello" });
      fake.emit({ type: "result", ms: 1200 });
      await until(() => seen.length === 2, "both events");

      assert.deepEqual(seen, [
        { type: "delta", text: "hello" },
        { type: "result", ms: 1200 },
      ]);
      client.stop();
    });

    test("delivers a turn to the core", async () => {
      const client = await connect(running.endpoint);
      client.send("do the thing");
      await until(() => fake.sent.length > 0, "the turn to arrive");
      assert.deepEqual(fake.sent, ["do the thing"]);
      client.stop();
    });

    test("tracks busy from the events, not from guesswork", async () => {
      const client = await connect(running.endpoint);
      assert.equal(client.isBusy(), false);
      client.send("work");
      assert.equal(client.isBusy(), true);
      fake.emit({ type: "result", ms: 10 });
      await until(() => !client.isBusy(), "busy to clear on the result");
      client.stop();
    });

    test("an unprompted say reaches it like anything else", async () => {
      const client = await connect(running.endpoint);
      const seen: CoreEvent[] = [];
      client.subscribe((e) => seen.push(e));
      await until(() => fake.listenerCount() > 0, "the server to subscribe");
      fake.emit({ type: "say", text: "Build succeeded." });
      await until(() => seen.length === 1, "the interjection");
      assert.deepEqual(seen[0], { type: "say", text: "Build succeeded." });
      client.stop();
    });

    test("two clients both see everything", async () => {
      const a = await connect(running.endpoint);
      const b = await connect(running.endpoint);
      const seenA: CoreEvent[] = [];
      const seenB: CoreEvent[] = [];
      a.subscribe((e) => seenA.push(e));
      b.subscribe((e) => seenB.push(e));
      await until(() => fake.listenerCount() > 0, "subscription");

      fake.emit({ type: "delta", text: "shared" });
      await until(() => seenA.length === 1 && seenB.length === 1, "both clients");
      assert.deepEqual(seenA, seenB, "a voice client and the REPL must agree");
      a.stop();
      b.stop();
    });
  });

  describe("bad requests", () => {
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${running.endpoint.port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${running.endpoint.token}`,
          ...(init.headers ?? {}),
        },
      });

    test("an empty turn is rejected rather than sent", async () => {
      const res = await call("/turn", { method: "POST", body: JSON.stringify({ text: "  " }) });
      assert.equal(res.status, 400);
      assert.deepEqual(fake.sent, []);
    });

    test("a non-JSON body is rejected", async () => {
      const res = await call("/turn", { method: "POST", body: "not json" });
      assert.equal(res.status, 400);
    });

    test("an unknown route is a 404", async () => {
      assert.equal((await call("/nope")).status, 404);
    });

    test("health reports what the core is doing", async () => {
      fake.setBusy(true);
      const res = await call("/health");
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { busy: boolean }).busy, true);
    });
  });
});

describe("the hub's door", () => {
  let dir: string;
  let running: RunningServer;
  let fake: ReturnType<typeof fakeCore>;

  const at = (path: string) => `http://127.0.0.1:${running.endpoint.port}${path}`;
  const withKey = (path: string) =>
    at(`${path}${path.includes("?") ? "&" : "?"}k=${running.endpoint.token}`);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-hub-"));
    fake = fakeCore();
    running = await serve({ core: fake.core, endpointFile: join(dir, "server.json") });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("serves the page, because a browser cannot set a header on a navigation", async () => {
    const res = await fetch(withKey("/"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /<title>Vela<\/title>/);
  });

  test("/hub is the same page, for a link worth typing", async () => {
    assert.equal((await fetch(withKey("/hub"))).status, 200);
  });

  test("the header still works, so the REPL client is untouched", async () => {
    const res = await fetch(at("/health"), {
      headers: { authorization: `Bearer ${running.endpoint.token}` },
    });
    assert.equal(res.status, 200);
  });

  test("a wrong key in the query is still a locked door", async () => {
    assert.equal((await fetch(at("/?k=not-the-token"))).status, 401);
    assert.equal((await fetch(at("/"))).status, 401);
  });

  test("the query token opens the event stream, which is the whole point", async () => {
    const res = await fetch(withKey("/events"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /event-stream/);
    await res.body?.cancel();
  });

  test("a query string does not stop a route being found", async () => {
    const res = await fetch(withKey("/health"));
    assert.equal(res.status, 200);
    const health = (await res.json()) as { pid: number };
    assert.equal(health.pid, process.pid);
  });

  test("an unknown path is still a 404, not the page", async () => {
    assert.equal((await fetch(withKey("/nope"))).status, 404);
  });
});

describe("ears and a voice", () => {
  let dir: string;
  let running: RunningServer;
  let fake: ReturnType<typeof fakeCore>;
  let heard: Buffer[];

  const at = (p: string) => `http://127.0.0.1:${running.endpoint.port}${p}`;

  async function up(extra: Partial<Parameters<typeof serve>[0]> = {}) {
    dir = mkdtempSync(join(tmpdir(), "vela-voice-"));
    fake = fakeCore();
    heard = [];
    running = await serve({
      core: fake.core,
      endpointFile: join(dir, "server.json"),
      ...extra,
    });
  }

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("says plainly when it has neither, so the hub hides the buttons", async () => {
    await up();
    const health = (await (
      await fetch(at("/health"), { headers: { authorization: `Bearer ${running.endpoint.token}` } })
    ).json()) as { canHear: boolean; canSpeak: boolean };
    assert.equal(health.canHear, false);
    assert.equal(health.canSpeak, false);
  });

  test("a service with no ears refuses rather than pretending", async () => {
    await up();
    const res = await fetch(at(`/hear?k=${running.endpoint.token}`), {
      method: "POST",
      body: Buffer.from([1, 2, 3]),
    });
    assert.equal(res.status, 501);
  });

  test("hands the recording over as bytes, not as text", async () => {
    // Opus is binary; decoding it as utf8 anywhere in the path corrupts it.
    const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0xfe]);
    await up({ hear: async (a) => { heard.push(a); return "what he said"; } });

    const res = await fetch(at(`/hear?k=${running.endpoint.token}`), {
      method: "POST",
      body: audio,
    });

    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as unknown, { text: "what he said" });
    assert.deepEqual(heard[0], audio, "the bytes must arrive unchanged");
  });

  test("a transcriber that throws is a 500, not a hung request", async () => {
    await up({ hear: async () => { throw new Error("worker died"); } });
    const res = await fetch(at(`/hear?k=${running.endpoint.token}`), { method: "POST", body: "x" });
    assert.equal(res.status, 500);
  });

  test("returns her sentence as a wav the browser can play", async () => {
    const wav = Buffer.from("RIFF....WAVEfmt ");
    await up({ render: async () => wav });

    const res = await fetch(at(`/speak?k=${running.endpoint.token}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Loud and clear." }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), wav);
  });

  test("refuses an empty sentence rather than synthesising silence", async () => {
    await up({ render: async () => Buffer.from("wav") });
    const res = await fetch(at(`/speak?k=${running.endpoint.token}`), {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(res.status, 400);
  });

  test("a render that comes back empty is reported, not played as silence", async () => {
    await up({ render: async () => null });
    const res = await fetch(at(`/speak?k=${running.endpoint.token}`), {
      method: "POST",
      body: JSON.stringify({ text: "anything" }),
    });
    assert.equal(res.status, 500);
  });
});

describe("being talked over", () => {
  let dir: string;
  let running: RunningServer;
  let fake: ReturnType<typeof fakeCore>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-cut-"));
    fake = fakeCore();
    running = await serve({ core: fake.core, endpointFile: join(dir, "server.json") });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const turn = (body: unknown) =>
    fetch(`http://127.0.0.1:${running.endpoint.port}/turn?k=${running.endpoint.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("an ordinary turn reaches her exactly as typed", async () => {
    await turn({ text: "what is on my calendar" });
    assert.deepEqual(fake.sent, ["what is on my calendar"]);
  });

  test("cutting her off tells her so, in the same turn", async () => {
    // Talking over her is the clearest feedback there is, and it is wasted if
    // she never learns it happened.
    await turn({ text: "stop, just the number", cutOff: true });
    assert.ok(fake.sent[0].startsWith(CUT_OFF), "she has to hear it before the question");
    assert.ok(fake.sent[0].endsWith("stop, just the number"), "and the question has to survive");
  });

  test("the note asks for one sentence, since that is the fix", () => {
    assert.match(CUT_OFF, /one sentence/i);
  });

  test("serves anime.js from this machine, so motion survives the network", async () => {
    const res = await fetch(
      `http://127.0.0.1:${running.endpoint.port}/anime.js?k=${running.endpoint.token}`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.match(await res.text(), /Anime\.js/);
  });

});
