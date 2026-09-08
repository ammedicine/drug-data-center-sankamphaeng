"""
Headless check of the desktop app's plumbing: paths, agent command resolution,
settings and state files, one real CLI call - and every state the screen can
be in.

The window cannot be opened on a build machine or a locked desktop, so the
parts that decide what the screen says live in theme.py as pure functions.
This exercises them against the situations that actually happen at a รพ.สต.:
never enrolled, Central unreachable, JHCIS down, a sync at 0%, half done and
finished, rows rejected, chunks stuck in the queue, and an error message far
too long for its label.

    gui\\.venv\\Scripts\\python.exe gui\\smoke_test.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
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


def check(theme) -> list[str]:
    """Returns a list of failures; empty means every scenario mapped correctly."""
    failures: list[str] = []
    now = datetime.now(timezone.utc)
    fresh = (now - timedelta(seconds=5)).isoformat()
    stale = (now - timedelta(seconds=600)).isoformat()
    enrolled = {"facilityCode": "RPST-05957", "facilityName": "รพ.สต.ทดสอบ", "expectedPcucode": "05957"}

    def expect(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)

    # --- never enrolled -----------------------------------------------------
    items = {i.key: i for i in theme.system_status({}, {}, False, None, now)}
    expect(items["central"].tone == "muted", "not enrolled: Central should be muted, not an error")
    expect("ลงทะเบียน" in items["central"].text, "not enrolled: should say so plainly")
    expect(items["jhcis"].tone == "muted", "not enrolled: JHCIS is unknown, not broken")
    expect(items["worker"].tone == "danger", "worker stopped should be red")

    # --- Central unreachable, JHCIS fine ------------------------------------
    status = {
        "centralState": "NETWORK_ERROR",
        "centralAckAt": stale,
        "jhcisState": "CONNECTED",
        "jhcisCheckedAt": fresh,
    }
    items = {i.key: i for i in theme.system_status(status, enrolled, True, None, now)}
    expect(items["central"].tone == "danger", "Central down should be red")
    expect(items["jhcis"].tone == "ok", "JHCIS must stay green while Central is down")

    # --- credential revoked -------------------------------------------------
    status = {"centralState": "AUTH_ERROR", "centralAckAt": stale}
    item = theme.central_status(status, enrolled, now)
    expect(item.tone == "danger", "revoked credential should be red")
    expect("ลงทะเบียนใหม่" in item.detail, "revoked credential should say what to do about it")

    # --- said connected, but long ago ---------------------------------------
    status = {"centralState": "CONNECTED", "centralAckAt": stale}
    item = theme.central_status(status, enrolled, now)
    expect(item.tone == "warn", "an old acknowledgement must read as stale, not connected")

    # --- JHCIS switched off -------------------------------------------------
    item = theme.jhcis_status({"jhcisState": "UNREACHABLE", "jhcisCheckedAt": fresh}, now)
    expect(item.tone == "danger", "JHCIS unreachable should be red")

    # --- idle ---------------------------------------------------------------
    view = theme.sync_view({}, now)
    expect(view.progress == 0.0, "idle progress should be 0")
    expect(not view.active, "idle must not disable the action buttons")
    expect(view.range_text != "", "idle still needs something in the range line")

    # --- a run at 0%, 50% and 100% -----------------------------------------
    base = {
        "syncPhase": "UPLOADING",
        "rangeFrom": "2026-09-01",
        "rangeTo": "2026-09-06",
        "recordsExpected": 12482,
        "syncStartedAt": (now - timedelta(minutes=3)).isoformat(),
    }
    view = theme.sync_view({**base, "recordsExtracted": 500}, now)
    expect(view.progress == 0.0, "nothing accepted yet means 0%")
    expect(view.active, "a running sync must disable actions")
    expect(view.busy_reason != "", "a disabled action needs a reason on screen")

    view = theme.sync_view({**base, "recordsExtracted": 8500, "recordsAccepted": 6241}, now)
    expect(abs(view.progress - 0.5) < 0.01, f"half delivered should be 50%, got {view.progress}")
    expect(view.percent_text == "50%", f"percent text should be 50%, got {view.percent_text}")
    expect("8,500" in view.counters[0][1], "counters should be grouped with commas")
    expect("12,482" in view.counters[0][1], "counters should show the total read from JHCIS")

    view = theme.sync_view(
        {**base, "syncPhase": "SUCCESS", "recordsExtracted": 12482, "recordsAccepted": 12482}, now
    )
    expect(view.progress == 1.0, "everything delivered should be 100%")
    expect(not view.active, "a finished run must re-enable the actions")

    # Reading always runs ahead of uploading; progress must follow what the
    # centre confirmed, or the bar hits 100% while data is still in flight.
    view = theme.sync_view({**base, "recordsExtracted": 12482, "recordsAccepted": 2000}, now)
    expect(view.progress < 0.2, "progress must track accepted rows, not rows read")

    # --- rejected rows and a stuck queue ------------------------------------
    view = theme.sync_view(
        {
            **base,
            "recordsExtracted": 12482,
            "recordsUploaded": 12482,
            "recordsAccepted": 12480,
            "recordsRejected": 2,
            "pendingChunks": 1,
        },
        now,
    )
    labels = dict(view.counters)
    expect(labels["ปฏิเสธ"] == "2", "rejected rows must be shown, not folded into accepted")
    expect(labels["ศูนย์กลางรับแล้ว"] == "12,480", "accepted must exclude rejected")
    expect("1" in labels["คิวรอส่ง"], "a stuck queue must be visible")

    # --- a very long error --------------------------------------------------
    long_error = "connect ETIMEDOUT 192.168.1.10:3306 " * 12
    view = theme.sync_view({"syncPhase": "ERROR", "lastError": long_error}, now)
    expect(view.tone == "danger", "an error should be red")
    expect(long_error[:40] in view.headline, "the error text should survive into the headline")
    expect(not view.active, "a failed run must not leave the buttons disabled")

    # --- next scheduled run -------------------------------------------------
    text = theme.next_sync_text({"syncIntervalMinutes": 60}, {"lastSyncAt": fresh}, now)
    expect("น." in text, f"next run should be a clock time, got {text}")
    expect(
        theme.next_sync_text({"syncIntervalMinutes": 0, "dailyTimes": []}, {}, now)
        == "ไม่ได้ตั้งเวลาไว้",
        "no schedule should say so rather than showing a time",
    )
    daily = theme.next_sync_text({"syncIntervalMinutes": 0, "dailyTimes": ["08:00"]}, {}, now)
    expect("08:00" in daily, f"a daily time should be reported, got {daily}")

    # The scheduler staggers a nominal 08:00 to 08:00:27 so the district does
    # not arrive in one second. The screen must report the moment the agent
    # will actually run, not recompute the setting it was derived from.
    staggered = now.astimezone().replace(hour=8, minute=0, second=27, microsecond=0) + timedelta(
        days=1
    )
    published = theme.next_sync_text(
        {"syncIntervalMinutes": 0, "dailyTimes": ["08:00"]},
        {},
        now,
        status={"nextSyncAt": staggered.isoformat()},
    )
    expect("08:00:27" in published, f"nextSyncAt should win over the setting, got {published}")

    # An agent old enough not to publish the field must still say something.
    for stale_status in ({}, {"nextSyncAt": None}, {"nextSyncAt": "ไม่ใช่เวลา"}):
        legacy = theme.next_sync_text(
            {"syncIntervalMinutes": 60}, {"lastSyncAt": fresh}, now, status=stale_status
        )
        expect("น." in legacy, f"missing nextSyncAt should fall back, got {legacy}")

    # A published time that has already passed is not a future promise.
    passed = theme.next_sync_text(
        {"syncIntervalMinutes": 60},
        {"lastSyncAt": fresh},
        now,
        status={"nextSyncAt": (now - timedelta(minutes=5)).isoformat()},
    )
    expect(passed == "ถึงกำหนดแล้ว", f"a past nextSyncAt should say so, got {passed}")

    # --- Thai time on screen, UTC on disk -----------------------------------
    # The agent writes UTC and the screen reads Thai time. Everything below is
    # a moment; the two cases after it are not, and must survive untouched.
    expect(
        theme.thai_datetime("2026-09-08T06:00:00Z") == "08/09/2026 13:00:00",
        f"UTC should read as Thai time, got {theme.thai_datetime('2026-09-08T06:00:00Z')}",
    )
    # Crossing midnight: 18:30 UTC is the next day here.
    expect(
        theme.thai_datetime("2026-09-08T18:30:00Z") == "09/09/2026 01:30:00",
        f"evening UTC should roll to the next Thai day, got {theme.thai_datetime('2026-09-08T18:30:00Z')}",
    )
    # Already Thai: adding seven hours again would read 06:59:59 tomorrow.
    expect(
        theme.thai_datetime("2026-09-08T23:59:59+07:00") == "08/09/2026 23:59:59",
        f"an offset already in the value must be respected, got {theme.thai_datetime('2026-09-08T23:59:59+07:00')}",
    )
    expect(
        theme.thai_datetime("2026-09-08T06:00:00.123456Z") == "08/09/2026 13:00:00",
        "fractional seconds should not break the format",
    )
    expect(theme.thai_datetime(None) == "-", "a missing time shows a placeholder")
    expect(theme.thai_datetime("ไม่ใช่เวลา") == "-", "an unreadable time must not crash the window")
    expect(theme.clock("2026-09-08T06:35:30Z") == "13:35:30", "log times read in Thai time")

    # An instant is one instant however it is written: the age behind
    # "connected 5 seconds ago" must not move when the display zone does.
    utc_now = datetime(2026, 9, 8, 6, 0, 0, tzinfo=timezone.utc)
    expect(
        theme.age_seconds("2026-09-08T05:59:30Z", utc_now)
        == theme.age_seconds("2026-09-08T12:59:30+07:00", utc_now),
        "the same moment written two ways must give the same age",
    )

    # Service dates are days, not moments. 2026-08-08 is that day in the
    # hospital's records and must never shift to the 7th or the 9th.
    view = theme.sync_view({"rangeFrom": "2026-08-08", "rangeTo": "2026-08-08"}, now)
    expect("2026-08-08 ถึง 2026-08-08" in view.range_text, f"date range shifted: {view.range_text}")

    # A time the operator typed is a wall-clock time: 08:15 stays 08:15.
    daily_thai = theme.next_sync_text({"syncIntervalMinutes": 0, "dailyTimes": ["08:15"]}, {}, now)
    expect("08:15" in daily_thai, f"a daily time must not be shifted, got {daily_thai}")

    # --- the worker watchdog ------------------------------------------------
    # A worker can be alive and doing nothing, which looks identical from
    # outside to a healthy one. These are the cases that decide whether the
    # tray restarts the child it started.
    fresh_tick = (now - timedelta(seconds=20)).isoformat()
    dead_tick = (now - timedelta(seconds=600)).isoformat()
    base = dict(now=now, first_seen=now - timedelta(hours=1), last_checked=now - timedelta(seconds=2),
                last_restart=None, restarts=0)

    # CASE 9: a healthy worker is never restarted.
    restart, why = theme.watchdog_decision(child_running=True, last_tick=fresh_tick, **base)
    expect(not restart, f"healthy worker must be left alone, got {why}")

    # CASE 10: alive but its rounds stopped - this is the failure being caught.
    restart, why = theme.watchdog_decision(child_running=True, last_tick=dead_tick, **base)
    expect(restart, "a worker that stopped ticking should be restarted")
    expect("ไม่ตอบสนอง" in why, f"the reason should say what happened, got {why}")

    # CASE 11: a dead child is the start path's job, not the watchdog's.
    restart, _ = theme.watchdog_decision(child_running=False, last_tick=dead_tick, **base)
    expect(not restart, "a process that already exited is not the watchdog's to restart")

    # CASE 14: waking from sleep looks exactly like a stall. It is not.
    restart, why = theme.watchdog_decision(
        child_running=True, last_tick=dead_tick, now=now,
        first_seen=now - timedelta(hours=1), last_checked=now - timedelta(minutes=30),
        last_restart=None, restarts=0,
    )
    expect(not restart, f"a clock jump must not trigger a restart, got {why}")

    # CASE 13: restarts are rate bounded, twice over.
    restart, _ = theme.watchdog_decision(
        child_running=True, last_tick=dead_tick, now=now,
        first_seen=now - timedelta(hours=1), last_checked=now - timedelta(seconds=2),
        last_restart=now - timedelta(seconds=30), restarts=1,
    )
    expect(not restart, "a restart moments ago should be given time to take effect")
    restart, _ = theme.watchdog_decision(
        child_running=True, last_tick=dead_tick, now=now,
        first_seen=now - timedelta(hours=1), last_checked=now - timedelta(seconds=2),
        last_restart=now - timedelta(hours=1), restarts=theme.WATCHDOG_MAX_RESTARTS,
    )
    expect(not restart, "restarting forever helps nobody")

    # A worker with no stamp at all - just started, or an older version - gets
    # room rather than a restart.
    restart, _ = theme.watchdog_decision(
        child_running=True, last_tick=None, now=now, first_seen=now - timedelta(seconds=30),
        last_checked=now - timedelta(seconds=2), last_restart=None, restarts=0,
    )
    expect(not restart, "a worker that has only just started must not be restarted")
    restart, _ = theme.watchdog_decision(
        child_running=True, last_tick=None, now=now, first_seen=now - timedelta(minutes=30),
        last_checked=now - timedelta(seconds=2), last_restart=None, restarts=0,
    )
    expect(restart, "a worker that never reports a tick is not doing its rounds")

    # The threshold has to be well clear of the heartbeat, or an ordinary slow
    # moment becomes a restart.
    expect(
        theme.WATCHDOG_STALE_SECONDS >= theme.STALE_AFTER_SECONDS,
        "the watchdog must be slower to act than the web is to call an agent offline",
    )

    # --- tokens are a system, not a pile of numbers -------------------------
    expect(sorted(theme.SPACE.values()) == [4, 8, 12, 16, 24, 32], "spacing scale changed")
    expect(theme.WINDOW_MIN[0] <= theme.WINDOW_DEFAULT[0], "default window smaller than minimum")
    expect(theme.WINDOW_MIN == (960, 700), "minimum window size changed")
    expect(set(theme.TONE_COLOURS) == {"ok", "warn", "danger", "muted"}, "tone set changed")

    return failures


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

    # The screen and the agent must land in one folder. An agent upgraded from
    # an old release can still have {app}\.env saying AGENT_DATA_DIR=./data,
    # which the agent would resolve against cwd={app}; passing the resolved
    # folder to the child settles it before dotenv ever reads that file.
    child_env = bridge._environment()
    same = child_env.get("AGENT_DATA_DIR") == str(app.data_dir())
    print("child env    :", child_env.get("AGENT_DATA_DIR"), "· ตรงกับหน้าจอ:", same)
    if not same:
        print("   ! หน้าจอกับ agent จะใช้คนละโฟลเดอร์")
        return 1
    # Only that one variable is decided here; everything else the machine set
    # is passed through, so a custom PATH or proxy still reaches the agent.
    leaked = [key for key in os.environ if key not in child_env]
    if leaked:
        print("   ! ตัวแปรสภาพแวดล้อมหายไป:", leaked)
        return 1

    # The JHCIS target has to be readable and writable from the tray: a รพ.สต.
    # that moves its server, or an agent pointed at another LAN, is changed
    # from this screen and nowhere else.
    jhcis = bridge.jhcis_settings()
    print("jhcis        :", json.dumps(jhcis, ensure_ascii=False) or "อ่านไม่ได้")
    if jhcis:
        # Rewrites the same values, which also proves the file is writable and
        # that leaving the password out keeps the stored one.
        echo = bridge.save_jhcis(
            {
                "host": jhcis["host"],
                "port": jhcis["port"],
                "database": jhcis["database"],
                "user": jhcis["user"],
            }
        )
        after = bridge.jhcis_settings()
        kept = after.get("hasPassword") == jhcis.get("hasPassword")
        print("jhcis save   :", echo.ok, "· รหัสผ่านเดิมยังอยู่:", kept)
        if not (echo.ok and kept):
            return 1

    # The version has to reach the screen, and it comes from the agent rather
    # than a constant in the GUI so the two cannot drift apart.
    version = bridge.agent_version()
    print("version      :", version or "อ่านไม่ได้")
    if not version:
        return 1

    # theme.py has to repeat STALE_AFTER_SECONDS because Python cannot import
    # the TypeScript the rest of the system reads it from. A comment saying
    # "must match" is not a check, so this is: the two disagreeing would have
    # the tray and the website calling the same agent by different names.
    shared = (HERE / ".." / ".." / "src" / "lib" / "shared" / "agent-status.ts").resolve()
    declared = re.search(
        r"STALE_AFTER_SECONDS\s*=\s*(\d+)", shared.read_text(encoding="utf-8")
    )
    print(
        "stale seconds:",
        f"{app.theme.STALE_AFTER_SECONDS} (agent-status.ts: {declared.group(1) if declared else '?'})",
    )
    if not declared or int(declared.group(1)) != app.theme.STALE_AFTER_SECONDS:
        print("   ! theme.py ไม่ตรงกับ src/lib/shared/agent-status.ts")
        return 1

    # The address the operator types has to reach the agent. It used to be
    # written into {app}\.env, which a staff account cannot write, so the error
    # was swallowed and enrolment quietly used the old address instead.
    args = bridge.enroll_command("synthetic-token", "https://example.test")
    expected = ["enroll", "--token", "synthetic-token", "--url", "https://example.test"]
    # Printed as a shape, not a value: a real token must never reach a log.
    print("enroll args  :", ["<token>" if a == "synthetic-token" else a for a in args])
    if args != expected:
        print("   ! enroll ไม่ได้ส่ง --url ที่ผู้ใช้กรอก")
        return 1
    # No address means nothing to enrol against, so no --url is invented.
    if bridge.enroll_command("synthetic-token", "") != ["enroll", "--token", "synthetic-token"]:
        print("   ! ที่อยู่ว่างไม่ควรสร้าง --url")
        return 1

    # Every state the window can be in, checked without opening one.
    failures = check(app.theme)
    print("สถานะหน้าจอที่ตรวจ :", "ผ่านทั้งหมด" if not failures else f"ไม่ผ่าน {len(failures)} ข้อ")
    for failure in failures:
        print("   !", failure)
    if failures:
        return 1

    result = bridge.run(["status"], timeout=300)
    print("`agent status` ok:", result.ok)
    for line in result.output.strip().splitlines()[:12]:
        print("   ", line)

    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
