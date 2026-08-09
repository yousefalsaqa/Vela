import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { velaToolDefs } from "../src/tools.js";

// The tool handlers go through the default store, so point it at a throwaway
// database before any of them run.
before(() => {
  process.env.VELA_DB = ":memory:";
});

const byName = new Map(velaToolDefs.map((t) => [t.name, t]));

/** Call a tool the way the model would, and read the text back out. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const def = byName.get(name);
  assert.ok(def, `no tool named ${name}`);
  const result = await def.handler(args as never, undefined);
  return (result.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("");
}

describe("tool surface", () => {
  test("exposes every capability the README advertises", () => {
    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        "add_project",
        "browser_history",
        "forget",
        "launch_app",
        "list_projects",
        "list_watches",
        "list_windows",
        "media_control",
        "recall",
        "remember",
        "resolve_watch",
        "watch",
      ],
      "a tool renamed here is a capability the model silently loses",
    );
  });

  test("every tool is described well enough for the model to choose it", () => {
    for (const def of velaToolDefs) {
      assert.ok(
        def.description.length > 30,
        `${def.name} needs a real description, got: ${def.description}`,
      );
    }
  });

  test("no duplicate names", () => {
    assert.equal(byName.size, velaToolDefs.length);
  });
});

describe("memory tools", () => {
  test("remember then recall round-trips", async () => {
    assert.match(
      await call("remember", { kind: "fact", content: "Owns a Civic." }),
      /Saved memory #\d+\./,
    );
    assert.match(await call("recall", { query: "Civic" }), /\[fact\] Owns a Civic\./);
  });

  test("recall says so rather than returning nothing", async () => {
    assert.equal(
      await call("recall", { query: "no such thing anywhere" }),
      "No matching memories.",
    );
  });

  test("forget reports an id that was never there", async () => {
    assert.equal(await call("forget", { id: 4242 }), "No memory #4242.");
  });
});

describe("project tools", () => {
  test("lists nothing before anything is added", async () => {
    assert.equal(await call("list_projects"), "No projects registered yet.");
  });

  test("adds and then lists a project with its notes", async () => {
    await call("add_project", {
      name: "fantasy",
      path: "C:/Users/Yousef/Desktop/LaLigaFantasy",
      notes: "next.js",
    });
    const out = await call("list_projects");
    assert.match(out, /fantasy → C:\/Users\/Yousef\/Desktop\/LaLigaFantasy/);
    assert.match(out, /next\.js/);
  });

  test("a project with no notes lists cleanly", async () => {
    await call("add_project", { name: "vela", path: "C:/Users/Yousef/Desktop/Vela" });
    const line = (await call("list_projects"))
      .split("\n")
      .find((l) => l.startsWith("vela"));
    assert.equal(line, "vela → C:/Users/Yousef/Desktop/Vela");
  });
});

describe("watch tools", () => {
  test("says plainly when nothing is watched", async () => {
    assert.equal(await call("list_watches"), "Not watching anything.");
  });

  test("watch, list, resolve", async () => {
    assert.match(
      await call("watch", { note: "the build finishing", cue: "tail build.log" }),
      /Watching #(\d+): the build finishing/,
    );
    const listed = await call("list_watches");
    assert.match(listed, /the build finishing/);
    assert.match(listed, /tail build\.log/);

    const id = Number(listed.match(/#(\d+)/)![1]);
    assert.equal(await call("resolve_watch", { id }), `Closed watch #${id}.`);
    assert.equal(await call("list_watches"), "Not watching anything.");
  });

  test("a watch with no cue still works", async () => {
    await call("watch", { note: "something vague" });
    assert.match(await call("list_watches"), /something vague/);
  });

  test("attaches a file trigger and shows it", async () => {
    const out = await call("watch", {
      note: "the nightly job",
      cue: "tail job.log",
      trigger_kind: "file",
      trigger_arg: "C:/tmp/job.log",
    });
    assert.match(out, /wakes on file/);
    assert.match(
      await call("list_watches"),
      /the nightly job \[wakes on file: C:\/tmp\/job\.log\]/,
    );
  });

  test("a trigger kind with no argument degrades to the timer, and says so", async () => {
    const out = await call("watch", {
      note: "the half-specified thing",
      trigger_kind: "process",
    });
    assert.match(out, /No trigger set/);
    assert.doesNotMatch(
      await call("list_watches"),
      /half-specified thing \[wakes on/,
      "a broken trigger must not look like a working one",
    );
  });
});

describe("desktop tools", () => {
  // Deliberately not invoked — their handlers really do launch applications
  // and press media keys. desktop.test.ts covers the logic behind them.
  for (const name of ["launch_app", "media_control", "list_windows"]) {
    test(`${name} is registered`, () => {
      assert.ok(byName.has(name));
    });
  }
});
