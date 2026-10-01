import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreEvent } from "./core.js";
import { current, clear, worthRestoring, contentTypeFor, type Screen } from "./screen.js";
import { isTile, type TileSource } from "./tiles.js";

/**
 * Vela as a local service, so she outlives the window you started her from and
 * can wear more than one face — the REPL now, a voice loop next.
 *
 * Bound to 127.0.0.1 and gated on a token written to disk beside the database.
 * The core runs with bypassPermissions and has the whole machine, so "only
 * local" is not on its own a good enough door.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENDPOINT_FILE = resolve(here, "../data/server.json");
/** The page itself. Exported so a test can hold it to the URL that opens it. */
export const HUB_FILE = resolve(here, "hub.html");

export interface Endpoint {
  port: number;
  token: string;
  pid: number;
}

/**
 * The address of her second face. The same address every time.
 *
 * Here rather than beside the caller because it is half of a contract the
 * compiler cannot see: this writes the query, and the first lines of hub.html
 * read it back by name. Nothing links the two — the page is served as text and
 * never imports anything — so a parameter renamed on one side goes on working,
 * silently, doing nothing. See the contract test in tests/server.test.ts.
 *
 * `k` is the token; EventSource cannot carry a header, so it travels in the
 * address bar and the page takes it out again on arrival.
 *
 * It briefly also carried a per-window id, so a dismissal could close the one
 * window she opened and leave his alone. That bought a distinction he did not
 * want at the cost of the thing he did: a link that is character-for-character
 * the same every time, which is what makes it pinnable. Goodbye now closes the
 * hub, whoever opened it.
 */
export const hubUrl = (e: Endpoint): string =>
  `http://127.0.0.1:${e.port}/?k=${encodeURIComponent(e.token)}`;

/** What the server needs from the core — kept narrow so tests can fake it. */
export interface ServableCore {
  send: (text: string) => void;
  subscribe: (listener: (event: CoreEvent) => void) => () => void;
  isBusy: () => boolean;
}

export function readEndpoint(file = ENDPOINT_FILE): Endpoint | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Endpoint;
  } catch {
    return null; // not running, or never has
  }
}

/** Her durable key, if she has been started with `keepToken` before. */
function readToken(file: string): string | null {
  try {
    const saved = readFileSync(file, "utf8").trim();
    return saved.length >= 32 ? saved : null;
  } catch {
    return null; // first ever start
  }
}

export interface ServeOptions {
  core: ServableCore;
  port?: number;
  /** Where to advertise the endpoint. Tests point this somewhere disposable. */
  endpointFile?: string;
  name?: string;
  /**
   * Turn what a browser recorded into words. Absent means the hub's microphone
   * button is not offered rather than offered and broken.
   */
  hear?: (audio: Buffer) => Promise<string>;
  /**
   * The live map, if she has one. Its changes stream to the hub as "map"
   * events, which the hub hands to the page on the stage — the page itself
   * can reach nothing — and a hub that has just opened asks for it here.
   */
  map?: {
    state: () => unknown;
    onChange: (fn: (state: unknown) => void) => () => void;
  };
  /**
   * The map's tiles, fetched and kept by Vela. Absent, /tiles answers 404
   * and the map draws its places over a blank sea.
   */
  tiles?: TileSource;
  /** Turn her words into a wav the browser can play. Absent means a mute hub. */
  render?: (text: string) => Promise<Buffer | null>;
  /** What is on the screen. Defaults to the real screen module; tests inject. */
  screen?: () => Screen | null;
  /**
   * Start loading a speech model before it is needed.
   *
   * The models are held back until first use, which is what keeps an
   * always-on Vela at ~460MB instead of 1.5GB. The hub knows he is about to
   * need one before the audio exists — he pressed record, he switched sound
   * on — so the load happens in that gap rather than as a wait afterwards.
   */
  warm?: (what: "ears" | "voice") => void;
  /**
   * Reuse the last run's token instead of minting a new one.
   *
   * A random token per start is right for a thing you launch and read a link
   * from. It is wrong for a thing that runs from boot: the hub could never be
   * bookmarked, pinned to the taskbar, or opened by a hotkey, because its
   * address changed every restart. Kept, the address is permanent.
   */
  keepToken?: boolean;
  /**
   * Is she being spoken aloud in the room right now?
   *
   * `announce` only reaches clients that are already attached, which is fine
   * for a state change and wrong for a state. A hub opened part-way through a
   * spoken turn — which is what the wake word does when it opens one — never
   * saw the announcement, so it would start up believing the room is silent
   * and say the rest of the reply over her. Asked here, it starts up knowing.
   */
  aloud?: () => boolean;
  /**
   * The last line she said that was not a turn, and when: "Yes?" to her
   * name. The hub that name opened arrives after she has said it, so the
   * announcement misses it and the handshake carries it instead. Recent only
   * — see /health.
   */
  lastSaid?: () => { text: string; at: number } | null;
  /**
   * The microphone and the speakers in the room she is actually in.
   *
   * The hub used to be a second pair of these: its own browser microphone, its
   * own browser voice, coordinated with the room's by announcement. Two of
   * everything is what made two of her, and the coordination was the bug
   * rather than the fix. When the service is in a room, the hub stops being a
   * second Vela and becomes the controls for the one that exists.
   *
   * Asked rather than held, because the room is built after the server it
   * reports to: the wake word needs somewhere to announce before it can
   * listen. Returning null means there is no room — no wake word, no speakers
   * — and the hub falls back to its own microphone and its own voice, which is
   * the whole interface on a service that has neither.
   */
  room?: () => RoomControls | null;
}

