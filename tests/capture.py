"""Headless screenshot harness for the Zion HUD.

Chrome's `--screenshot` flag never fires here: the viewer runs a perpetual
`requestAnimationFrame` loop, so `--virtual-time-budget` never runs out and the
process hangs. This drives Chrome over the DevTools Protocol instead, which
lets the page settle on wall-clock time and can run a snippet in the page
before capturing (the inspector is opened by a click, not by a URL parameter).

    python3 tests/capture.py --url http://127.0.0.1:8791/ --out /tmp/shot.png

Not part of the shipped viewer: it is a developer tool for looking at the HUD.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket  # websocket-client

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]

# Opens the inspector on a real building, so the capture shows the panel a
# click would produce rather than an empty one.
OPEN_INSPECTOR = """
(() => {
  const z = window.zion;
  if (!z) return 'no window.zion';
  const pools = [
    z.context.resident,
    (z.state.source.manifest.buildings || []),
  ];
  // A district is a folder and inspects just as a building does.
  if (window.__zionForceDistrict) {
    const d = z.state.source.manifest.districts[0];
    z.context.inspector.showDistrict(d);
    return 'district:' + d.key;
  }
  let chosen = null;
  for (const pool of pools) {
    for (const b of pool || []) {
      if (b && b.source && b.floors > 0 && b.language && b.commits !== undefined) {
        chosen = b;
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) return 'no building with source';
  z.context.inspector.showBuilding(chosen);
  return 'inspector:' + (chosen.path || chosen.name || '?');
})()
"""


def find_chrome() -> str:
    for candidate in CHROME_CANDIDATES:
        if candidate and os.path.exists(candidate):
            return candidate
    raise SystemExit("no Chrome/Chromium binary found")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def waiting_for_devtools(port: int, deadline: float) -> str:
    """The JSON version endpoint is the readiness signal; the TCP port opens first."""
    url = f"http://127.0.0.1:{port}/json/version"
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                return json.load(response)["webSocketDebuggerUrl"]
        except Exception as error:  # noqa: BLE001 - polling a booting process
            last = error
            time.sleep(0.1)
    raise SystemExit(f"DevTools never came up on {port}: {last}")


class Session:
    """A single page target driven over the DevTools Protocol."""

    def __init__(self, ws_url: str):
        # Chrome rejects the default Origin header unless it is allow-listed.
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.next_id = 0

    def call(self, method: str, **params):
        self.next_id += 1
        message_id = self.next_id
        self.ws.send(json.dumps({"id": message_id, "method": method, "params": params}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            # Events interleave with replies; the capture only reads replies.

    def evaluate(self, expression: str):
        result = self.call(
            "Runtime.evaluate",
            expression=expression,
            awaitPromise=True,
            returnByValue=True,
        )
        return result.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass


def wait_until_ready(session: Session, timeout: float) -> None:
    """Wait for the city to finish loading and the overlay to clear."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = session.evaluate(
            "(() => {"
            "  const boot = document.getElementById('boot-error');"
            "  if (boot) return 'error:' + boot.textContent;"
            "  const loading = document.getElementById('loading');"
            "  return (loading && loading.classList.contains('done')) ? 'ready' : 'loading';"
            "})()"
        )
        if isinstance(state, str) and state.startswith("error:"):
            raise SystemExit(f"viewer failed to boot -- {state}")
        if state == "ready":
            return
        time.sleep(0.25)
    raise SystemExit("timed out waiting for the viewer to load")


def capture(args) -> None:
    chrome = find_chrome()
    port = free_port()
    profile = tempfile.mkdtemp(prefix="zion-capture-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--hide-scrollbars",
            "--enable-unsafe-swiftshader",
            "--remote-allow-origins=*",
            f"--window-size={args.width},{args.height}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = waiting_for_devtools(port, time.time() + 30)
        root = Session(ws_url)
        target = root.call("Target.createTarget", url="about:blank")
        target_session = Session(
            f"ws://127.0.0.1:{port}/devtools/page/{target['targetId']}"
        )
        target_session.call("Page.enable")
        target_session.call(
            "Emulation.setDeviceMetricsOverride",
            width=args.width,
            height=args.height,
            deviceScaleFactor=args.scale,
            mobile=False,
        )
        target_session.call("Page.navigate", url=args.url)
        wait_until_ready(target_session, args.timeout)

        # Let the first animated frames paint: a capture taken the instant the
        # loader clears catches an unpainted canvas.
        time.sleep(args.settle)

        if args.js:
            if args.district:
                target_session.evaluate("window.__zionForceDistrict = true")
            outcome = target_session.evaluate(OPEN_INSPECTOR)
            print(f"inspector: {outcome}", file=sys.stderr)
            time.sleep(0.6)

        if args.rotate is not None:
            target_session.evaluate(
                "(() => { const z = window.zion;"
                f"  z.context.fly.yaw = {args.rotate};"
                "   z.context.fly.pitch = -0.12;"
                "   z.context.fly.apply();"
                "   return 'rotated'; })()"
            )
            time.sleep(0.5)

        if args.night:
            target_session.evaluate(
                "(() => { const z = window.zion;"
                "   const el = document.getElementById('time');"
                "   el.value = '21';"
                "   el.dispatchEvent(new Event('input'));"
                "   return 'night'; })()"
            )
            time.sleep(1.5)

        shot = target_session.call("Page.captureScreenshot", format="png")
        with open(args.out, "wb") as handle:
            handle.write(base64.b64decode(shot["data"]))
        print(f"wrote {args.out}")
        target_session.close()
        root.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--settle", type=float, default=2.0)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--district", action="store_true",
                        help="inspect the first district instead of a building")
    parser.add_argument("--rotate", type=float, default=None,
                        help="fly yaw in radians before capturing")
    parser.add_argument("--night", action="store_true",
                        help="drive the clock to 21:00 before capturing")
    parser.add_argument(
        "--js",
        action="store_true",
        help="open the inspector on a building before capturing",
    )
    args = parser.parse_args(argv)
    capture(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
