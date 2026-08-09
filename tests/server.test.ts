import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, readEndpoint, type RunningServer, type ServableCore } from "../src/server.js";
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