/** The one microphone and the one voice, as the hub is allowed to drive them. */
export interface RoomControls {
  /** False while he is muted: she cannot hear the room at all. */
  hearing: () => boolean;
  /** Mute or unmute him. */
  setHearing: (on: boolean) => void;
  /** False while she is muted: she still answers, just not out loud. */
  speaking: () => boolean;
  /** Mute or unmute her. */
  setSpeaking: (on: boolean) => void;
  /**
   * Stop the sentence sounding right now, and the rest of this reply with it.
   *
   * Not a toggle, and not the same as muting her: mute is a standing setting
   * about every reply after it, this is about the one he has heard enough of.
   * He keeps his voice, she keeps hers, and the next thing either says works
   * normally.
   */
  cut: () => void;
  /**
   * He pressed her: take the next thing he says as said to her.
   *
   * The same as saying "Hey Vela" and nothing else, without the saying. In a
   * room her face used to mute the microphone, and a hub that had not yet
   * learned it was in one recorded him itself instead — which handed the turn
   * to the model as typed, past everything the wake word knows about a
   * conversation, "you can go now" included.
   */
  listen?: () => void;
}

export interface RunningServer {
  endpoint: Endpoint;
  /**
   * Say something to every attached client that the core did not say.
   *
   * The stream is otherwise a mirror of the core, which is right for what she
   * says and wrong for facts about the room she says it in. A client that
   * cannot hear the room has no other way to learn that this reply is already
   * being spoken aloud in it.
   */
  announce: (payload: unknown) => void;
  /**
   * How many clients are attached: hub tabs, and any REPL that has attached.
   *
   * The wake word opens a hub when she is addressed, and opening a second one
   * for every turn is worse than never opening any. This is how it knows one
   * is already there.
   */
  attached: () => number;
  close: () => Promise<void>;
}

/**
 * What she is told when he talks over her.
 *
 * Phrased as an observation rather than a telling-off, because the useful
 * response is a shorter next answer, not an apology for the last one.
 */
/**
 * How long a canned line stays worth showing a hub that arrives late. The
 * window the wake word gives a browser to open and attach is twenty seconds
 * (see showHer); anything older than that is not the line this tab was
 * opened for.
 */
export const SAID_FRESH_MS = 20_000;

export const CUT_OFF =
  "[He interrupted you to say this, so he had heard enough. That last reply " +
  "was longer than it needed to be. Answer this one in one sentence.]";

