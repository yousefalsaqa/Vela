import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { velaToolDefs } from "../src/tools.js";
import { useVoices } from "../src/voices.js";
import { current } from "../src/screen.js";

// The tool handlers go through the default store, so point it at a throwaway
// database and a throwaway vault before any of them run. Without the vault,
// `remember` would write notes into his real one.
let vault: string;
before(() => {
  process.env.VELA_DB = ":memory:";
  vault = mkdtempSync(join(tmpdir(), "vela-vault-tools-"));
  process.env.VELA_VAULT = vault;
});
after(() => rmSync(vault, { recursive: true, force: true }));

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
        "capture_screen",
        "clear_screen",
        "find_places",
        "forget",
        "forget_voice",
        "get_to_work",
        "launch_app",
        "list_projects",
        "list_watches",
        "list_windows",
        "map_view",
        "media_control",
        "react",
        "recall",
        "remember",
        "remember_voice",
        "resolve_watch",
        "show_picture",
        "show_screen",
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

describe("voice tools", () => {
  after(() => useVoices(null));

  test("with voices off, saving one says so rather than claiming it worked", async () => {
    // A model told "saved" by a tool that had nothing to save with would tell
    // Sarah she will be remembered, and she would not be.
    useVoices(null);
    assert.match(await call("remember_voice", { name: "Sarah" }), /aren't on/);
    assert.match(await call("forget_voice", { name: "Sarah" }), /aren't on/);
  });

  test("with voices on, the tools reach the voices she is listening with", async () => {
    const asked: string[] = [];
    useVoices({
      listen: async () => ({ kind: "unsure", score: 0, speech: 0 }),
      met: () => {},
      remember: (name) => (asked.push(`remember ${name}`), "Saved."),
      forget: (name) => (asked.push(`forget ${name}`), "Forgot."),
      names: () => [],
    });
    assert.equal(await call("remember_voice", { name: "Sarah" }), "Saved.");
    assert.equal(await call("forget_voice", { name: "Sarah" }), "Forgot.");
    assert.deepEqual(asked, ["remember Sarah", "forget Sarah"]);
  });
});

describe("memory tools", () => {
  test("remember then recall round-trips", async () => {
    assert.equal(
      await call("remember", { kind: "fact", content: "Owns a Civic." }),
      "Saved [[owns-a-civic]].",
    );
    // recall reports the note name as a link, which is what forget takes and
    // what Obsidian resolves.
    assert.match(
      await call("recall", { query: "Civic" }),
      /\[\[owns-a-civic\]\] \[fact\] Owns a Civic\./,
    );
  });

  test("recall says so rather than returning nothing", async () => {
    assert.equal(
      await call("recall", { query: "no such thing anywhere" }),
      "No matching memories.",
    );
  });

  test("forget reports a name that was never there", async () => {
    assert.equal(
      await call("forget", { name: "never-existed" }),
      "No memory called never-existed.",
    );
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

describe("screen tools", () => {
  const page = (name: string) => {
    const path = join(vault, name); // the temp dir from before() doubles as scratch space
    writeFileSync(path, "<p>hi</p>", "utf8");
    return path;
  };

  test("show_screen puts an existing page up and says so", async () => {
    const path = page("engine.html");
    assert.equal(
      await call("show_screen", { title: "HPC cross-section", path }),
      "On the screen: HPC cross-section.",
    );
    assert.equal(current()?.path, path);
    assert.equal(current()?.title, "HPC cross-section");
  });

  test("show_screen refuses a file that was never written, so she writes it first", async () => {
    const missing = join(vault, "unwritten.html");
    assert.match(await call("show_screen", { title: "Ghost", path: missing }), /Write the file first/);
  });

  test("clear_screen takes it down", async () => {
    await call("show_screen", { title: "Up", path: page("up.html") });
    assert.equal(await call("clear_screen"), "Cleared the screen.");
    assert.equal(current(), null);
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
