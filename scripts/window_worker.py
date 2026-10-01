"""Window worker: her hub in a window of her own, loaded and waiting.

Her hub used to open as a Chrome tab each time she was called, and closed again
when he let her go. With Chrome already running that is ~150ms; with no Chrome
window open it is a browser starting from nothing, with his profile, his
extensions and his restored tabs, in the same seconds Kokoro and whisper are
loading — the slowest thing between her name and her face. And it tied her to
Chrome: closing his browser closed her.

This is the other way round. One window, made at boot, holding the hub loaded
and connected, hidden until he calls her. Showing a window that already exists
costs nothing he can see. Chrome is then only for Chrome things: links she
opens leave this window for his default browser.

The window is WebView2 — the same engine as Edge, installed with Windows 11 —
driven by pywebview. Everything she draws is still HTML, SVG and canvas,
because that is the fastest drawing surface there is and the one her pages
are written in.

Arguments: url title width height storage_dir
Protocol, one line in, one line out:
    in : show | hide | quit
    out: ready              (the window exists; the page may still be loading)
         loaded             (the page finished loading)
         shown | hidden     (done; "hidden" also when he closed it himself)
         err <message>

stdout is the protocol channel; anything else must go to stderr.
"""
import ctypes
import sys

try:
    import webview
except Exception as exc:  # noqa: BLE001 - say what is missing, don't hang
    print(f"err {exc}", flush=True)
    sys.exit(1)

url = sys.argv[1]
title = sys.argv[2] if len(sys.argv) > 2 else "Vela"
width = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
height = int(sys.argv[4]) if len(sys.argv) > 4 else 820
storage = sys.argv[5] if len(sys.argv) > 5 else None

quitting = False


def say(line):
    print(line, flush=True)


window = webview.create_window(
    title,
    url,
    width=width,
    height=height,
    min_size=(640, 420),
    hidden=True,
    # Her own background, so the first frame is not a white flash.
    background_color="#05090d",
    text_select=True,
)


def on_closing():
    # The close button hides her rather than ending her. Ended, the next call
    # would start a window from nothing, which is the wait this exists to
    # remove; and she is still running, so a closed window would be a lie.
    if quitting:
        return True
    window.hide()
    say("hidden")
    return False


window.events.closing += on_closing
window.events.loaded += lambda: say("loaded")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x1, 0x2, 0x40
SW_RESTORE = 9


def to_front():
    """In front of whatever he is looking at, and given the keyboard if Windows allows.

    Windows does not let a background process take the foreground, which is
    right in general and wrong here: he called her. Two moves. Topmost and back
    puts the window over everything else whether or not focus follows. Then
    borrowing the input queue of the window that has focus makes the
    foreground request come from a thread Windows will take it from.
    """
    hwnd = window.native.Handle.ToInt64()
    user32.ShowWindow(hwnd, SW_RESTORE)
    flags = SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags)
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags)
    front = user32.GetForegroundWindow()
    theirs = user32.GetWindowThreadProcessId(front, None)
    ours = user32.GetWindowThreadProcessId(hwnd, None)
    attached = theirs and theirs != ours and user32.AttachThreadInput(theirs, ours, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(theirs, ours, False)


def commands():
    global quitting
    say("ready")
    for line in sys.stdin:
        command = line.strip()
        if not command:
            continue
        try:
            if command == "show":
                window.show()
                to_front()
                say("shown")
            elif command == "hide":
                window.hide()
                say("hidden")
            elif command == "quit":
                break
            else:
                say(f"err unknown command: {command}")
        except Exception as exc:  # noqa: BLE001 - one bad call must not end her window
            say(f"err {exc}")
    # stdin closing means the service went away. A window left behind by a
    # dead service would be a face with nobody behind it.
    quitting = True
    window.destroy()


# Not private: the hub keeps his desk layout and pinned panels in localStorage,
# and the microphone permission he grants once should stay granted.
webview.start(commands, gui="edgechromium", private_mode=False, storage_path=storage)
