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
import { launchApp, mediaKey, listRunningApps, captureScreen } from "./desktop.js";
import { searchHistory, ago } from "./history.js";
import { present, clear } from "./screen.js";
import { captureFile } from "./paths.js";
import { readFileSync } from "node:fs";

const text = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
});

/**
 * An image plus a line saying what it is. Every other tool here answers in
 * text; this is the one that answers in pixels, and the caption matters
 * because a bare image gives the model no idea which monitor it got.
 */
const image = (data: string, caption: string) => ({
  content: [
    // MCP's own shape: flat data + mimeType, not the API's nested source block.
    { type: "image" as const, data, mimeType: "image/png" },
    { type: "text" as const, text: caption },
  ],
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
          rows.map((r) => `[[${r.name}]] [${r.kind}] ${r.body}`).join("\n"),
        );
      },
    ),

    tool(
      "forget",
      "Delete a memory by name. Use when a stored fact turns out to be wrong " +
        "or stale. The name is the one recall shows in double brackets.",
      {
        name: z
          .string()
          .describe("The note name, e.g. 'yousef-prefers-python'"),
      },
      async (args) => text(forget(args.name)),
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
      "capture_screen",
      "Look at what's on Yousef's monitors right now. Use it when the answer " +
        "is in something he can see and can't easily retype: a schematic, a " +
        "CAD viewport, an error dialog, a chart, a layout that looks wrong. " +
        "Pass `window` with part of a title from list_windows to grab just " +
        "that app, or `monitor` (1 = primary) for a whole screen. Prefer " +
        "list_windows when you only need to know what's open or what's " +
        "playing — a title is cheaper and more reliable than reading pixels, " +
        "so 'pause that song' needs no capture. Set detail only when small " +
        "text has to be legible; it costs about twice as much. Only ever use " +
        "this because he asked in this turn: never on a heartbeat, never to " +
        "check up on him.",
      {
        window: z
          .string()
          .optional()
          .describe("Part of a window title, e.g. 'Fusion' or 'Chrome'. Omit for a whole monitor."),
        monitor: z
          .number()
          .optional()
          .describe("Which monitor, 1-based. 1 is primary. Ignored when window is given."),
        detail: z
          .enum(["normal", "detail"])
          .optional()
          .describe("'detail' for legible small text (~2x the cost). Default 'normal'."),
        reason: z
          .string()
          .describe("What you're looking for, e.g. 'the schematic he's asking about'. Names the file."),
      },
      async (args) => {
        const path = captureFile(args.reason);
        const shot = await captureScreen({
          path,
          window: args.window,
          monitor: args.monitor,
          detail: args.detail,
        });
        if (!shot.ok) return text(shot.reason);
        const what = args.window ? `window matching "${args.window}"` : `monitor ${args.monitor ?? 1}`;
        return image(
          readFileSync(shot.path).toString("base64"),
          `${what}, ${shot.size}. Saved to ${shot.path}.`,
        );
      },
    ),

    tool(
      "show_screen",
      "Put a page on your screen — the stage panel in the hub. Use it when a " +
        "diagram, schematic, chart or table says it better than a paragraph, " +
        "or when Yousef asks to see something. Write a self-contained HTML " +
        "file first (conventionally under data/screen/): inline all CSS, JS " +
        "and SVG, images as data: URIs — the page runs sandboxed and its " +
        "requests carry no credentials, so anything external fails to load. " +
        "The one exception is <script src=\"/anime.js\"></script>, served for " +
        "motion. Match the hub: background #05090d, cyan #4fd1db, gold " +
        "#f5b95f. To make it interactive, have elements call " +
        "parent.postMessage({ vela: 'what he did, in words' }, '*') — that " +
        "reaches you as a turn, so phrase it as words you want in your ear " +
        "('he clicked sensor 9, HPC outlet temperature'), not as data. If you " +
        "invite a click, everything that looks clickable has to be: a table " +
        "of the same things the diagram marks is the first place he will try, " +
        "and finding it dead reads as the page being broken. Make the hit " +
        "target real, too — an SVG <g> is measured including its label, so " +
        "its centre is often empty canvas; put the handler on a filled shape " +
        "or lay an invisible rect over the area. An " +
        ".svg, image or .pdf that already exists can go up directly. With " +
        "something on the screen, keep the spoken reply short; the screen " +
        "carries the detail.",
      {
        path: z.string().describe("Absolute path to the file to show."),
        title: z.string().describe("Short title shown above the stage, e.g. 'The 21 sensors'."),
        note: z
          .string()
          .optional()
          .describe("One-line caption for what he's looking at, if the title needs help."),
      },
      async (args) => text(present({ title: args.title, path: args.path, note: args.note })),
    ),

    tool(
      "clear_screen",
      "Take the current page off your screen. Use when he asks for it to go, " +
        "or when what's showing stopped being relevant to the conversation.",
      {},
      async () => text(clear()),
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
