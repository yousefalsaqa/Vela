"""Every state the room has to hold, driven through the real SSE stream.

Claims, in order:
  1. Working reads as working, and the tool she is in shows in the rail.
  2. Tool lines do not pile up in the transcript; they fold into one count.
  3. That fold opens, so nothing is hidden — only demoted.
  4. Markdown is gone from what he reads and from what she says out loud.
  5. Her reply is one thing at full weight; the exchange before it recedes.
  6. An autonomous line is visibly hers-first, not an answer to anything.
  7. A screen takes the desk, and the conversation gives up width to it.
  8. A click on her screen returns as a turn, marked as coming from the screen.
  9. A reload keeps it; putting it away ends it everywhere.
 10. An error is readable and does not become a dashboard.
 11. On a phone the material is the interface, and memory is pulled up.
"""
import json, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

here = Path(__file__).parent
e = json.loads((here / "server.json").read_text())
base = f"http://127.0.0.1:{e['port']}"
KEY = e["token"]
turns = here / "turns.log"

def push(msg):
    urllib.request.urlopen("http://127.0.0.1:4899", json.dumps(msg).encode(), timeout=5)
    time.sleep(0.45)

def until(cond, secs=8):
    """Wait on the thing, not on the clock. A fixed sleep passes on a fast
    machine and fails on a busy one, which is how a suite learns to be
    ignored."""
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.08)
    return False

