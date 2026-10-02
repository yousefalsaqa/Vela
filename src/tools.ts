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
import { present, clear, current } from "./screen.js";
import { captureFile } from "./paths.js";
import { places, type Kind } from "./places.js";
import { showPicture } from "./picture.js";
import { express, FACES, CAPTION_MAX } from "./face.js";
import { askForWork } from "./work.js";
import { voices } from "./voices.js";
import { tv, REMOTE, type Button } from "./tv.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The map page. Written once; every search moves it rather than replacing it. */
export const MAP_PAGE = fileURLToPath(new URL("./map.html", import.meta.url));

/**
 * Run a map change and make sure the map is what the stage is showing.
 *
 * Put up only when something else is showing: presenting it again would mint
 * a new screen and reload the page, which is the "new map" he asked for this
 * not to be. A failure is a sentence for the model, not a throw.
 */
async function onTheMap(change: () => Promise<string>): Promise<ReturnType<typeof text>> {
  try {
    const said = await change();
    if (places().state() && current()?.path !== MAP_PAGE) present({ title: "Places", path: MAP_PAGE });
    return text(said);
  } catch (err) {
    return text(
      `The map search failed (${(err as Error).message}). OpenStreetMap may be slow; ` +
        `say so in a line and offer to try again.`,
    );
  }
}

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
      "find_places",
      "Find places near Yousef and show them on a live map on his screen: " +
        "somewhere to eat, coffee, a bar, something sweet, groceries, a pharmacy. " +
        "This is how to answer 'where can I eat', 'coffee near me', 'what's open " +
        "on Princess Street' — it searches OpenStreetMap around his home " +
        "or around a street or place he names, and marks " +
        "each result with its walking time from his door and whether it is open " +
        "now. The answer is not in his files: never search his projects for " +
        "places. The map stays up, so when he refines — 'wider', 'further down', " +
        "'closer', 'that one' — use map_view, not another search. Say one short " +
        "line; the map carries the list. For reviews, menus or prices of one " +
        "place, look it up on the web afterwards.",
      {
        what: z
          .enum(["food", "restaurant", "fast_food", "cafe", "bar", "dessert", "groceries", "pharmacy"])
          .describe("food = anywhere to eat; dessert = ice cream, bakeries, sweets."),
        cuisine: z
          .string()
          .optional()
          .describe("A cuisine or dish to narrow to, e.g. 'sushi', 'pizza', 'shawarma'. Leave out for anything."),
        near: z
          .string()
          .optional()
          .describe("Search here instead of home: a street ('Princess Street') or a place ('Queen's campus')."),
        radius_m: z
          .number()
          .optional()
          .describe("How far to look, in metres. Leave out: a 15-minute walk, or a stretch of the street."),
      },
      async (args) =>
        onTheMap(() =>
          places().find({ what: args.what as Kind, cuisine: args.cuisine, near: args.near, radiusM: args.radius_m }),
        ),
      // Loaded with the prompt rather than found by tool search: the search
      // was a model round trip — 1.2 to 2.3s — in front of the first map of
      // every session, which is a spoken question he is waiting on.
      { alwaysLoad: true },
    ),

    tool(
      "map_view",
      "Change the map already on his screen, in place — it moves; it is never " +
        "rebuilt. expand: look wider ('expand the search'). closer: tighten in. " +
        "move: slide the view; on a street, direction 'further' carries on away " +
        "from home ('go further down the street') and 'back' returns, or give a " +
        "compass direction and optional meters. focus: pick out one place by " +
        "name or list number ('that one', 'the third one', 'tell me about Chit " +
        "Chat') and open its card. home: back to around his door.",
      {
        action: z.enum(["expand", "closer", "move", "focus", "home"]),
        direction: z
          .string()
          .optional()
          .describe("For move: 'further', 'back', or north, south, east, west, northeast…"),
        meters: z.number().optional().describe("For move: how far. Leave out for about one view's width."),
        place: z.string().optional().describe("For focus: the place's name, part of it, or its number in the list."),
      },
      async (args) =>
        onTheMap(() =>
          places().view({ action: args.action, direction: args.direction, meters: args.meters, place: args.place }),
        ),
      { alwaysLoad: true },
    ),

    tool(
      "clear_screen",
      "Take the current page off your screen. Use when he asks for it to go, " +
        "or when what's showing stopped being relevant to the conversation.",
      {},
      async () => text(clear()),
    ),

    tool(
      "show_picture",
      "Put a picture card on your screen: the real photograph of a thing, " +
        "what Wikipedia says it is, and the facts you choose, laid out in your " +
        "colours. Use it whenever the conversation turns to something that " +
        "exists and has a look — a famous project, a machine, a building, a " +
        "vehicle, a place, an artwork, a person — whether or not he asked to " +
        "see it. It takes seconds because it writes no page: give `subject` as " +
        "its Wikipedia article title or close to it, and the card fetches the " +
        "photo and summary itself. Add the few facts and dates that matter, " +
        "from what you know or just looked up, not every one you have. For a " +
        "mechanism or an idea that has no photograph, draw it with " +
        "show_screen instead. Say one line; the card carries the rest.",
      {
        subject: z.string().describe("Its Wikipedia title, or near it: 'James Webb Space Telescope', 'Apollo 11'."),
        title: z.string().optional().describe("A heading other than the article's title, if it reads better."),
        facts: z
          .array(z.object({ label: z.string(), value: z.string() }))
          .optional()
          .describe("Up to 8 short pairs: { label: 'Mirror', value: '6.5 m, 18 segments' }."),
        timeline: z
          .array(z.object({ when: z.string(), what: z.string() }))
          .optional()
          .describe("Up to 8 moments in order: { when: '2021', what: 'Launched on Ariane 5' }."),
        image_url: z
          .string()
          .optional()
          .describe("A direct link to a better image than Wikipedia's lead photo, if you found one."),
        caption: z.string().optional().describe("A line under the photo: what he is looking at."),
      },
      async (args) =>
        text(
          await showPicture({
            subject: args.subject,
            title: args.title,
            facts: args.facts,
            timeline: args.timeline,
            imageUrl: args.image_url,
            caption: args.caption,
          }),
        ),
      { alwaysLoad: true },
    ),

    tool(
      "remember_voice",
      "Save the voiceprint of the new voice you are talking to, under their name, so " +
        "you know them by voice from now on. Only after they themselves said yes to " +
        "you saving it. Use the name they gave you.",
      { name: z.string().describe("What they said to call them: 'Sarah'.") },
      async (args) => {
        const live = voices();
        if (!live) return text("Voices aren't on right now, so there is nothing to save it with. Say so.");
        return text(live.remember(args.name));
      },
      { alwaysLoad: true },
    ),

    tool(
      "forget_voice",
      "Delete a saved voiceprint, when the person asks you to forget their voice.",
      { name: z.string().describe("The name it was saved under.") },
      async (args) => {
        const live = voices();
        if (!live) return text("Voices aren't on right now. Say so.");
        return text(live.forget(args.name));
      },
    ),

    tool(
      "get_to_work",
      "Move this turn to your stronger model. Spoken turns run on a fast one so " +
        "talking feels like talking; that is wrong for real work. Call this first, " +
        "before anything else, when what he said out loud is work: writing or " +
        "changing code, debugging, a build, a review, research that needs " +
        "judgement rather than a lookup. Not for lunch, the time, the map, a " +
        "picture, a quick fact. Typed turns are already on the strong model.",
      { why: z.string().describe("A few words: 'fixing the failing wake tests'.") },
      async (args) => {
        askForWork(args.why);
        return text("On your stronger model for the rest of this turn.");
      },
      { alwaysLoad: true },
    ),

    tool(
      "react",
      "Pull a face on his screen for a few seconds, over the conversation, " +
        "then it goes by itself. A reaction, not a picture: deadpan (-_-) when " +
        "he says something daft or obvious, side-eye when he is up to " +
        "something, laugh when he is actually funny, surprised, thinking, " +
        "wince when something went badly, smug when you were right, happy. " +
        "Use it where a person's face would move, which is rarely: a face on " +
        "every turn is a tic. It replaces nothing on the stage. The caption is " +
        "a word or two ('bruh.'), and the spoken reply still happens — often " +
        "the face is the joke and the line is short.",
      {
        face: z.enum(FACES),
        caption: z.string().optional().describe(`A word or two under it, ${CAPTION_MAX} characters at most.`),
      },
      async (args) => text(express(args.face, args.caption)),
      { alwaysLoad: true },
    ),

    // The TV. Loaded with the prompt like the map: these are spoken asks from
    // the couch, and a tool search is a second round trip before anything moves.
    tool(
      "tv_power",
      "Turn the living-room TV on or off. It's a Fire TV you reach over the home " +
        "network, so this works whatever it's showing, screensaver included.",
      { on: z.boolean().describe("true to turn it on, false to turn it off.") },
      async (args) => text(await tv().power(args.on)),
      { alwaysLoad: true },
    ),

    tool(
      "tv_volume",
      "Change the TV's volume, which runs 0 to 100. Give `to` for a level, `by` " +
        "for a step (+5, -10), or `mute`. 'A bit louder' is about +3, 'louder' +5, " +
        "'way louder' +10. The answer is the level it reads back afterwards.",
      {
        to: z.number().optional().describe("A level, 0-100."),
        by: z.number().optional().describe("A step up (positive) or down (negative)."),
        mute: z.boolean().optional().describe("true to mute, false to unmute."),
      },
      async (args) => text(await tv().volume({ to: args.to, by: args.by, mute: args.mute })),
      { alwaysLoad: true },
    ),

    tool(
      "tv_remote",
      "Press a button on the TV's remote: play_pause, play, pause, back, home, " +
        "rewind, fast_forward. There is no up, down or OK, on purpose: you can't " +
        "see the TV, and a blind press lands on whatever is focused (once it " +
        "rated a show instead of playing it). Reach things by name with tv_open " +
        "or tv_netflix instead.",
      { button: z.enum(Object.keys(REMOTE) as [Button, ...Button[]]) },
      async (args) => text(await tv().remote(args.button)),
      { alwaysLoad: true },
    ),

    tool(
      "tv_open",
      "Open an app on the TV by name: Netflix, YouTube, Disney+, Crave, Spotify, " +
        "Twitch, Prime Video. It only opens it: 'open Netflix' means exactly this, " +
        "and he picks the profile and the show himself. To resume or play a show, " +
        "use tv_netflix.",
      { app: z.string().describe("The app's name as he said it: 'netflix', 'youtube'.") },
      async (args) => text(await tv().open(args.app)),
      { alwaysLoad: true },
    ),

    tool(
      "tv_netflix",
      "Play something on Netflix on the TV. With no id it resumes what he was " +
        "last watching ('resume my show', 'put my show on') and checks it really " +
        "resumed where he left off. With an id it plays that title: find the id " +
        "by searching the web for '<title> netflix'; it is the number in " +
        "netflix.com/title/<id>. Plays on whichever profile Netflix used last. " +
        "Takes 15 to 30 seconds, so say a few words first ('putting it on').",
      { id: z.string().optional().describe("A Netflix title id, digits only. Leave out to resume.") },
      async (args) => text(await tv().netflix({ id: args.id })),
      { alwaysLoad: true },
    ),

    tool(
      "tv_status",
      "What the TV is doing: on or off, which app is in front, the volume, " +
        "whether Netflix is playing and where, and what he was last watching on " +
        "Netflix. Use it to answer 'what was I watching' or before changing " +
        "something when you need to know where it stands.",
      {},
      async () => text(await tv().status()),
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
    "registry, control of his Windows desktop, and his TV.",
  tools: velaToolDefs,
});
