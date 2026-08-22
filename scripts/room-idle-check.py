"""Drive the redesigned Hub through real states at real viewport sizes.

Nothing here is mocked in the page: the events are pushed through the actual
SSE stream by a fake core standing in for the model, so every state the page
enters is one the real core can produce.
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

here = Path(__file__).parent
e = json.loads((here / "server.json").read_text())
base = f"http://127.0.0.1:{e['port']}"
KEY = e["token"]

SIZES = {
    "wide": (2560, 1400),
    "laptop": (1440, 900),
    "narrow": (900, 820),
    "phone": (390, 844),
    "phone-landscape": (844, 390),
}

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
    page.on("console", lambda m: errs.append("console:" + m.text) if m.type == "error" else None)

    page.goto(f"{base}/?k={KEY}")
    page.wait_for_load_state("networkidle")
    time.sleep(1)

    check("no page errors on load", not errs, "; ".join(errs[:3]))
    check("she reports being with him", page.locator("#state").inner_text().lower() in ("with you", "connecting"),
          page.locator("#state").inner_text())
    check("no hero prose in the room", "running this whole time" not in page.content())
    check("no turn/tool/pid counters on the rail", "pid " not in page.locator(".rail").inner_text().lower(),
          page.locator(".rail").inner_text())
    # The audio-reactive core is gone: it was decoration once the room had
    # real content in it. What stands in its place is a desk the panels are
    # laid out on, which is the thing that has to be true on load.
    check("the desk lays its panels out",
          page.evaluate("[...document.querySelectorAll('.panel')].every(p => p.style.width && p.style.left)"))

    # The composer must be dormant but discoverable, and typing anywhere wakes it.
    check("dock starts dormant", page.evaluate("document.body.dataset.typing") is None)
    page.keyboard.press("h")
    time.sleep(0.2)
    check("typing anywhere focuses the way in", page.evaluate("document.activeElement.id") == "text")
    page.keyboard.type("ello")
    time.sleep(0.2)
    check("dock wakes when there is something in it", page.evaluate("document.body.dataset.typing") == "on")
    check("send appears only with text", page.locator("#send").evaluate("el => getComputedStyle(el).opacity") == "1")
    page.fill("#text", "")
    page.keyboard.press("Escape")
    time.sleep(0.3)
    check("dock goes dormant again", page.evaluate("document.body.dataset.typing") is None)

    for name, (w, h) in SIZES.items():
        page.set_viewport_size({"width": w, "height": h})
        time.sleep(0.6)
        page.screenshot(path=str(here / f"room-idle-{name}.png"))
        body_scroll = page.evaluate("document.body.scrollWidth > window.innerWidth + 1")
        check(f"{name}: the room does not scroll sideways", not body_scroll)

    page.set_viewport_size({"width": 1440, "height": 900})
    time.sleep(0.4)
    print("RESULT:", "OK" if not failures else f"{len(failures)} FAILED")
    browser.close()

sys.exit(1 if failures else 0)