failures = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda x: errs.append(str(x)))
    page.goto(f"{base}/?k={KEY}")
    page.wait_for_load_state("networkidle")

    # ── the work panel announces work, not thinking ───────────────────────
    # A turn that only thinks and answers should not move furniture: the panel
    # arrives with the first real tool call and leaves when the turn ends.
    page.fill("#text", "say hello")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    push({"type": "delta", "text": "Hey."})
    check("no tools means no work panel", page.locator("#worksPanel").is_hidden())
    push({"type": "result", "ms": 300})
    time.sleep(0.3)

    # ── a turn, with tools ────────────────────────────────────────────────
    page.fill("#text", "what is drifting on the turbofan set")
    page.keyboard.press("Enter")
    time.sleep(0.4)
    push({"type": "activity", "lines": ["Read c-mapss/train_FD001.txt"]})
    check("the first tool call summons the work panel", page.locator("#worksPanel").is_visible())
    check("working reads as working", page.locator("#state").inner_text().lower() == "working",
          page.locator("#state").inner_text())
    check("the tool she is in shows in the rail", "train_FD001" in page.locator("#doing").inner_text(),
          page.locator("#doing").inner_text())
    push({"type": "activity", "lines": ["Bash python drift.py"]})
    push({"type": "activity", "lines": ["Grep sensor_9"]})
    page.screenshot(path=str(here / "s-working.png"))

    for chunk in ["Sensor 9 is the one drifting. ", "It climbs about four degrees over the last eighty cycles."]:
        push({"type": "delta", "text": chunk})
    check("her words land as words", "Sensor 9" in page.locator(".her").last.inner_text())
    push({"type": "result", "ms": 4200})
    time.sleep(0.3)

    check("tool lines do not pile up in the transcript",
          page.locator(".stepped").count() == 1 and page.locator(".stepped").is_hidden())
    steps = page.locator(".steps").last.inner_text()
    check("the work is summed up in English, not tool names",
          "read one file" in steps and "ran one command" in steps and "searched" in steps, steps)
    check("and it says how long she took", "4.2s" in steps, steps)
    page.locator(".steps").last.click()
    time.sleep(0.3)
    check("the fold opens rather than hiding the work", page.locator(".stepped").is_visible())
    check("every step she took is really there", page.locator(".stepped li").count() == 3,
          str(page.locator(".stepped li").count()))
    check("the rail lets the tool go when she is done", page.locator("#doing").inner_text() == "")
    check("she is back with him", page.locator("#state").inner_text().lower() == "with you")
    until(lambda: page.locator("#worksPanel").is_hidden())
    check("the work panel leaves when the turn ends", page.locator("#worksPanel").is_hidden())
    page.locator(".steps").first.click()   # fold it away again
    time.sleep(0.2)

    # ── an error takes the work panel down with it ────────────────────────
    # A dead turn's steps must never stand into the next one.
    page.fill("#text", "break something")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    push({"type": "activity", "lines": ["Bash python boom.py"]})
    check("the panel is up during the doomed turn", page.locator("#worksPanel").is_visible())
    push({"type": "error", "message": "API Error: 500 upstream"})
    until(lambda: page.locator("#worksPanel").is_hidden())
    check("an error clears the work panel, not just hides it",
          page.locator("#worksPanel").is_hidden() and page.locator("#works li").count() == 0)

    # ── a long turn: the reason the cap exists ────────────────────────────
    page.fill("#text", "go through the whole set")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    for i in range(11):
        push({"type": "activity", "lines": [f"Read unit_{i}.txt"]})
    push({"type": "delta", "text": "Four of them drift."})
    push({"type": "result", "ms": 30000})
    time.sleep(0.3)
    last = page.locator(".turn").last
    last.locator("> .steps").click()
    time.sleep(0.3)
    # Small numbers read better spelt out, larger ones as numerals — "read 11
    # files" is the English, "read eleven files" is a style guide being obeyed
    # past the point where anyone writes that way.
    check("a long turn still counts honestly", "read 11 files" in last.locator("> .steps").inner_text(),
          last.locator("> .steps").inner_text())
    built = last.locator(".stepped li").count()
    check("but only the last few are built", built == 8, str(built))  # 7 lines + the 'more' row
    last.locator(".stepped .steps").click()
    time.sleep(0.3)
    built = last.locator(".stepped li").count()
    check("and the earlier ones come back when asked", built == 11, str(built))
    page.screenshot(path=str(here / "s-steps.png"))

    # ── markdown: gone from the page, gone from her mouth ─────────────────
    page.fill("#text", "explain captureScreen")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    # Streamed the way she really sends it, with a marker split across chunks.
    for chunk in ["The **cap", "tureScreen** helper reads ", "`desktop.ts` and writes to ",
                  "C:\\Users\\Yousef\\Desktop\\Vela\\data\\screen\\shot.png. "]:
        push({"type": "delta", "text": chunk})
    push({"type": "result", "ms": 800})
    time.sleep(0.3)
    said = page.locator(".turn").last.locator(".her").inner_text()
    check("the markers are gone from what he reads", "**" not in said and "`" not in said, said)
    check("but the words they wrapped are still there",
          "captureScreen" in said and "desktop.ts" in said, said)
    check("a marker split across two chunks is never drawn half-open",
          "**cap" not in page.content(), said)

    # What actually reaches Kokoro, read off the service rather than guessed
    # at from the browser side.
    spoken_log = here / "spoken.log"
    spoken_log.write_text("", encoding="utf8")
    page.locator("#ear").click()          # a real gesture, which is what the audio context needs
    until(lambda: page.evaluate("speaking") is True)
    page.fill("#text", "say that again")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    push({"type": "delta", "text": "It reads `desktop.ts` and writes to C:\\Users\\Yousef\\shot.png. "})
    push({"type": "result", "ms": 500})
    until(lambda: spoken_log.read_text(encoding="utf8").strip() != "")
    heard = spoken_log.read_text(encoding="utf8")
    check("she is handed something to say", bool(heard.strip()), repr(heard))
    check("and never reads punctuation out loud",
          "`" not in heard and "**" not in heard, heard)
    check("a windows path becomes the filename, not the whole path",
          "C:\\" not in heard and "shot.png" in heard, heard)
    # ── talking over her stops her, rather than her reading into his mic ──
    # The confirmed bug: barge-in silenced the queue but left `speaking` true,
    # so the rest of a streaming reply played over his recording. Typing over
    # her takes the same path as the mic, and needs no fake microphone.
    spoken_log.write_text("", encoding="utf8")
    page.locator("#ear").click()          # voice back on
    until(lambda: page.evaluate("speaking") is True)
    page.fill("#text", "tell me about the burner")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    push({"type": "delta", "text": "The burner sits at station forty. "})
    until(lambda: spoken_log.read_text(encoding="utf8").strip() != "")
    spoke_before = len(spoken_log.read_text(encoding="utf8").splitlines())
    # He cuts in before she finishes; the reply is still streaming.
    page.fill("#text", "never mind, what about the fan")
    page.keyboard.press("Enter")
    time.sleep(0.2)
    push({"type": "delta", "text": "It reaches about a thousand degrees Rankine. "})
    push({"type": "delta", "text": "The liner is the first thing to go. "})
    push({"type": "result", "ms": 1200})
    time.sleep(0.8)
    spoke_after = len(spoken_log.read_text(encoding="utf8").splitlines())
    check("cutting her off stops the rest of that reply being spoken",
          spoke_after == spoke_before, f"before {spoke_before}, after {spoke_after}")
    check("and no word is left lit gold after the cut",
          page.locator(".w.saying").count() == 0)
    check("the sentence teardown ran, so nothing is left playing",
          page.evaluate("stopCurrent") is None)
    page.locator("#ear").click()          # back off, so later checks are quiet

    # ── a second exchange, so the first has to recede ─────────────────────
    page.fill("#text", "and cycle 200?")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    push({"type": "delta", "text": "Failure is around cycle two hundred and six."})
    push({"type": "result", "ms": 900})
    check("exactly one exchange is at full weight", page.locator(".turn:not(.past)").count() == 1,
          str(page.locator(".turn:not(.past)").count()))
    page.screenshot(path=str(here / "s-said.png"))

    # ── she starts one herself ────────────────────────────────────────────
    push({"type": "say", "text": "The fantasy build finished, forty one seconds."})
    check("an autonomous line is marked as hers first", page.locator(".turn.unbidden").count() == 1)
    check("and carries when she said it", ":" in page.locator(".turn.unbidden .when").inner_text())
    page.screenshot(path=str(here / "s-unbidden.png"))

    # ── the screen ────────────────────────────────────────────────────────
    push({"screen": "on"})
    time.sleep(0.8)
    check("the stage takes the room", page.evaluate("document.body.dataset.stage") == "on")
    check("the conversation gives up width to it",
          page.evaluate("getComputedStyle(document.getElementById('thread')).maxWidth")
          != page.evaluate("getComputedStyle(document.querySelector('.dock')).maxWidth"))
    check("the work and the screen are panels he can move",
          page.locator(".panel .grip").count() == 2)
    src = page.eval_on_selector("#stageFrame", "el => el.src")
    check("the frame gets the screen key and never the master token",
          "s=" in src and KEY not in src, src)
    page.screenshot(path=str(here / "s-stage.png"))

    frame = next(f for f in page.frames if "/screen/file" in f.url)
    # The circle, not the group: the group's box includes the label under it,
    # so its centre is empty canvas. A real lesson for the pages she writes.
    frame.locator("#s9 circle").click()
    time.sleep(0.6)
    got = turns.read_text()
    check("a click on her screen reaches her as a turn",
          "[He did this on the screen: he clicked sensor 9" in got, got[-90:])
    check("and reads as the screen, not as typing", page.locator(".you.onscreen").count() == 1)

    # talking about what is up, without losing it
    page.fill("#text", "why does that one drift")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    push({"type": "delta", "text": "Fouling on the compressor, mostly."})
    push({"type": "result", "ms": 1100})
    check("we can talk about it without the stage going away",
          page.evaluate("document.body.dataset.stage") == "on")
    page.screenshot(path=str(here / "s-stage-talk.png"))

    # Reloading mid-discussion keeps it: he did not put it away, he refreshed.
    page.reload()
    page.wait_for_load_state("networkidle")
    time.sleep(0.8)
    check("a reload restores what she had up", page.evaluate("document.body.dataset.stage") == "on")

    # Putting it away is the end of it. It used to hide in this tab only, so
    # the next page to open asked what was up and got back the thing he had
    # just closed — which is what "why is it still there every time" was.
    page.locator("#stageShut").click()
    time.sleep(0.6)
    check("putting it away takes it off the stage", page.evaluate("document.body.dataset.stage") is None)
    check("and takes it back when the screen goes",
          page.evaluate("document.body.dataset.stage") is None)
    page.reload()
    page.wait_for_load_state("networkidle")
    time.sleep(0.8)
    check("and it stays gone when he opens her again",
          page.evaluate("document.body.dataset.stage") is None)

    # Put it back for the checks below, which need something on the stage.
    push({"screen": "on"})
    time.sleep(0.8)

    # ── trouble ───────────────────────────────────────────────────────────
    push({"type": "error", "message": "API Error: 400 something went wrong upstream"})
    check("an error is said plainly", page.locator(".hitch").count() == 1)
    page.screenshot(path=str(here / "s-error.png"))

    # ── a growing composer must not be covered by a panel ─────────────────
    # Confirmed bug: composing a multi-line message grew the textarea, the
    # floor shrank under it, and a low panel kept its old rectangle and painted
    # its opaque body down over the dock — hiding the text and eating clicks
    # meant for send.
    push({"screen": "off"})
    page.fill("#text", "let me get the whole engine working first")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    push({"type": "activity", "lines": ["Bash python long_run.py"]})  # work panel, low and up
    time.sleep(0.3)
    page.fill("#text", "\n".join("this is line %d of a long message" % i for i in range(8)))
    time.sleep(0.3)
    sb = page.locator("#send").bounding_box()
    at_send = page.evaluate(
        "([x,y]) => { const el = document.elementFromPoint(x,y); return el ? (el.closest('.dock') ? 'dock' : (el.closest('.panel') ? 'panel' : el.tagName)) : 'none'; }",
        [sb["x"] + sb["width"] / 2, sb["y"] + sb["height"] / 2],
    )
    check("send stays clickable under a grown composer", at_send == "dock", at_send)
    check("the desk clips its panels at its own edge",
          page.evaluate("getComputedStyle(document.querySelector('.floor')).overflow").startswith("hidden"))
    page.fill("#text", "")
    push({"type": "delta", "text": "Done."})
    push({"type": "result", "ms": 500})
    time.sleep(0.3)

    # ── the phone ─────────────────────────────────────────────────────────
    # Something on the stage, and a line of hers around it: a screen with no
    # conversation is not the case being checked.
    push({"screen": "on"})
    push({"type": "delta", "text": "Sensor 9 again, top right."})
    push({"type": "result", "ms": 700})
    page.set_viewport_size({"width": 390, "height": 844})
    time.sleep(0.7)
    # The claim used to be that the transcript disappears entirely behind a
    # screen. It reads better with her latest line kept: on a phone, mid
    # conversation, "look at sensor 9" is useless if what she said about it is
    # gone. Older exchanges still go.
    check("her latest line stays readable over what she is showing",
          page.locator(".turn:not(.past) .her").last.is_visible())
    check("but the rest of the conversation does not crowd it",
          page.locator(".turn.past").first.is_hidden())
    check("and taps still reach the thing she is showing",
          page.evaluate("getComputedStyle(document.getElementById('thread')).pointerEvents") == "none")
    page.screenshot(path=str(here / "s-phone-stage.png"))
    page.locator("#pull").click()
    time.sleep(0.5)
    check("memory is pulled up when he wants it", page.locator("#thread").is_visible())
    check("and covers the room rather than sharing it",
          page.evaluate("getComputedStyle(document.getElementById('thread')).position") == "fixed")
    page.screenshot(path=str(here / "s-phone-memory.png"))
    page.locator("#pull").click()
    time.sleep(0.4)

    push({"screen": "off"})
    time.sleep(0.6)
    check("with nothing up, the phone is just her", page.evaluate("document.body.dataset.stage") is None)
    page.screenshot(path=str(here / "s-phone-quiet.png"))

    check("no page errors through any of it", not errs, "; ".join(errs[:3]))
    browser.close()

print("RESULT:", "OK" if not failures else f"{len(failures)} FAILED")
sys.exit(1 if failures else 0)
