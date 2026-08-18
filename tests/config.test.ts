import { test, describe as suite } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  parseSkillList,
  excludeSkills,
  claudeBinaryDir,
  ensureClaudeOnPath,
} from "../src/config.js";

/**
 * A throwaway skills directory. Each entry is either a skill (a folder with a
 * SKILL.md), a bare folder, or a loose file — the three things that actually
 * turn up in ~/.claude/skills.
 */
function skillsDir(entries: Record<string, "skill" | "folder" | "file">): string {
  const dir = mkdtempSync(join(tmpdir(), "vela-skills-"));
  for (const [name, kind] of Object.entries(entries)) {
    if (kind === "file") {
      writeFileSync(join(dir, name), "", "utf8");
      continue;
    }
    mkdirSync(join(dir, name), { recursive: true });
    if (kind === "skill") writeFileSync(join(dir, name, "SKILL.md"), "# skill\n", "utf8");
  }
  return dir;
}

suite("discoverSkills", () => {
  test("finds every folder with a SKILL.md in it", () => {
    const dir = skillsDir({ "agent-reach": "skill", council: "skill" });
    assert.deepEqual(discoverSkills(dir), ["agent-reach", "council"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a folder without a SKILL.md is not a skill", () => {
    const dir = skillsDir({ "agent-reach": "skill", ".git": "folder", notes: "folder" });
    assert.deepEqual(discoverSkills(dir), ["agent-reach"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores loose files sitting alongside the skills", () => {
    const dir = skillsDir({ "agent-reach": "skill", "README.md": "file" });
    assert.deepEqual(discoverSkills(dir), ["agent-reach"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("sorts them, so the option the session is opened with is stable", () => {
    const dir = skillsDir({ zebra: "skill", "agent-reach": "skill", council: "skill" });
    assert.deepEqual(discoverSkills(dir), ["agent-reach", "council", "zebra"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no skills directory means no skills, not a default set", () => {
    assert.deepEqual(discoverSkills(join(tmpdir(), "vela-no-such-skills-dir")), []);
  });
});

suite("parseSkillList", () => {
  test("unset means fall back to what's installed", () => {
    assert.equal(parseSkillList(undefined), undefined);
  });

  test("set but empty means none — which is not the same as unset", () => {
    assert.deepEqual(parseSkillList(""), []);
  });

  test("splits on commas and trims the spaces people leave", () => {
    assert.deepEqual(parseSkillList("agent-reach, council"), ["agent-reach", "council"]);
  });

  test("drops empty entries from a trailing comma", () => {
    assert.deepEqual(parseSkillList("agent-reach,,"), ["agent-reach"]);
  });
});

/** A throwaway node_modules/@anthropic-ai, with or without a bundled binary. */
function sdkRoot(pkgs: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "vela-sdk-"));
  for (const [pkg, files] of Object.entries(pkgs)) {
    mkdirSync(join(dir, pkg), { recursive: true });
    for (const f of files) writeFileSync(join(dir, pkg, f), "", "utf8");
  }
  return dir;
}

const SEP = process.platform === "win32" ? ";" : ":";

suite("claudeBinaryDir", () => {
  test("finds the platform package that actually holds the binary", () => {
    const root = sdkRoot({
      "claude-agent-sdk": ["sdk.mjs"],
      "claude-agent-sdk-win32-x64": ["claude.exe"],
    });
    assert.equal(claudeBinaryDir(root), join(root, "claude-agent-sdk-win32-x64"));
    rmSync(root, { recursive: true, force: true });
  });

  test("takes an extensionless binary too, for the platforms that ship one", () => {
    const root = sdkRoot({ "claude-agent-sdk-linux-x64": ["claude"] });
    assert.equal(claudeBinaryDir(root), join(root, "claude-agent-sdk-linux-x64"));
    rmSync(root, { recursive: true, force: true });
  });

  test("a platform package with no binary in it is not the answer", () => {
    const root = sdkRoot({ "claude-agent-sdk-win32-x64": ["README.md"] });
    assert.equal(claudeBinaryDir(root), null);
    rmSync(root, { recursive: true, force: true });
  });

  test("no node_modules at all is null rather than a throw", () => {
    assert.equal(claudeBinaryDir(join(tmpdir(), "vela-no-such-sdk")), null);
  });
});

suite("ensureClaudeOnPath", () => {
  test("prepends the directory, so the bundled binary wins", () => {
    const root = sdkRoot({ "claude-agent-sdk-win32-x64": ["claude.exe"] });
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    assert.equal(ensureClaudeOnPath(env, root), true);
    assert.equal(env.PATH, `${join(root, "claude-agent-sdk-win32-x64")}${SEP}/usr/bin`);
    rmSync(root, { recursive: true, force: true });
  });

  test("says so and changes nothing when there is no binary to add", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    assert.equal(ensureClaudeOnPath(env, join(tmpdir(), "vela-no-such-sdk")), false);
    assert.equal(env.PATH, "/usr/bin");
  });

  test("is idempotent, because both entry points may run in one process", () => {
    const root = sdkRoot({ "claude-agent-sdk-win32-x64": ["claude.exe"] });
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    ensureClaudeOnPath(env, root);
    const once = env.PATH;
    ensureClaudeOnPath(env, root);
    assert.equal(env.PATH, once);
    rmSync(root, { recursive: true, force: true });
  });

  test("copes with an empty PATH rather than leaving a stray separator", () => {
    const root = sdkRoot({ "claude-agent-sdk-win32-x64": ["claude.exe"] });
    const env: NodeJS.ProcessEnv = {};
    ensureClaudeOnPath(env, root);
    assert.equal(env.PATH, join(root, "claude-agent-sdk-win32-x64"));
    rmSync(root, { recursive: true, force: true });
  });
});

suite("excludeSkills", () => {
  const installed = ["agent-reach", "kalshi-api", "kalshi-weather-markets", "xlsx"];

  test("nothing excluded leaves the list alone", () => {
    assert.deepEqual(excludeSkills(installed, []), installed);
  });

  test("drops an exact name", () => {
    assert.deepEqual(excludeSkills(installed, ["xlsx"]), [
      "agent-reach",
      "kalshi-api",
      "kalshi-weather-markets",
    ]);
  });

  test("a trailing star drops the whole family", () => {
    assert.deepEqual(excludeSkills(installed, ["kalshi-*"]), ["agent-reach", "xlsx"]);
  });

  test("a pattern matching nothing is not an error", () => {
    assert.deepEqual(excludeSkills(installed, ["nope-*"]), installed);
  });

  test("a bare star means none, which is how he turns the lot off", () => {
    assert.deepEqual(excludeSkills(installed, ["*"]), []);
  });

  test("a partial name without a star does not match", () => {
    assert.deepEqual(excludeSkills(installed, ["kalshi"]), installed);
  });
});

suite("the heartbeat's list", () => {
  test("is a subset of what she has, so an uninstalled name costs nothing", () => {
    const installed = ["agent-reach", "xlsx"];
    const wanted = ["agent-reach", "gws-calendar-agenda"];
    assert.deepEqual(
      wanted.filter((n) => installed.includes(n)),
      ["agent-reach"],
      "a skill that isn't on this machine must not reach the tick",
    );
  });
});
