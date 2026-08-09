import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTurnQueue } from "../src/session.js";

/** Pull n turns off the stream, failing rather than hanging forever. */
async function take(stream: AsyncGenerator<{ message: { content: string } }>, n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const { value, done } = await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("stream stalled")), 1000).unref(),
      ),
    ]);
    if (done) break;
    out.push(value.message.content);
  }
  return out;
}

describe("createTurnQueue", () => {
  test("delivers a turn sent before anyone is listening", async () => {
    const q = createTurnQueue();
    q.send("hello");
    assert.deepEqual(await take(q.stream(), 1), ["hello"]);
  });

  test("delivers a turn sent while the stream is waiting", async () => {
    const q = createTurnQueue();
    const stream = q.stream();
    const pending = take(stream, 1);
    q.send("hello");
    assert.deepEqual(await pending, ["hello"]);
  });

  test("keeps a burst in order", async () => {
    const q = createTurnQueue();
    q.send("one");
    q.send("two");
    q.send("three");
    assert.deepEqual(await take(q.stream(), 3), ["one", "two", "three"]);
  });

  test("shapes each turn the way the SDK expects", async () => {
    const q = createTurnQueue();
    q.send("hi");
    const { value } = await q.stream().next();
    assert.deepEqual(value, {
      type: "user",
      message: { role: "user", content: "hi" },
      parent_tool_use_id: null,
      session_id: "",
    });
  });

  test("ends the stream when the REPL closes", async () => {
    const q = createTurnQueue();
    const stream = q.stream();
    const pending = stream.next();
    q.end();
    assert.equal((await pending).done, true);
  });

  test("still drains what was queued before ending", async () => {
    const q = createTurnQueue();
    q.send("last words");
    q.end();
    const stream = q.stream();
    assert.equal((await stream.next()).value.message.content, "last words");
    assert.equal((await stream.next()).done, true);
  });

  test("ignores anything sent after the end", async () => {
    const q = createTurnQueue();
    q.end();
    q.send("too late");
    assert.equal((await q.stream().next()).done, true);
  });
});
