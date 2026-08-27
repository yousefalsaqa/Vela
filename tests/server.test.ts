import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serve,
  readEndpoint,
  hubUrl,
  HUB_FILE,
  CUT_OFF,
  type RunningServer,
  type ServableCore,
  type RoomControls,
} from "../src/server.js";
import { connect, reachable, parseFrames } from "../src/client.js";
import type { CoreEvent } from "../src/core.js";
import { present, clear as clearScreen, type Screen } from "../src/screen.js";

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

  describe("a stable address", () => {
    test("keeps the token from the last run, so a pinned hub link keeps working", async () => {
      // Without this the token is new every start, and an assistant that runs
      // from boot can never be bookmarked, pinned, or given a hotkey.
      await running.close();
      const first = await serve({ core: fake.core, endpointFile, keepToken: true });
      const key = first.endpoint.token;
      await first.close();

      running = await serve({ core: fake.core, endpointFile, keepToken: true });
      assert.equal(running.endpoint.token, key, "a rotated token breaks the pinned link");
    });

    test("mints a fresh one when there is nothing to keep", async () => {
      const clean = join(mkdtempSync(join(tmpdir(), "vela-first-")), "first-ever.json");
      const started = await serve({ core: fake.core, endpointFile: clean, keepToken: true });
      assert.ok(started.endpoint.token.length >= 32);
      await started.close();
    });

    test("a truncated key file is replaced rather than trusted", async () => {
      // A half-written file after a bad shutdown must not become a weak key
      // on a service that has the whole machine.
      const only = mkdtempSync(join(tmpdir(), "vela-badkey-"));
      writeFileSync(join(only, "hub-token"), "tooshort", "utf8");
      const started = await serve({
        core: fake.core,
        endpointFile: join(only, "server.json"),
        keepToken: true,
      });
      assert.ok(started.endpoint.token.length >= 32, "a guessable token is worse than a changed link");
      await started.close();
      rmSync(only, { recursive: true, force: true });
    });

    test("an ordinary run leaves no reusable key on disk", async () => {
      const only = mkdtempSync(join(tmpdir(), "vela-nokey-"));
      const started = await serve({ core: fake.core, endpointFile: join(only, "server.json") });
      await started.close();
      assert.equal(existsSync(join(only, "hub-token")), false);
      rmSync(only, { recursive: true, force: true });
    });

    test("rotates the token when it wasn't asked to keep it", async () => {
      const first = running.endpoint.token;
      await running.close();
      running = await serve({ core: fake.core, endpointFile });
      assert.notEqual(running.endpoint.token, first);
    });

    test("takes the port it was given, so the address is the same every boot", async () => {
      await running.close();
      // 0 asks the OS for a free one; anything else is a fixed address.
      running = await serve({ core: fake.core, endpointFile, port: 0 });
      const chosen = running.endpoint.port;
      await running.close();
      running = await serve({ core: fake.core, endpointFile, port: chosen });
      assert.equal(running.endpoint.port, chosen);
    });

    test("falls back to any free port rather than refusing to start", async () => {
      // Something else on his machine holding 4823 must not be what stops her
      // coming up at boot.
      const squatter = await serve({ core: fake.core, endpointFile: join(dir, "squat.json") });
      const taken = squatter.endpoint.port;
      const hers = await serve({ core: fake.core, endpointFile: join(dir, "hers.json"), port: taken });
      assert.ok(hers.endpoint.port > 0);
      assert.notEqual(hers.endpoint.port, taken, "she must not fight for a busy port");
      await hers.close();
      await squatter.close();
    });
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

    test("connect refuses a wrong token, rather than attaching to a stream it cannot open", async () => {
      await assert.rejects(
        () => connect({ port: running.endpoint.port, token: "wrong", pid: 0 }),
        /could not open the event stream \(401\)/,
      );
    });

    test("shutting down ends the streams rather than leaving clients hanging", async () => {
      // An attached REPL holding a stream that has quietly stopped speaking
      // looks exactly like her thinking for ever.
      const client = await connect(running.endpoint);
      await until(() => fake.listenerCount() > 0, "the server to subscribe");
      await running.close();
      assert.equal(fake.listenerCount(), 0, "she must let go of the core on the way out");
      client.stop();
      running = await serve({ core: fake.core, endpointFile }); // for afterEach
    });

    test("a client that hung up mid-broadcast does not take the others down", async () => {
      const a = await connect(running.endpoint);
      const b = await connect(running.endpoint);
      const seenB: CoreEvent[] = [];
      b.subscribe((e) => seenB.push(e));
      await until(() => fake.listenerCount() > 0, "subscription");

      a.stop(); // he closed the tab mid-turn
      fake.emit({ type: "delta", text: "still going" });
      fake.emit({ type: "result", ms: 5 });
      await until(() => seenB.length === 2, "the surviving client to hear both");

      assert.deepEqual(seenB.at(-1), { type: "result", ms: 5 });
      b.stop();
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

    test("a turn with no text key at all is rejected the same way", async () => {
      const res = await call("/turn", { method: "POST", body: JSON.stringify({}) });
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

  test("the page itself opens without a key, which is what lets a pinned tab reload", async () => {
    // It strips ?k= from the address bar as its first act, so every reload
    // after the first arrives bare. Behind the gate that is a dead tab, and a
    // tab he pinned is the entire point of a fixed address.
    const res = await fetch(at("/"));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Vela<\/title>/);
  });

  test("the page carries no key of its own, so serving it gives nothing away", async () => {
    const body = await (await fetch(at("/"))).text();
    assert.equal(body.includes(running.endpoint.token), false, "the page must ask for the key, not hold it");
  });

  test("an open door to the page is not an open door to her", async () => {
    // The only thing that changed is who may read the HTML. Everything that
    // carries anything of his stays shut.
    for (const path of ["/health", "/events", "/screen", "/screen/file"]) {
      assert.equal((await fetch(at(path))).status, 401, path);
    }
    const turn = await fetch(at("/turn"), {
      method: "POST",
      body: JSON.stringify({ text: "let me in" }),
    });
    assert.equal(turn.status, 401);
    assert.deepEqual(fake.sent, [], "an unauthenticated turn must never reach her");
  });

  test("a wrong key is still a locked door", async () => {
    assert.equal((await fetch(at("/health?k=not-the-token"))).status, 401);
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

  test("reports each half on its own, so the hub can draw one button and not the other", async () => {
    // Kokoro's venv missing and whisper's present is a real state of this
    // machine, and a hub that offered a speaker anyway would be a dead button.
    await up({ hear: async () => "heard" });
    const health = (await (
      await fetch(at(`/health?k=${running.endpoint.token}`))
    ).json()) as { canHear: boolean; canSpeak: boolean };
    assert.equal(health.canHear, true);
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

  test("a /speak body that is not JSON is refused, not crashed on", async () => {
    await up({ render: async () => Buffer.from("wav") });
    const res = await fetch(at(`/speak?k=${running.endpoint.token}`), {
      method: "POST",
      body: "not json",
    });
    assert.equal(res.status, 400);
  });

  test("a /speak body with no text key is refused the same way", async () => {
    await up({ render: async () => Buffer.from("wav") });
    const res = await fetch(at(`/speak?k=${running.endpoint.token}`), {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test("carries the name it was given, for a renamed assistant's hub", async () => {
    await up({ name: "Jarvis" });
    const health = (await (
      await fetch(at(`/health?k=${running.endpoint.token}`))
    ).json()) as { name: string };
    assert.equal(health.name, "Jarvis");
  });

  describe("warming", () => {
    test("asks for whichever half he is about to use", async () => {
      const warmed: string[] = [];
      await up({ warm: (what: "ears" | "voice") => warmed.push(what) });
      const call = (what: string) =>
        fetch(at(`/warm?k=${running.endpoint.token}`), {
          method: "POST",
          body: JSON.stringify({ what }),
        });

      assert.equal((await call("ears")).status, 202);
      assert.equal((await call("voice")).status, 202);
      assert.deepEqual(warmed, ["ears", "voice"]);
    });

    test("ignores anything that is not one of the two", async () => {
      const warmed: string[] = [];
      await up({ warm: (what: "ears" | "voice") => warmed.push(what) });
      const res = await fetch(at(`/warm?k=${running.endpoint.token}`), {
        method: "POST",
        body: JSON.stringify({ what: "everything" }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(warmed, []);
    });

    test("a service with nothing to warm still answers, so the hub need not care", async () => {
      await up();
      const res = await fetch(at(`/warm?k=${running.endpoint.token}`), {
        method: "POST",
        body: JSON.stringify({ what: "voice" }),
      });
      assert.equal(res.status, 202);
    });

    test("stays behind the token like everything else", async () => {
      await up({ warm: () => {} });
      assert.equal((await fetch(at("/warm"), { method: "POST" })).status, 401);
    });

    test("a body that is not JSON is refused rather than crashed on", async () => {
      const warmed: string[] = [];
      await up({ warm: (what: "ears" | "voice") => warmed.push(what) });
      const res = await fetch(at(`/warm?k=${running.endpoint.token}`), {
        method: "POST",
        body: "not json",
      });
      assert.equal(res.status, 400);
      assert.deepEqual(warmed, []);
    });
  });

  test("a render that comes back empty is reported, not played as silence", async () => {
    await up({ render: async () => null });
    const res = await fetch(at(`/speak?k=${running.endpoint.token}`), {
      method: "POST",
      body: JSON.stringify({ text: "anything" }),
    });
    assert.equal(res.status, 500);
  });

  test("a render of zero bytes is the same failure as no render at all", async () => {
    await up({ render: async () => Buffer.alloc(0) });
    const res = await fetch(at(`/speak?k=${running.endpoint.token}`), {
      method: "POST",
      body: JSON.stringify({ text: "anything" }),
    });
    assert.equal(res.status, 500);
  });

  test("an explicit port of zero still means an ephemeral port", async () => {
    await up({ port: 0 });
    assert.ok(running.endpoint.port > 0);
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

  test("anime.js needs no token, because a sandboxed screen page cannot present one", async () => {
    const res = await fetch(`http://127.0.0.1:${running.endpoint.port}/anime.js`);
    assert.equal(res.status, 200);
  });
});

describe("the screen, served", () => {
  let dir: string;
  let running: RunningServer;
  let fake: ReturnType<typeof fakeCore>;
  let shown: Screen | null;

  const at = (p: string) => `http://127.0.0.1:${running.endpoint.port}${p}`;
  const master = () =>
    ({ headers: { authorization: `Bearer ${running.endpoint.token}` } }) as RequestInit;

  /** What the hub does on load: ask what is up, and get the scoped token with it. */
  const meta = async () =>
    (await (await fetch(at("/screen"), master())).json()) as {
      screen: { id: string; title: string; note?: string; shownAt: number; s: string } | null;
    };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-screen-srv-"));
    fake = fakeCore();
    shown = null;
    running = await serve({
      core: fake.core,
      endpointFile: join(dir, "server.json"),
      screen: () => shown,
    });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, body = "<p>engine</p>") => {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    shown = { id: "ab12cd34", title: "The engine", path, shownAt: Date.now(), note: "stations 2 to 5" };
  };

  test("/screen is null when nothing is up", async () => {
    assert.deepEqual(await meta(), { screen: null });
  });

  test("/screen carries id, title, note and a scoped token — never the path", async () => {
    put("engine.html");
    const { screen } = await meta();
    assert.equal(screen?.id, "ab12cd34");
    assert.equal(screen?.title, "The engine");
    assert.equal(screen?.note, "stations 2 to 5");
    assert.ok((screen?.s ?? "").length >= 32, "the scoped token must not be guessable");
    assert.equal("path" in (screen ?? {}), false, "his filesystem layout stays on his machine");
  });

  test("a screen with no note has no note key, rather than a null one", async () => {
    const path = join(dir, "plain.html");
    writeFileSync(path, "<p>x</p>", "utf8");
    shown = { id: "0011aabb", title: "Plain", path, shownAt: Date.now() };
    const { screen } = await meta();
    assert.equal("note" in (screen ?? {}), false);
  });

  test("a file outside the known types still serves, as plain bytes", async () => {
    // The tool refuses these before they get here, but the server takes its
    // injected state at face value rather than crashing on it.
    const path = join(dir, "raw.bin");
    writeFileSync(path, "bytes", "utf8");
    shown = { id: "0011aabb", title: "Raw", path, shownAt: Date.now() };
    const { screen } = await meta();
    const res = await fetch(at(`/screen/file?s=${screen!.s}`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
  });

  test("/screen itself stays behind the master token", async () => {
    put("engine.html");
    assert.equal((await fetch(at("/screen"))).status, 401);
  });

  test("/screen/file with no credentials at all is a locked door", async () => {
    put("engine.html");
    await meta(); // a key exists; the request just doesn't hold it
    assert.equal((await fetch(at("/screen/file"))).status, 401);
  });

  test("the scoped token fetches the file, with its type and no caching", async () => {
    put("engine.html");
    const { screen } = await meta();
    const res = await fetch(at(`/screen/file?s=${screen!.s}`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "<p>engine</p>");
  });

  test("the served page is walled in by CSP, so a hostile screen cannot phone out", async () => {
    put("engine.html");
    const { screen } = await meta();
    const csp =
      (await fetch(at(`/screen/file?s=${screen!.s}`))).headers.get(
        "content-security-policy",
      ) ?? "";
    assert.match(csp, /connect-src 'none'/, "fetch and XHR are the exfiltration channel");
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /script-src 'self' 'unsafe-inline'/, "'self' is what lets /anime.js load");
  });

  test("the scoped token opens nothing else — that is the entire point of it", async () => {
    put("engine.html");
    const { screen } = await meta();
    const s = screen!.s;
    assert.equal((await fetch(at(`/health?s=${s}`))).status, 401);
    assert.equal((await fetch(at(`/events?s=${s}`))).status, 401);
    const turn = await fetch(at(`/turn?s=${s}`), {
      method: "POST",
      body: JSON.stringify({ text: "injected" }),
    });
    assert.equal(turn.status, 401);
    assert.deepEqual(fake.sent, [], "a screen page must never be able to talk as him");
  });

  test("a new show rotates the token, so a stale page loses even its one door", async () => {
    put("engine.html");
    const old = (await meta()).screen!.s;
    fake.emit({ type: "show", screen: { id: "ef56ab78", title: "Again", shownAt: 8 } });
    const fresh = (await meta()).screen!.s;
    assert.notEqual(fresh, old);
    assert.equal((await fetch(at(`/screen/file?s=${old}`))).status, 401);
    assert.equal((await fetch(at(`/screen/file?s=${fresh}`))).status, 200);
  });

  test("a show frame reaches SSE clients with the scoped token attached", async () => {
    put("engine.html");
    const client = await connect(running.endpoint);
    const seen: (CoreEvent & { screen?: { s?: string } })[] = [];
    client.subscribe((e) => seen.push(e as (typeof seen)[number]));
    await until(() => fake.listenerCount() > 0, "the server to subscribe");
    fake.emit({ type: "show", screen: { id: "ab12cd34", title: "The engine", shownAt: 9 } });
    await until(() => seen.length === 1, "the show frame");
    const s = seen[0].screen?.s ?? "";
    assert.ok(s.length >= 32, "the hub builds the iframe URL from this");
    assert.equal((await fetch(at(`/screen/file?s=${s}`))).status, 200);
    client.stop();
  });

  test("clearing rotates the token away entirely", async () => {
    put("engine.html");
    const s = (await meta()).screen!.s;
    fake.emit({ type: "show", screen: null });
    shown = null;
    assert.equal((await fetch(at(`/screen/file?s=${s}`))).status, 401);
  });

  test("an empty key is not a key, however the page came by it", async () => {
    put("engine.html");
    await meta();
    assert.equal((await fetch(at("/screen/file?s="))).status, 401);
  });

  test("putting it away puts it away everywhere, not just in that tab", async () => {
    // It used to hide locally, so the next page to open asked what was up and
    // got back the thing he had just closed.
    put("engine.html");
    const s = (await meta()).screen!.s;
    const res = await fetch(at("/screen/clear"), { method: "POST", ...master() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { screen: null });
    assert.equal((await fetch(at(`/screen/file?s=${s}`))).status, 401, "the key goes with it");
  });

  test("clearing needs the token like everything else", async () => {
    put("engine.html");
    assert.equal((await fetch(at("/screen/clear"), { method: "POST" })).status, 401);
  });

  test("a screen from hours ago is not put back in front of him", async () => {
    const path = join(dir, "stale.html");
    writeFileSync(path, "<p>old</p>", "utf8");
    shown = { id: "aa11bb22", title: "This morning", path, shownAt: Date.now() - 4 * 60 * 60_000 };
    assert.deepEqual(await meta(), { screen: null });
  });

  test("the master token still reads the file, for debugging with curl", async () => {
    put("engine.html");
    const res = await fetch(at("/screen/file"), master());
    assert.equal(res.status, 200);
  });

  test("no screen up is a 404 even for the master token", async () => {
    assert.equal((await fetch(at("/screen/file"), master())).status, 404);
  });

  test("a file deleted after being shown is a 404, not a crash", async () => {
    put("gone.html");
    const { screen } = await meta();
    rmSync(shown!.path);
    assert.equal((await fetch(at(`/screen/file?s=${screen!.s}`))).status, 404);
  });

  test("with nothing injected it reads the real screen module, which is what production does", async () => {
    const other = mkdtempSync(join(tmpdir(), "vela-screen-real-"));
    const real = await serve({ core: fakeCore().core, endpointFile: join(other, "server.json") });
    try {
      const path = join(other, "real.html");
      writeFileSync(path, "<p>real</p>", "utf8");
      present({ title: "Real", path });
      const res = await fetch(`http://127.0.0.1:${real.endpoint.port}/screen`, {
        headers: { authorization: `Bearer ${real.endpoint.token}` },
      });
      const { screen } = (await res.json()) as { screen: { title: string; s: string } | null };
      assert.equal(screen?.title, "Real");
      const file = await fetch(
        `http://127.0.0.1:${real.endpoint.port}/screen/file?s=${screen!.s}`,
      );
      assert.equal(await file.text(), "<p>real</p>");
    } finally {
      clearScreen();
      await real.close();
      rmSync(other, { recursive: true, force: true });
    }
  });
});

/**
 * The room is a fact, not an event.
 *
 * `announce` reaches whoever is attached when it fires, which is the whole
 * story for a state *change* and only half of it for a *state*. The wake word
 * opens a hub in the middle of a spoken turn, so the tab that most needs to
 * know she is already talking is the one guaranteed to have missed the
 * announcement. Answering it in the handshake is what stops two of her.
 */
describe("a hub that arrives mid-sentence", () => {
  let dir: string;
  let running: RunningServer;
  let speaking = false;

  const health = async () =>
    (await fetch(`http://127.0.0.1:${running.endpoint.port}/health`, {
      headers: { authorization: `Bearer ${running.endpoint.token}` },
    }).then((r) => r.json())) as { aloud: boolean };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-aloud-"));
    speaking = false;
    running = await serve({
      core: fakeCore().core,
      endpointFile: join(dir, "server.json"),
      aloud: () => speaking,
    });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("is told she is being spoken aloud, having missed the announcement", async () => {
    speaking = true;
    assert.equal((await health()).aloud, true);
  });

  test("is told she is not, so a quiet room does not mute the hub for good", async () => {
    assert.equal((await health()).aloud, false);
  });

  test("asks every time, because the answer changes while the tab is open", async () => {
    speaking = true;
    assert.equal((await health()).aloud, true);
    speaking = false;
    assert.equal((await health()).aloud, false);
  });

  /**
   * Her name opens a hub and she answers the name at once, so the tab that
   * was opened for "Yes?" is the one tab that never saw it go by. Same shape
   * as `aloud`: a fact carried on the handshake, not an event.
   */
  test("is handed the line she said to his name, if it was just now", async () => {
    let said: { text: string; at: number } | null = null;
    const quiet = mkdtempSync(join(tmpdir(), "vela-said-"));
    const late = await serve({
      core: fakeCore().core,
      endpointFile: join(quiet, "server.json"),
      lastSaid: () => said,
    });
    const ask = async () =>
      (await fetch(`http://127.0.0.1:${late.endpoint.port}/health`, {
        headers: { authorization: `Bearer ${late.endpoint.token}` },
      }).then((r) => r.json())) as { said: string | null };
    try {
      assert.equal((await ask()).said, null, "nothing said is nothing to show");
      said = { text: "Yes?", at: Date.now() };
      assert.equal((await ask()).said, "Yes?");
      // A page reloaded this afternoon is not owed this morning's answer.
      said = { text: "Yes?", at: Date.now() - 60_000 };
      assert.equal((await ask()).said, null, "an old line is not this tab's line");
    } finally {
      await late.close();
      rmSync(quiet, { recursive: true, force: true });
    }
  });

  /**
   * A service with no room to speak into — no Kokoro, so no wake word — must
   * still report something the hub can read, or the speaker button goes dead
   * on the one setup that depends on it.
   */
  test("a service that never speaks aloud says so rather than nothing", async () => {
    const quiet = mkdtempSync(join(tmpdir(), "vela-quiet-"));
    const mute = await serve({
      core: fakeCore().core,
      endpointFile: join(quiet, "server.json"),
    });
    const res = (await fetch(`http://127.0.0.1:${mute.endpoint.port}/health`, {
      headers: { authorization: `Bearer ${mute.endpoint.token}` },
    }).then((r) => r.json())) as { aloud: boolean };
    assert.equal(res.aloud, false);
    await mute.close();
    rmSync(quiet, { recursive: true, force: true });
  });
});

/**
 * What the wake word checks before opening a window.
 *
 * Opening one per turn would be worse than never opening any, and the tab he
 * left open is the one he is looking at.
 */
describe("attached", () => {
  let dir: string;
  let running: RunningServer;
  let fake: ReturnType<typeof fakeCore>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-attached-"));
    fake = fakeCore();
    running = await serve({ core: fake.core, endpointFile: join(dir, "server.json") });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("nobody attached is nobody watching, which is when a window is worth opening", () => {
    assert.equal(running.attached(), 0);
  });

  test("counts a client that attached, so she does not open a second window at it", async () => {
    const client = await connect(running.endpoint);
    await until(() => running.attached() === 1, "the client to attach");
    client.stop();
  });

  test("a client that left stops counting, so the next wake can open one again", async () => {
    const client = await connect(running.endpoint);
    await until(() => running.attached() === 1, "the client to attach");
    client.stop();
    await until(() => running.attached() === 0, "the client to drop");
  });
});

/**
 * The hub as the room's controls rather than a second room.
 *
 * Two microphones and two voices kept in step by announcement is what put two
 * of her in one room. One of each, with the hub driving them, is the shape
 * that cannot do that — so these pin the wire, and the 404 that keeps a
 * roomless service honest about having no switches to offer.
 */
describe("the room, as the hub drives it", () => {
  let dir: string;
  let running: RunningServer;
  let hearing = true;
  let speaking = true;
  let cuts = 0;

  const room: RoomControls = {
    hearing: () => hearing,
    setHearing: (on) => (hearing = on),
    speaking: () => speaking,
    setSpeaking: (on) => (speaking = on),
    cut: () => (cuts += 1),
  };

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${running.endpoint.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${running.endpoint.token}`,
        ...(init.headers ?? {}),
      },
    });
  const set = (body: unknown) => call("/room", { method: "POST", body: JSON.stringify(body) });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-room-"));
    hearing = true;
    speaking = true;
    cuts = 0;
    running = await serve({
      core: fakeCore().core,
      endpointFile: join(dir, "server.json"),
      room: () => room,
    });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the handshake carries both switches, so the buttons open set correctly", async () => {
    speaking = false;
    const h = (await (await call("/health")).json()) as {
      room: { hearing: boolean; speaking: boolean };
    };
    assert.deepEqual(h.room, { hearing: true, speaking: false });
  });

  test("stopping her cuts the sentence sounding now", async () => {
    await set({ stop: true });
    assert.equal(cuts, 1);
  });

  test("being interrupted is about this reply, not every reply after it", async () => {
    // The distinction the two buttons cannot express: mute is a standing
    // setting, this is having heard enough of one answer. If interrupting her
    // also muted her, the next thing he asked would come back in silence and
    // read as her being broken.
    await set({ stop: true });
    const now = (await (await set({})).json()) as { hearing: boolean; speaking: boolean };
    assert.deepEqual(now, { hearing: true, speaking: true });
  });

  test("only a real true cuts her off, so a typo cannot silence her mid-sentence", async () => {
    await set({ stop: "yes" });
    assert.equal(cuts, 0, "the toggles already refuse anything but a boolean; this is the same bar");
  });

  test("muting him stops her hearing the room", async () => {
    await set({ hearing: false });
    assert.equal(hearing, false);
  });

  test("muting her leaves his microphone alone", async () => {
    await set({ speaking: false });
    assert.equal(speaking, false);
    assert.equal(hearing, true, "muting her voice must not mute him too");
  });

  /**
   * The page redraws from the reply rather than from what it assumed, so the
   * reply has to be the state after the change and not merely an ack.
   */
  test("answers with the state that resulted, which is what the hub redraws from", async () => {
    const res = await set({ hearing: false, speaking: false });
    assert.deepEqual(await res.json(), { hearing: false, speaking: false });
  });

  test("an absent switch is left alone rather than defaulted off", async () => {
    await set({ speaking: false });
    await set({ hearing: false });
    assert.equal(speaking, false, "the earlier mute must survive a later unrelated one");
  });

  /**
   * Only a real boolean moves a switch. A typo'd or absent field arriving as
   * undefined must not read as "off" and mute a microphone he never touched.
   */
  test("a non-boolean does not move a switch", async () => {
    await set({ hearing: "no", speaking: 0 });
    assert.equal(hearing, true);
    assert.equal(speaking, true);
  });

  test("a body that is not JSON is rejected rather than ignored", async () => {
    const res = await call("/room", { method: "POST", body: "not json" });
    assert.equal(res.status, 400);
    assert.equal(hearing, true);
  });
});

/**
 * A service that is not in a room has no switches to offer, and must say so
 * rather than accept the call and do nothing. A control that reports working
 * and changes nothing is the exact failure this whole shape is undoing.
 */
describe("a service with no room", () => {
  let dir: string;
  let running: RunningServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vela-noroom-"));
    running = await serve({ core: fakeCore().core, endpointFile: join(dir, "server.json") });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("says it has no room, so the hub keeps its own microphone and voice", async () => {
    const h = (await (await fetch(`http://127.0.0.1:${running.endpoint.port}/health`, {
      headers: { authorization: `Bearer ${running.endpoint.token}` },
    })).json()) as { room: unknown };
    assert.equal(h.room, null);
  });

  test("refuses to mute a room it does not have", async () => {
    const res = await fetch(`http://127.0.0.1:${running.endpoint.port}/room`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.endpoint.token}` },
      body: JSON.stringify({ hearing: false }),
    });
    assert.equal(res.status, 404);
  });
});

describe("the URL she opens, held against the page it opens", () => {
  const endpoint = { port: 4823, token: "a".repeat(48), pid: 1234 };

  /**
   * Every query parameter hub.html reads out of its own address bar.
   *
   * Read out of the source text because there is no other way to reach it: the
   * page is served as bytes and imports nothing, so its half of this contract
   * exists only as a string literal. If someone rewrites those lines to hold
   * the URLSearchParams in a variable this stops finding them and the tests
   * below fail — which is the right direction to fail in. A false alarm is
   * loud and gets fixed; the silence this guards against is neither.
   */
  const readByHub = (): Set<string> => {
    const page = readFileSync(HUB_FILE, "utf8");
    return new Set(
      [...page.matchAll(/URLSearchParams\(location\.search\)\.get\("([^"]+)"\)/g)].map(
        (m) => m[1],
      ),
    );
  };

  const writtenByHer = (): Set<string> =>
    new Set(new URL(hubUrl(endpoint)).searchParams.keys());

  test("the page still reads its address bar at all, or the two tests below prove nothing", () => {
    assert.ok(
      readByHub().size > 0,
      "found no URLSearchParams(location.search).get(...) in hub.html: this suite can no longer see the page's half of the contract, so it is not checking it",
    );
  });

  test("every parameter she puts in the URL is one the page reads back", () => {
    const read = readByHub();
    for (const name of writtenByHer()) {
      assert.ok(
        read.has(name),
        `she opens the hub with ?${name}= and hub.html never reads it. Nothing throws when these drift apart — the parameter simply stops arriving and the feature it carried goes quiet.`,
      );
    }
  });

  test("every parameter the page reads is one she puts there", () => {
    const written = writtenByHer();
    for (const name of readByHub()) {
      assert.ok(
        written.has(name),
        `hub.html reads ?${name}= out of its address bar and she never writes it, so it is always empty`,
      );
    }
  });

  test("the token survives the trip through the address bar", () => {
    const url = new URL(hubUrl(endpoint));
    assert.equal(url.searchParams.get("k"), endpoint.token);
  });

  test("the same endpoint gives the same link every time, so a pinned tab keeps working", () => {
    assert.equal(
      hubUrl(endpoint),
      hubUrl({ ...endpoint }),
      "anything per-window in this URL is a link he cannot pin, which is what the durable token exists to give him",
    );
  });
});
