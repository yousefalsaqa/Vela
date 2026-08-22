import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreEvent } from "./core.js";
import { current, clear, worthRestoring, contentTypeFor, type Screen } from "./screen.js";

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

export interface Endpoint {
  port: number;
  token: string;
  pid: number;
}

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
}

export interface RunningServer {
  endpoint: Endpoint;
  close: () => Promise<void>;
}

/**
 * What she is told when he talks over her.
 *
 * Phrased as an observation rather than a telling-off, because the useful
 * response is a shorter next answer, not an apology for the last one.
 */
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
 * origin, which is exactly what lets /anime.js load and nothing else. The
 * font hosts are the two the hub itself uses.
 */
export const SCREEN_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src data: https://fonts.gstatic.com; " +
  "img-src data: blob:; media-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'";

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
   * exactly one door, GET /screen/file, and is minted afresh for every show,
   * so the most a hostile page can steal is permission to re-read itself.
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
    if (req.method === "GET" && path === "/anime.js") {
      try {
        const bundle = resolve(here, "../node_modules/animejs/dist/bundles/anime.umd.min.js");
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "max-age=86400",
        });
        res.end(readFileSync(bundle));
      } catch {
        // The page checks for it and falls back to no motion rather than
        // throwing on every animate() call.
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "anime.js is not installed" }));
      }
      return;
    }

    // The one door the screen's own key opens: the file currently being
    // shown, and nothing else. The master token also works, for curl.
    if (req.method === "GET" && path === "/screen/file") {
      const given = query.get("s");
      if (!authed(req, query.get("k")) && !(given && screenToken && given === screenToken)) {
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
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of [...clients]) {
      try {
        c.write(frame);
      } catch {
        clients.delete(c); // a client that hung up mustn't take the rest down
      }
    }
  });

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
        close: () =>
          new Promise<void>((done) => {
            unsubscribe();
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
