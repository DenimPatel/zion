"""Headless City Hall close-up for the Zion viewer.

`tests/capture.py` frames the HUD; this frames the landmark. The hall is the one
building that is not a file -- its position and scale come from
`manifest.cityHall` -- so the camera is placed on an orbit around that centre
rather than flown there by hand. It drives Chrome over the DevTools Protocol,
waits on wall-clock time, and captures once the page has settled.

    python3 tests/capture_hall.py --url http://127.0.0.1:8791/ --out /tmp/hall.png

`--dist` and `--eye` are in multiples of the hall's own scale and `--angle`
orbits it, so the same flags frame the hall the same way whether the plan is
80 m or 8 km across. Dead ahead of the portico is `--angle -1.5708`.

Not part of the shipped viewer: it is a developer tool for looking at the
landmark.
"""

from __future__ import annotations

import argparse
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture  # noqa: E402

# The fly camera is placed on a circle around the hall's centre, and yaw and
# pitch are derived from the look-at exactly as `FlyCamera.setFromManifest`
# does. Everything is in hall-scale units, so the same numbers travel.
PLACEMENT = """
(() => {
  const z = window.zion;
  const hall = z.state.source.manifest.cityHall;
  if (!hall) return 'no city hall in this manifest';
  const cx = hall.centre[0];
  const cz = hall.centre[1];
  const s = hall.scale || 1;
  const fly = z.context.fly;
  fly.position.set(
    cx + Math.cos(__ANGLE__) * __DIST__ * s,
    __EYE__ * s,
    cz + Math.sin(__ANGLE__) * __DIST__ * s
  );
  const dx = cx - fly.position.x;
  const dy = __LOOK_Y__ * s - fly.position.y;
  const dz = cz - fly.position.z;
  fly.yaw = Math.atan2(-dx, -dz);
  fly.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  fly.apply();
  return { centre: [cx, cz], scale: s };
})()
"""


def shoot(args) -> None:
    chrome = capture.find_chrome()
    port = capture.free_port()
    profile = tempfile.mkdtemp(prefix="zion-hall-")
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
        ws_url = capture.waiting_for_devtools(port, time.time() + 30)
        root = capture.Session(ws_url)
        target = root.call("Target.createTarget", url="about:blank")
        session = capture.Session(
            f"ws://127.0.0.1:{port}/devtools/page/{target['targetId']}"
        )
        session.call("Page.enable")
        session.call(
            "Emulation.setDeviceMetricsOverride",
            width=args.width,
            height=args.height,
            deviceScaleFactor=args.scale,
            mobile=False,
        )
        session.call("Page.navigate", url=args.url)
        capture.wait_until_ready(session, args.timeout)
        time.sleep(args.settle)

        script = (
            PLACEMENT.replace("__ANGLE__", str(args.angle))
            .replace("__DIST__", str(args.dist))
            .replace("__EYE__", str(args.eye))
            .replace("__LOOK_Y__", str(args.look_y))
        )
        print(f"placed: {session.evaluate(script)}", file=sys.stderr)
        time.sleep(0.6)

        shot = session.call("Page.captureScreenshot", format="png")
        with open(args.out, "wb") as handle:
            handle.write(base64.b64decode(shot["data"]))
        print(f"wrote {args.out}")
        session.close()
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
    parser.add_argument("--width", type=int, default=1400)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--settle", type=float, default=2.0)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--dist", type=float, default=70.0,
                        help="orbit radius, in hall-scale units")
    parser.add_argument("--eye", type=float, default=28.0,
                        help="camera height, in hall-scale units")
    parser.add_argument("--angle", type=float, default=-0.9,
                        help="orbit angle in radians; -1.5708 is dead ahead of the portico")
    parser.add_argument("--look-y", type=float, default=13.0,
                        help="look-at height, in hall-scale units")
    args = parser.parse_args(argv)
    shoot(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