/**
 * What a shown page may do: draw itself, run its own script, and nothing else.
 *
 * The screen renders agent-written HTML with scripting on, and some of what
 * goes into those pages was read off the internet. The scoped token keeps the
 * master token out of the page's URL; this keeps whatever the page does hold
 * from leaving. connect-src 'none' closes fetch, XHR and WebSocket;
 * form-action 'none' closes forms; scripts run only inline or from this
 * origin, which is exactly what lets /anime.js and /leaflet.js load and
 * nothing else. The font hosts are the two the hub itself uses.
 *
 * One widening, for the map: stylesheets from this origin, so /leaflet.css
 * can load. Images come from this origin too and from nowhere else. The map's
 * tiles used to load straight from OpenStreetMap, which left one outside host
 * an image URL could carry data to; OpenStreetMap then started refusing them,
 * because a sandboxed page cannot say who it is. They come through /tiles now
 * (see tiles.ts), and the outside host is gone with them. (CARTO's dark tiles
 * were the first choice; they now answer every request with "API KEY
 * REQUIRED" painted across the tile.)
 */
export const SCREEN_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src data: https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; media-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Public library files the screen may load, by path. See /anime.js below. */
const VENDORED: Record<string, { file: string; type: string }> = {
  "/anime.js": { file: "../node_modules/animejs/dist/bundles/anime.umd.min.js", type: "text/javascript" },
  "/leaflet.js": { file: "../node_modules/leaflet/dist/leaflet.js", type: "text/javascript" },
  "/leaflet.css": { file: "../node_modules/leaflet/dist/leaflet.css", type: "text/css" },
};

/** Read a whole request body. Audio is bytes, so this never assumes utf8. */
function collect(
  req: { on: (event: string, fn: (chunk?: Buffer) => void) => void },
  done: (body: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunk && chunks.push(Buffer.from(chunk)));
  req.on("end", () => done(Buffer.concat(chunks)));
}

