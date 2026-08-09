import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  remember,
  recall,
  forget,
  listProjects,
  addProject,
  addWatch,
  listWatches,
  resolveWatch,
  type MemoryKind,
} from "./memory.js";
import { launchApp, mediaKey, listRunningApps } from "./desktop.js";
import { searchHistory, ago } from "./history.js";

const text = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
});

/**
 * The tool definitions, separate from the server, so tests can call a handler
 * directly instead of standing up an MCP transport to reach it.
 */
export const velaToolDefs = [
    tool(
      "remember",
      "Save a durable fact about Yousef, his preferences, or his work. Use " +
        "this whenever you learn something that would still be useful in a " +
        "future conversation. Do not save transient details.",
      {
        kind: z
          .enum(["preference", "project", "fact", "reference"])
          .describe(
            "preference = how he likes things done; project = ongoing work; fact = about him; reference = a link or resource",
          ),
        content: z
          .string()
          .describe("The fact, written as a standalone sentence."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional keywords for retrieval."),
      },
      async (args) =>
        text(remember(args.kind as MemoryKind, args.content, args.tags ?? [])),
    ),

    tool(
      "recall",
      "Search durable memory. Use when you need background on Yousef that " +
        "isn't already in the conversation.",
      {
        query: z
          .string()
          .optional()
          .describe("Substring to search for. Omit to list everything."),
        kind: z
          .enum(["preference", "project", "fact", "reference"])
          .optional(),
      },
      async (args) => {
        const rows = recall(args.query, args.kind as MemoryKind | undefined);
        if (!rows.length) return text("No matching memories.");
        return text(
          rows.map((r) => `#${r.id} [${r.kind}] ${r.content}`).join("\n"),
        );
      },
    ),

    tool(
      "forget",
      "Delete a memory by id. Use when a stored fact turns out to be wrong or stale.",
      { id: z.number().describe("The memory id, e.g. 4") },
      async (args) => text(forget(args.id)),
    ),

    tool(
      "list_projects",
      "List Yousef's registered codebases and their paths.",
      {},
      async () => {
        const rows = listProjects();
        if (!rows.length) return text("No projects registered yet.");
        return text(
          rows
            .map(
              (p) => `${p.name} → ${p.path}${p.notes ? `\n    ${p.notes}` : ""}`,
            )
            .join("\n"),
        );
      },
    ),

    tool(
      "add_project",
      "Register a codebase so it can be referred to by name later.",
      {
        name: z.string().describe("Short name, e.g. 'fantasy'"),
        path: z.string().describe("Absolute path to the project root"),
        notes: z.string().optional().describe("What it is, stack, quirks"),
      },
      async (args) => text(addProject(args.name, args.path, args.notes ?? "")),
    ),

    tool(
      "launch_app",
      "Open an application, URL, or file on Yousef's Windows machine. " +
        "Understands aliases like 'netflix', 'spotify', 'vscode'.",
      {
        target: z
          .string()
          .describe("App alias, executable name, URL, or file path"),
      },
      async (args) => text(await launchApp(args.target)),
    ),

    tool(
      "media_control",
      "Send a system media key: play/pause, skip, or change volume.",
      {
        action: z.enum([
          "playpause",
          "next",
          "previous",
          "mute",
          "volumeup",
          "volumedown",
        ]),
      },
      async (args) => text(await mediaKey(args.action)),
    ),

    tool(
      "list_windows",
      "List the titles of currently open application windows — useful for " +
        "seeing what Yousef is working on right now.",
      {},
      async () => text(await listRunningApps()),
    ),

    tool(
      "browser_history",
      "Search what Yousef has had open in Chrome, Edge or Brave. Use this " +
        "whenever he refers to something he was looking at — 'that Meet call I " +
        "joined', 'the article from yesterday' — then open the result with " +
        "launch_app. Searches page titles and URLs.",
      {
        query: z
          .string()
          .describe(
            "Words from the page title or URL, e.g. 'meet.google.com' or 'capstone'. Empty for whatever is most recent.",
          ),
        since_days: z
          .number()
          .optional()
          .describe("Only visits in the last N days. Omit for all history."),
        limit: z.number().optional().describe("How many to return. Default 20."),
      },
      async (args) => {
        const found = searchHistory(args.query, {
          sinceDays: args.since_days,
          limit: args.limit,
        });
        if (!found.length) return text("Nothing in browser history matches that.");
        return text(
          found
            .map(
              (v) =>
                `${v.title}\n    ${v.url}\n    ${ago(v.lastVisit)}, ${v.visits} visit${v.visits === 1 ? "" : "s"} (${v.browser})`,
            )
            .join("\n"),
        );
      },
    ),

    tool(
      "watch",
      "Keep an eye on something in the background and speak up unprompted " +
        "when it changes. Use when Yousef asks to be told when something " +
        "happens, or when he'll obviously want to know and won't be looking.",
      {
        note: z
          .string()
          .describe("What you're watching for, e.g. 'the fantasy build finishing'"),
        cue: z
          .string()
          .optional()
          .describe(
            "How to check it — a command to run, a file to look at, a window title. Be specific; a future you with no memory of this conversation has to act on it.",
          ),
        trigger_kind: z
          .enum(["file", "process"])
          .optional()
          .describe(
            "Wake this watch the moment something happens instead of waiting for the next timed check. 'file' = a file stops being written to; 'process' = a running process exits. Set one whenever you can — it reports in seconds and costs nothing while waiting.",
          ),
        trigger_arg: z
          .string()
          .optional()
          .describe(
            "For 'file', the absolute path to watch. For 'process', the executable name, e.g. 'node'.",
          ),
      },
      async (args) => {
        const trigger =
          args.trigger_kind && args.trigger_arg
            ? { kind: args.trigger_kind, arg: args.trigger_arg }
            : undefined;
        const result = addWatch(args.note, args.cue ?? "", trigger);
        if (args.trigger_kind && !args.trigger_arg) {
          return text(
            `${result}\nNo trigger set: trigger_kind needs a trigger_arg. ` +
              `It will be checked on the timer instead.`,
          );
        }
        return text(trigger ? `${result} (wakes on ${trigger.kind})` : result);
      },
    ),

    tool(
      "list_watches",
      "List what's currently being watched in the background.",
      {},
      async () => {
        const rows = listWatches();
        if (!rows.length) return text("Not watching anything.");
        return text(
          rows
            .map((w) => {
              const trigger = w.trigger_kind
                ? ` [wakes on ${w.trigger_kind}: ${w.trigger_arg}]`
                : "";
              return `#${w.id} ${w.note}${trigger}${w.cue ? `\n    ${w.cue}` : ""}`;
            })
            .join("\n"),
        );
      },
    ),

    tool(
      "resolve_watch",
      "Stop watching something — it happened, or it no longer matters.",
      { id: z.number().describe("The watch id, e.g. 2") },
      async (args) => text(resolveWatch(args.id)),
    ),
];

export const velaTools = createSdkMcpServer({
  name: "vela",
  version: "0.1.0",
  instructions:
    "Yousef's personal assistant capabilities: durable memory, a project " +
    "registry, and control of his Windows desktop.",
  tools: velaToolDefs,
});
