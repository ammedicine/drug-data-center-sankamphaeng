"""
Headless check of the desktop app's plumbing: paths, agent command resolution,
settings/state files and one real CLI call. Run it when a GUI cannot be opened
(a locked desktop, CI) - it exercises everything except the widgets.

    gui\\.venv\\Scripts\\python.exe gui\\smoke_test.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_app():
    spec = importlib.util.spec_from_file_location("sdc_gui", HERE / "sdc_agent_gui.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # @dataclass looks the module up in sys.modules while the class is built,
    # so it has to be registered before the module body runs.
    sys.modules["sdc_gui"] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    # Windows consoles default to cp874 here, which cannot print Thai output.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    app = load_app()
    bridge = app.AgentBridge()

    print("app dir      :", app.app_dir())
    print("data dir     :", app.data_dir())
    print("tray support :", app.TRAY_AVAILABLE)
    print("agent command:", " ".join(bridge._command(["status"])))

    credential = bridge.credential()
    print(
        "enrolled     :",
        f"{credential.get('facilityCode')} / {credential.get('facilityName')}"
        if credential
        else "ยังไม่ได้ลงทะเบียน",
    )
    print("settings     :", json.dumps(bridge.settings(), ensure_ascii=False))
    print("state        :", json.dumps(bridge.state(), ensure_ascii=False))
    print("status       :", json.dumps(bridge.status(), ensure_ascii=False)[:200])
    print("queue        :", bridge.queue_depth())

    result = bridge.run(["status"], timeout=300)
    print("`agent status` ok:", result.ok)
    for line in result.output.strip().splitlines()[:12]:
        print("   ", line)

    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
