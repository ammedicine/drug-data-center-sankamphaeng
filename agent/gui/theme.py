"""
Design tokens and the status-to-screen mapping for the Agent window.

Two things live here, and they are together on purpose.

The tokens answer the widgets that were each sized by hand: one spacing scale,
one type scale, one palette. Nothing in the window should invent a padding of
13 or a font size of 14.5.

The mapping functions turn the Agent's status.json into exactly what the screen
shows - label, tone, detail line, progress, counters. They are pure: dict in,
dataclass out, no widgets, and no clock beyond the `now` handed to them. That
is what lets smoke_test.py check every awkward state - not enrolled, Central
down, JHCIS down, a half-finished sync, rejected rows, a long error - on a
machine with no desktop at all, which is where this program is usually built.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

# --------------------------------------------------------------------- spacing

#: One scale, used everywhere. Anything not on it is a mistake.
SPACE = {"xs": 4, "sm": 8, "md": 12, "lg": 16, "xl": 24, "xxl": 32}

RADIUS = {"sm": 6, "md": 10, "lg": 14}

# ------------------------------------------------------------------ type scale

#: Sizes only. Weights are chosen at the call site because CustomTkinter builds
#: fonts lazily and a shared CTkFont cannot exist before the root window does.
TYPE = {
    "display": 20,  # window title in the header
    "title": 16,  # page heading
    "section": 13,  # card heading
    "body": 12,
    "caption": 11,
    "metric": 22,  # the large numbers on the overview
}

# ---------------------------------------------------------------------- colour

BRAND = "#0b8377"
BRAND_HOVER = "#0a6a61"
BRAND_SOFT = "#e6f5f3"

INK = "#17252f"
INK_SOFT = "#3d4f5c"
MUTED = "#5b6b7c"

SURFACE = "#ffffff"
CANVAS = "#f4f7f9"
SIDEBAR = "#12313a"
SIDEBAR_ACTIVE = "#1b4a56"
SIDEBAR_TEXT = "#cfe3e6"
LINE = "#e3e8ee"

OK = "#157f4b"
WARN = "#97650a"
DANGER = "#b3261e"

#: The four tones a status can take: green healthy, amber stale or retrying,
#: red broken, grey unknown or not configured.
TONE_COLOURS = {"ok": OK, "warn": WARN, "danger": DANGER, "muted": MUTED}

# ------------------------------------------------------------------ dimensions

WINDOW_DEFAULT = (1100, 720)
#: Chosen from the layout rather than picked out of the air: the overview needs
#: 626px below the 64px header, so anything shorter than this would clip the
#: page that is supposed to be readable at a glance.
WINDOW_MIN = (960, 700)
SIDEBAR_WIDTH = 208
NAV_ITEM_HEIGHT = 40
BUTTON_HEIGHT = 38
INPUT_WIDTH = 320
LABEL_WIDTH = 150

#: Must match STALE_AFTER_SECONDS in src/lib/shared/agent-status.ts. A link
#: whose last acknowledgement is older than this is shown as stale, never as
#: connected - the same rule the server applies, so the two screens agree.
STALE_AFTER_SECONDS = 90

# ------------------------------------------------------------------- watchdog

#: How long the worker may go without stamping a tick before the tray restarts
#: it. Several times the 30-second heartbeat, so an ordinary slow moment - a
#: long extraction page, a busy PC - is never mistaken for a stall.
WATCHDOG_STALE_SECONDS = 180

#: Room for a worker that has only just started, or one from a version that
#: does not stamp ticks at all. Restarting either would be wrong.
WATCHDOG_GRACE_SECONDS = 240

#: A gap this large between two checks means the machine was asleep, not that
#: the worker stopped. The wall clock jumped; nothing was wrong.
WATCHDOG_SLEEP_JUMP_SECONDS = 120

#: Quiet period after a restart, so a worker that fails on startup is not
#: restarted every two seconds.
WATCHDOG_COOLDOWN_SECONDS = 300

#: After this many inside the window below, restarting is plainly not the
#: answer and the operator is better served by the message on screen.
WATCHDOG_MAX_RESTARTS = 5

#: The allowance is per half hour, not per lifetime. Five restarts in thirty
#: minutes is a problem restarting will not solve; five over a week is a
#: machine that recovered five times, and refusing the sixth would strand it.
WATCHDOG_RESTART_WINDOW_SECONDS = 1800


def watchdog_decision(
    *,
    child_running: bool,
    should_run: bool,
    last_tick: Any,
    now: datetime,
    first_seen: datetime | None,
    last_checked: datetime | None,
    restarts: list[datetime],
) -> tuple[bool, str]:
    """
    Whether the tray should restart the worker it started, and why.

    Two states need recovering and they used to be treated as one. A worker
    that is alive but has stopped doing its rounds was handled; a worker that
    exited was not - the answer was "the start path will deal with it", and no
    start path runs while the tray is simply sitting there. A รพ.สต. stayed
    offline until somebody thought to close and reopen the program.

    `should_run` is what stops recovery fighting intent: a tray that is closing,
    an installer stopping the worker to replace it, or an operator who turned
    syncing off must not have a worker handed back to them.

    `restarts` is the times of recent restarts, not a lifetime count. Five
    attempts in half an hour means something a restart cannot fix; five over a
    week is a machine that recovered five times, and refusing the sixth would
    strand it.

    Pure, so every awkward case can be checked without a window or a real
    stalled process. Returns (restart?, reason) - the reason is for the
    operator, because a restart should never be something that just silently
    happened.
    """
    if not should_run:
        return False, "ไม่ได้ตั้งให้ทำงานอยู่"

    # A gap between checks this large means the machine was asleep. The wall
    # clock jumped; nothing stalled. Wait for an ordinary round before judging.
    if last_checked is not None and (now - last_checked).total_seconds() > WATCHDOG_SLEEP_JUMP_SECONDS:
        return False, "เครื่องเพิ่งกลับจากสถานะพัก"

    recent = [t for t in restarts if (now - t).total_seconds() <= WATCHDOG_RESTART_WINDOW_SECONDS]
    if recent:
        newest = max(recent)
        if (now - newest).total_seconds() < WATCHDOG_COOLDOWN_SECONDS:
            return False, "เพิ่งเริ่มใหม่ไป รอสักครู่"
    if len(recent) >= WATCHDOG_MAX_RESTARTS:
        return False, "เริ่มใหม่หลายครั้งแล้วยังไม่ดีขึ้น"

    if not child_running:
        # It exited. Nothing else is watching for that, and the machine is
        # offline until something starts it again.
        return True, "ตัวทำงานเบื้องหลังหยุดไปเอง"

    stamp = parse_iso(last_tick)
    if stamp is None:
        # No stamp at all: either brand new, or an older worker that never
        # reports one. Both deserve room rather than a restart.
        started = first_seen or now
        if (now - started).total_seconds() < WATCHDOG_GRACE_SECONDS:
            return False, "เพิ่งเริ่มทำงาน"
        return True, "ตัวทำงานเบื้องหลังไม่รายงานจังหวะการทำงาน"

    age = (now - stamp).total_seconds()
    if age < WATCHDOG_STALE_SECONDS:
        return False, "ทำงานปกติ"
    return True, f"ตัวทำงานเบื้องหลังไม่ตอบสนอง ({int(age)} วินาที)"


# ----------------------------------------------------------------- view models


@dataclass
class StatusItem:
    """One of the three system status cards."""

    key: str
    label: str
    tone: str  # ok | warn | danger | muted
    text: str
    detail: str


@dataclass
class SyncView:
    """Everything the current-sync card shows."""

    headline: str
    tone: str
    range_text: str
    progress: float  # 0..1
    percent_text: str
    counters: list[tuple[str, str]] = field(default_factory=list)
    started_text: str = "-"
    elapsed_text: str = "-"
    #: True while a run is under way, so actions that would start a second one
    #: can be disabled with a reason the operator can read.
    active: bool = False
    busy_reason: str = ""


# ---------------------------------------------------------------- time helpers


#: Every moment shown on this screen is shown in Thai time.
#:
#: Fixed rather than taken from the machine: Thailand has no daylight saving,
#: so +07:00 is always right, and a รพ.สต. PC with its clock set to the wrong
#: region would otherwise put the whole window seven hours out without anything
#: on screen admitting it. What is stored never changes - the agent and the
#: server keep talking in UTC, and this is only how it is read out.
THAI_TZ = timezone(timedelta(hours=7))


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def age_seconds(value: Any, now: datetime) -> float | None:
    parsed = parse_iso(value)
    if parsed is None:
        return None
    return max(0.0, (now - parsed).total_seconds())


def relative(value: Any, now: datetime) -> str:
    """Short and human: never a bare timestamp nobody can read at a glance."""
    seconds = age_seconds(value, now)
    if seconds is None:
        return "ยังไม่เคย"
    if seconds < 10:
        return "เมื่อสักครู่"
    if seconds < 60:
        return f"{int(seconds)} วินาทีที่แล้ว"
    if seconds < 3600:
        return f"{int(seconds // 60)} นาทีที่แล้ว"
    if seconds < 86400:
        return f"{int(seconds // 3600)} ชั่วโมงที่แล้ว"
    return f"{int(seconds // 86400)} วันที่แล้ว"


def clock(value: Any) -> str:
    """Time of day, in Thai time. `-` when there is nothing to show."""
    parsed = parse_iso(value)
    if parsed is None:
        return "-"
    return parsed.astimezone(THAI_TZ).strftime("%H:%M:%S")


def thai_datetime(value: Any) -> str:
    """
    A moment, written the way it is read here: 08/09/2026 13:35:30.

    The one place a timestamp becomes text for the screen. Anything that
    formats a date and time by slicing the ISO string instead - which is how
    the log view and the last-sync line used to do it - shows UTC, and a
    เจ้าหน้าที่ comparing it with the clock in the corner of their screen finds
    the program seven hours behind.
    """
    parsed = parse_iso(value)
    if parsed is None:
        return "-"
    return parsed.astimezone(THAI_TZ).strftime("%d/%m/%Y %H:%M:%S")


def elapsed(value: Any, now: datetime) -> str:
    seconds = age_seconds(value, now)
    if seconds is None:
        return "-"
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours} ชม. {minutes} นาที"
    if minutes:
        return f"{minutes} นาที {secs} วินาที"
    return f"{secs} วินาที"


def number(value: Any) -> str:
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "0"


# --------------------------------------------------------------- state mapping

_CENTRAL_TEXT = {
    "CONNECTED": ("ok", "เชื่อมต่อแล้ว"),
    "NETWORK_ERROR": ("danger", "ติดต่อไม่ได้"),
    "AUTH_ERROR": ("danger", "สิทธิ์ถูกเพิกถอน"),
    "STALE": ("warn", "ไม่ได้ติดต่อมานาน"),
    "UNKNOWN": ("muted", "ยังไม่ทราบ"),
}

_JHCIS_TEXT = {
    "CONNECTED": ("ok", "เชื่อมต่อแล้ว"),
    "UNREACHABLE": ("danger", "ต่อไม่ได้"),
    "UNKNOWN": ("muted", "ยังไม่ทราบ"),
}

_PHASE_TEXT = {
    "IDLE": ("muted", "พร้อมทำงาน"),
    "READING": ("ok", "กำลังอ่านข้อมูลจาก JHCIS"),
    "UPLOADING": ("ok", "กำลังส่งข้อมูลขึ้นศูนย์กลาง"),
    "VERIFYING": ("ok", "กำลังตรวจสอบความครบถ้วน"),
    "SUCCESS": ("ok", "ซิงก์สำเร็จ"),
    "ERROR": ("danger", "ซิงก์ไม่สำเร็จ"),
}

#: Phases during which starting another run would collide with this one.
ACTIVE_PHASES = {"READING", "UPLOADING", "VERIFYING"}


def central_status(
    status: dict[str, Any], credential: dict[str, Any], now: datetime
) -> StatusItem:
    """
    The link to the Central API.

    Enrolment comes first: an agent that has never been given a credential is
    not "disconnected", it is not set up yet, and saying so points at the thing
    to do about it. After that, a connection is reported only while its
    acknowledgement is recent.
    """
    if not credential:
        return StatusItem(
            "central",
            "ศูนย์กลาง",
            "muted",
            "ยังไม่ได้ลงทะเบียน",
            "ใส่รหัสลงทะเบียนที่หน้าการเชื่อมต่อ",
        )

    state = str(status.get("centralState") or "UNKNOWN")
    ack = status.get("centralAckAt")
    seconds = age_seconds(ack, now)

    if state == "CONNECTED" and (seconds is None or seconds > STALE_AFTER_SECONDS):
        # It said connected, but not recently enough to still be believed.
        state = "STALE"

    tone, text = _CENTRAL_TEXT.get(state, _CENTRAL_TEXT["UNKNOWN"])
    detail = f"ยืนยันล่าสุด {relative(ack, now)}" if ack else "ยังไม่เคยติดต่อสำเร็จ"
    if state == "AUTH_ERROR":
        detail = "ต้องลงทะเบียนใหม่กับผู้ดูแลระบบ"
    return StatusItem("central", "ศูนย์กลาง", tone, text, detail)


def jhcis_status(status: dict[str, Any], now: datetime) -> StatusItem:
    state = str(status.get("jhcisState") or "UNKNOWN")
    checked = status.get("jhcisCheckedAt")
    seconds = age_seconds(checked, now)

    if state == "CONNECTED" and (seconds is None or seconds > STALE_AFTER_SECONDS):
        state = "UNKNOWN"

    tone, text = _JHCIS_TEXT.get(state, _JHCIS_TEXT["UNKNOWN"])
    detail = f"ตรวจล่าสุด {relative(checked, now)}" if checked else "ยังไม่เคยตรวจ"
    return StatusItem("jhcis", "JHCIS", tone, text, detail)


def worker_status(running: bool, error: str | None, now: datetime) -> StatusItem:
    if running:
        return StatusItem(
            "worker", "ตัวทำงานเบื้องหลัง", "ok", "กำลังทำงาน", "ซิงก์ตามเวลาที่ตั้งไว้"
        )
    detail = (error or "")[:80] or "เปิดใหม่ได้ที่หน้าตั้งค่า"
    return StatusItem("worker", "ตัวทำงานเบื้องหลัง", "danger", "หยุดอยู่", detail)


def system_status(
    status: dict[str, Any],
    credential: dict[str, Any],
    worker_running: bool,
    worker_error: str | None,
    now: datetime | None = None,
) -> list[StatusItem]:
    """The three cards at the top of the overview, in reading order."""
    moment = now or datetime.now(timezone.utc)
    return [
        jhcis_status(status, moment),
        central_status(status, credential, moment),
        worker_status(worker_running, worker_error, moment),
    ]


def sync_view(status: dict[str, Any], now: datetime | None = None) -> SyncView:
    """
    The current-sync card.

    Progress counts rows the centre has confirmed, not rows read out of JHCIS:
    reading races ahead of uploading, and a bar that reaches 100% while data is
    still being sent teaches people not to trust it.
    """
    moment = now or datetime.now(timezone.utc)
    phase = str(status.get("syncPhase") or "IDLE")
    tone, headline = _PHASE_TEXT.get(phase, _PHASE_TEXT["IDLE"])

    if phase == "ERROR":
        message = str(status.get("lastError") or status.get("message") or "")
        if message:
            headline = f"ซิงก์ไม่สำเร็จ: {message}"

    expected = int(status.get("recordsExpected") or 0)
    extracted = int(status.get("recordsExtracted") or 0)
    uploaded = int(status.get("recordsUploaded") or 0)
    accepted = int(status.get("recordsAccepted") or 0)
    rejected = int(status.get("recordsRejected") or 0)
    pending = int(status.get("pendingChunks") or 0)

    delivered = accepted + rejected
    if expected > 0:
        progress = min(1.0, max(0.0, delivered / expected))
    elif phase == "SUCCESS":
        progress = 1.0
    else:
        progress = 0.0

    range_from = status.get("rangeFrom")
    range_to = status.get("rangeTo")
    range_text = (
        f"{range_from} ถึง {range_to}" if range_from and range_to else "ยังไม่ได้เลือกช่วง"
    )

    counters = [
        ("อ่านจาก JHCIS", f"{number(extracted)} / {number(expected)}"),
        ("ส่งออกแล้ว", number(uploaded)),
        ("ศูนย์กลางรับแล้ว", number(accepted)),
        ("ปฏิเสธ", number(rejected)),
        ("คิวรอส่ง", f"{number(pending)} ชุด"),
    ]

    active = phase in ACTIVE_PHASES
    return SyncView(
        headline=headline,
        tone=tone,
        range_text=range_text,
        progress=progress,
        percent_text=f"{int(round(progress * 100))}%",
        counters=counters,
        started_text=clock(status.get("syncStartedAt")),
        elapsed_text=elapsed(status.get("syncStartedAt"), moment) if active else "-",
        active=active,
        busy_reason="กำลังซิงก์อยู่ ต้องรอให้รอบนี้เสร็จก่อน" if active else "",
    )


def next_sync_text(
    settings: dict[str, Any],
    state: dict[str, Any],
    now: datetime | None = None,
    status: dict[str, Any] | None = None,
) -> str:
    """
    When the next sync will actually happen.

    The scheduler in cli.ts already decides this - it applies the deterministic
    stagger that keeps twenty clinics from arriving in the same second - and
    publishes the answer as status.nextSyncAt. That value is the truth, and the
    screen reads it rather than working it out again: a second implementation
    here would drift from the first the moment either changed, and the operator
    would be told a time the agent has no intention of keeping.

    The calculation below is the fallback, for an agent old enough not to
    publish the field, or a scheduler that has not ticked yet. It describes the
    settings rather than the schedule, so it does not know about the stagger
    and can be a few minutes optimistic.
    """
    # Thai time throughout: the clock times an operator typed are Thai
    # wall-clock times, so the comparison has to happen in that zone.
    moment = (now or datetime.now(timezone.utc)).astimezone(THAI_TZ)

    published = parse_iso((status or {}).get("nextSyncAt"))
    if published is not None:
        real = published.astimezone(THAI_TZ)
        if real <= moment:
            return "ถึงกำหนดแล้ว"
        # Seconds are shown when the stagger moved the run off the minute:
        # 08:00:27 is the honest answer, and rounding it back to 08:00 would
        # hide exactly the difference this field exists to report.
        clock_text = real.strftime("%H:%M:%S" if real.second else "%H:%M")
        return f"{clock_text} น. ({relative_future(real, moment)})"

    candidates: list[datetime] = []

    interval = int(settings.get("syncIntervalMinutes") or 0)
    if interval > 0:
        last = parse_iso(state.get("lastSyncAt"))
        base = last.astimezone(THAI_TZ) if last else moment
        candidates.append(base + timedelta(minutes=interval))

    for entry in settings.get("dailyTimes") or []:
        text = str(entry).strip()
        if len(text) != 5 or text[2] != ":":
            continue
        try:
            hour, minute = int(text[:2]), int(text[3:])
        except ValueError:
            continue
        today = moment.replace(hour=hour, minute=minute, second=0, microsecond=0)
        candidates.append(today if today > moment else today + timedelta(days=1))

    if not candidates:
        return "ไม่ได้ตั้งเวลาไว้"

    soonest = min(candidates)
    if soonest <= moment:
        return "ถึงกำหนดแล้ว"
    return f"{soonest.strftime('%H:%M')} น. ({relative_future(soonest, moment)})"


def relative_future(when: datetime, now: datetime) -> str:
    seconds = max(0, int((when - now).total_seconds()))
    if seconds < 60:
        return "อีกไม่ถึงนาที"
    if seconds < 3600:
        return f"อีก {seconds // 60} นาที"
    if seconds < 86400:
        return f"อีก {seconds // 3600} ชั่วโมง"
    return f"อีก {seconds // 86400} วัน"