export function serve(opts: ServeOptions): Promise<RunningServer> {
  const endpointFile = opts.endpointFile ?? ENDPOINT_FILE;
  // The endpoint file says "she is running, here" and is removed when she
  // stops. Her key outlives that, so it lives beside it in its own file.
  const tokenFile = join(dirname(endpointFile), "hub-token");
  const token = opts.keepToken
    ? (readToken(tokenFile) ?? randomBytes(24).toString("hex"))
    : randomBytes(24).toString("hex");
  const name = opts.name ?? "Vela";
  const clients = new Set<{ write: (chunk: string) => void; end: () => void }>();
  const screenState = opts.screen ?? current;

  /**
   * The screen's own key, and the only one a shown page ever sees.
   *
   * The stage iframe runs agent-written HTML with scripting on, and a page
   * can always read its own URL — so whatever token rides in that URL is a
   * token the page holds. Handing it the master token would hand it POST
   * /turn on an assistant running with bypassPermissions. This one opens
   * two doors, GET /screen/file and the map tiles under /tiles, and is
   * minted afresh for every show, so the most a hostile page can steal is
   * permission to re-read itself and to look at a map of the world.
   * The hub learns it over master-authed channels: the /events frame and
   * GET /screen.
   */
  let screenToken: string | null = null;
  const mintScreenToken = () => (screenToken = randomBytes(24).toString("hex"));

  /**
   * Take it down for everyone.
   *
   * Injected state means a test drives the screen itself, so this only calls
   * the real module when it is the real module. Either way the key goes: a
   * page that is no longer showing anything has no business holding a key to
   * the file it was showing.
   */
  const dropScreen = () => {
    if (!opts.screen) clear();
    screenToken = null;
  };

  /**
   * The token, from either door.
   *
   * A browser can set a header on fetch but not on a plain navigation, and
   * EventSource cannot set one at all, so the hub could not exist on the
   * header alone. `?k=` is the second door. The page strips it out of the
   * address bar as its first act, so it stops being in the history the moment
   * it has been read.
   */
  const authed = (req: { headers: { authorization?: string } }, key: string | null) =>
    req.headers.authorization === `Bearer ${token}` || key === token;

  /** The screen's key, or the master one. What the page on the stage may open. */
  const screenAuthed = (req: { headers: { authorization?: string } }, query: URLSearchParams) => {
    const given = query.get("s");
    return authed(req, query.get("k")) || Boolean(given && screenToken && given === screenToken);
  };

  const server: Server = createServer((req, res) => {
    // Parsed once; every route below reads from the same parse.
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query = url.searchParams;
    const path = url.pathname;

    // Vendored rather than fetched from a CDN: she works with the network
    // down, and her own face should not be the thing that stops. Served with
    // no token at all, because the sandboxed screen pages that want it for
    // motion have no token to give — and a public copy of a public library
    // guards nothing.
    if (req.method === "GET" && VENDORED[path]) {
      const { file, type } = VENDORED[path];
      try {
        const bundle = readFileSync(resolve(here, file));
        res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "max-age=86400" });
        res.end(bundle);
      } catch {
        // The page checks for it and falls back rather than throwing: no
        // motion without anime.js, a plain message without Leaflet.
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `${path.slice(1)} is not installed` }));
      }
      return;
    }

    // The first door the screen's own key opens: the file currently being
    // shown. The master token also works, for curl.
    if (req.method === "GET" && path === "/screen/file") {
      if (!screenAuthed(req, query)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad or missing token" }));
        return;
      }
      const shown = screenState();
      if (!shown) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nothing is on the screen" }));
        return;
      }
      try {
        const bytes = readFileSync(shown.path);
        res.writeHead(200, {
          "content-type": contentTypeFor(shown.path) ?? "application/octet-stream",
          // Two shows of the same path must not serve a stale first draft.
          "cache-control": "no-store",
          "content-security-policy": SCREEN_CSP,
        });
        res.end(bytes);
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "the shown file is gone from disk" }));
      }
      return;
    }

    // The second, and the last: the map's tiles, which Vela fetches so the
    // page does not have to (tiles.ts says why). Behind the screen's key
    // rather than open like /leaflet.js, because this route goes out to the
    // internet on its caller's behalf, and any page in his browser can point
    // an <img> at this port. Only the page she is showing gets to ask.
    const tile = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
    if (req.method === "GET" && tile) {
      if (!screenAuthed(req, query)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad or missing token" }));
        return;
      }
      const [z, x, y] = tile.slice(1).map(Number);
      if (!opts.tiles || !isTile(z, x, y)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: opts.tiles ? "no such tile" : "no map tiles here" }));
        return;
      }
      const failed = () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "OpenStreetMap did not send that tile" }));
      };
      opts.tiles(z, x, y).then((png) => {
        if (!png) return failed();
        res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=86400" });
        res.end(png);
      }, failed);
      return;
    }

    // Her second face. One file, no build step, no request to anywhere else.
    //
    // Served without a key, and that is deliberate. The page holds no secrets
    // — every route that carries anything of his is still locked — and the
    // page is what asks for the key rather than what leaks it. Behind the
    // gate, the pinned tab this release exists for could not survive being
    // reloaded: the page strips ?k= from the address bar as its first act, so
    // the reload arrives bare and is turned away before any of it can run.
    if (req.method === "GET" && (path === "/" || path === "/hub")) {
      try {
        // Never cached. There is no build step and no hash in the name, so a
        // cached copy is indistinguishable from the current one and the tab he
        // pinned goes on running whichever version it first met — which looked
        // exactly like a feature having been written and not working.
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(readFileSync(resolve(here, "hub.html"), "utf8"));
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "hub.html is missing" }));
      }
      return;
    }

    if (!authed(req, query.get("k"))) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad or missing token" }));
      return;
    }

    // What is up right now, for a hub that just loaded or reloaded. The
    // title, the note and the screen's key — never the path: his filesystem
    // layout stays on his machine.
    // He put it away. That is the end of it, not a thing this tab forgets and
    // the next one asks about again.
    if (req.method === "POST" && path === "/screen/clear") {
      dropScreen();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ screen: null }));
      return;
    }

    if (req.method === "GET" && path === "/screen") {
      let shown = screenState();
      // A page opening now gets what she is showing, not what she was showing
      // this morning. Old enough and it is taken down rather than hidden, so
      // every face agrees about what is up.
      if (shown && !worthRestoring(shown)) {
        dropScreen();
        shown = null;
      }
      if (shown && !screenToken) mintScreenToken(); // shown before anyone looked
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          screen: shown
            ? {
                id: shown.id,
                title: shown.title,
                shownAt: shown.shownAt,
                ...(shown.note !== undefined ? { note: shown.note } : {}),
                s: screenToken,
              }
            : null,
        }),
      );
      return;
    }

    // What the map is showing now, for a hub that opened after it changed.
    if (req.method === "GET" && path === "/map/state") {
      if (!authed(req, query.get("k"))) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorised" }));
        return;
      }
      const state = opts.map?.state() ?? null;
      if (!state) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name,
          busy: opts.core.isBusy(),
          pid: process.pid,
          // The hub asks before drawing a microphone or a speaker, so a
          // service without them shows a smaller face rather than a broken one.
          canHear: Boolean(opts.hear),
          canSpeak: Boolean(opts.render),
          // Not a capability but a fact about the room, and the one thing a
          // late-arriving hub cannot work out for itself. See ServeOptions.
          aloud: Boolean(opts.aloud?.()),
          // What she said on being addressed, for the hub that address opened
          // and that arrived after she said it. Recent only: a page reloaded
          // an hour later is not owed this morning's "Yes?".
          said: (() => {
            const said = opts.lastSaid?.();
            return said && Date.now() - said.at < SAID_FRESH_MS ? said.text : null;
          })(),
          // Present means the hub draws controls for the room's microphone and
          // voice instead of offering a second set of its own. Absent means
          // there is no room, and the hub is the only Vela there is.
          room: (() => {
            const room = opts.room?.();
            return room ? { hearing: room.hearing(), speaking: room.speaking() } : null;
          })(),
        }),
      );
      return;
    }

    // "He is about to need this." Answered immediately; the loading happens
    // behind it, and a service with nothing to warm still says yes so the hub
    // does not have to know which halves exist.
    if (req.method === "POST" && path === "/warm") {
      collect(req, (body) => {
        let what = "";
        try {
          what = (JSON.parse(body.toString("utf8") || "{}") as { what?: string }).what ?? "";
        } catch {
          /* handled as unknown below */
        }
        if (what !== "ears" && what !== "voice") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "what must be 'ears' or 'voice'" }));
          return;
        }
        opts.warm?.(what);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ warming: what }));
      });
      return;
    }

    /**
     * Mute or unmute the room: him, her, or both.
     *
     * The two toggles the hub draws are the same two the room already has, so
     * this is the wire between them rather than a second set. Absent room, a
     * 404 rather than a silent success: a control that reports working and
     * does nothing is the failure this whole change is undoing.
     */
    if (req.method === "POST" && path === "/room") {
      const room = opts.room?.();
      if (!room) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "she is not in a room" }));
        return;
      }
      collect(req, (body) => {
        let wanted: { hearing?: unknown; speaking?: unknown; stop?: unknown; listen?: unknown } = {};
        try {
          wanted = JSON.parse(body.toString("utf8") || "{}") as typeof wanted;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body must be JSON" }));
          return;
        }
        // Before the toggles, because a body carrying both is someone who
        // wants the room quiet now and muted after, and doing it the other way
        // round leaves the current sentence running through the change.
        if (wanted.stop === true) room.cut();
        // Absent leaves a toggle alone. Only a real boolean moves it, so a
        // typo cannot mute a microphone by accident.
        if (typeof wanted.hearing === "boolean") room.setHearing(wanted.hearing);
        if (typeof wanted.speaking === "boolean") room.setSpeaking(wanted.speaking);
        // After the toggles: pressing her is asking to be heard, so it has to
        // land on a microphone that a body unmuting it has already turned on.
        if (wanted.listen === true) room.listen?.();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hearing: room.hearing(), speaking: room.speaking() }));
      });
      return;
    }

    // What he just said into the browser, as words.
    if (req.method === "POST" && path === "/hear") {
      if (!opts.hear) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "this service has no ears" }));
        return;
      }
      collect(req, (audio) => {
        opts
          .hear!(audio)
          .then((text) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ text }));
          })
          .catch(() => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "could not transcribe that" }));
          });
      });
      return;
    }

    // A sentence of hers, as audio. One sentence per request, because the hub
    // asks as they stream rather than waiting for the whole reply.
    if (req.method === "POST" && path === "/speak") {
      if (!opts.render) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "this service has no voice" }));
        return;
      }
      collect(req, (body) => {
        let text = "";
        try {
          text = (JSON.parse(body.toString("utf8") || "{}") as { text?: string }).text ?? "";
        } catch {
          /* handled as empty below */
        }
        if (!text.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "text is required" }));
          return;
        }
        opts
          .render!(text)
          .then((wav) => {
            if (!wav?.length) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "nothing was synthesised" }));
              return;
            }
            res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
            res.end(wav);
          })
          .catch(() => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "could not synthesise that" }));
          });
      });
      return;
    }

    // Everything the core does, as it happens.
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      // end() is what tells an attached REPL she is going away, rather than
      // leaving it holding a stream that has quietly stopped saying anything.
      const client = { write: (chunk: string) => res.write(chunk), end: () => res.end() };
      clients.add(client);
      req.on("close", () => clients.delete(client));
      return;
    }

    if (req.method === "POST" && path === "/turn") {
      collect(req, (raw) => {
        try {
          const { text, cutOff } = JSON.parse(raw.toString("utf8") || "{}") as {
            text?: string;
            cutOff?: boolean;
          };
          if (!text?.trim()) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "text is required" }));
            return;
          }
          // Talking over her is the clearest feedback there is, and it is
          // wasted if she never learns it happened. She hears that she was cut
          // off, in the same turn, so the next reply is shorter.
          opts.core.send(cutOff ? `${CUT_OFF}

${text}` : text);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body must be JSON" }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such route" }));
  });

  const unsubscribe = opts.core.subscribe((event) => {
    // A new show retires the old screen's key with it, so a page that was
    // just replaced loses even the one door it had. The fresh key rides in
    // the frame itself; the stream is master-authed, so that costs nothing.
    let payload: unknown = event;
    if (event.type === "show") {
      if (event.screen) {
        mintScreenToken();
        payload = { ...event, screen: { ...event.screen, s: screenToken } };
      } else {
        screenToken = null;
      }
    }
    broadcast(payload);
  });

  const broadcast = (payload: unknown) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of [...clients]) {
      try {
        c.write(frame);
      } catch {
        clients.delete(c); // a client that hung up mustn't take the rest down
      }
    }
  };

  // Every change to the map, as it happens: the page moves, it is not rebuilt.
  const offMap = opts.map?.onChange((state) => broadcast({ type: "map", state })) ?? (() => {});

  return new Promise((fulfil) => {
    // A fixed port is what makes her address permanent, and it is also the one
    // thing that could stop her coming up at boot. If something already holds
    // it, take any free port rather than not existing.
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") throw err;
      server.listen(0, "127.0.0.1");
    });

    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const endpoint: Endpoint = { port, token, pid: process.pid };

      mkdirSync(dirname(endpointFile), { recursive: true });
      writeFileSync(endpointFile, JSON.stringify(endpoint, null, 2));
      // Written only when she was asked to keep it, so an ordinary run never
      // leaves a reusable key on disk.
      if (opts.keepToken) writeFileSync(tokenFile, token, "utf8");

      fulfil({
        endpoint,
        announce: broadcast,
        attached: () => clients.size,
        close: () =>
          new Promise<void>((done) => {
            unsubscribe();
            offMap();
            for (const c of clients) {
              try {
                c.end();
              } catch {
                /* already gone */
              }
            }
            clients.clear();
            try {
              rmSync(endpointFile, { force: true });
            } catch {
              /* nothing to clean up */
            }
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
