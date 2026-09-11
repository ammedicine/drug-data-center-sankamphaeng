"""
ศูนย์ข้อมูลการใช้ยา อำเภอสันกำแพง - โปรแกรมเชื่อมข้อมูล JHCIS (Agent)

หน้าตาโปรแกรมสำหรับเจ้าหน้าที่ รพ.สต. ที่ไม่ต้องรู้จักบรรทัดคำสั่ง:
  - ดูสถานะการเชื่อมต่อ JHCIS / ศูนย์กลาง และความคืบหน้าการซิงก์
  - กดซิงก์เอง หรือให้ทำงานอัตโนมัติตามเวลาที่ตั้งไว้
  - ย่อลง system tray และเปิดพร้อม Windows

หน้าที่ของไฟล์นี้คือ "หน้าจอ" เท่านั้น ตรรกะการดึงข้อมูลทั้งหมดยังอยู่ที่ตัว
agent (Node) เดิมที่ทดสอบกับ JHCIS จริงแล้ว โปรแกรมนี้เพียงสั่งงานผ่านคำสั่ง
ของ agent และอ่านไฟล์สถานะที่ agent เขียนไว้
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import customtkinter as ctk

# Design tokens and the pure status-to-screen mapping.
#
# This file is launched as a script, bundled by PyInstaller, and imported by
# smoke_test.py through importlib - three different ideas of what the module
# search path is - so its own directory is put on the path explicitly rather
# than relying on any of them.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import theme  # noqa: E402

try:  # tray icon is optional so the app still opens on a machine without it
    import pystray
    from PIL import Image, ImageDraw

    TRAY_AVAILABLE = True
except Exception:  # pragma: no cover - depends on the target machine
    TRAY_AVAILABLE = False

# The name staff see: window title, tray tooltip, tray menu heading. Only the
# display name - the executable, the data directory, the mutex and the
# installer's AppId all keep their original identity so an existing 1.1.x
# installation upgrades in place rather than appearing twice.
APP_NAME = "Drug data center อำเภอสันกำแพง"
APP_ID = "SankamphaengDrugAgent"
POLL_SECONDS = 2

BRAND = "#0b8377"
BRAND_HOVER = "#0a6a61"
OK = "#157f4b"
WARN = "#97650a"
DANGER = "#b3261e"
MUTED = "#5b6b7c"


# --------------------------------------------------------------------------- paths


def app_dir() -> Path:
    """Folder holding the agent: next to the packaged exe, or the repo checkout."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def data_dir() -> Path:
    """
    Must match dataDir() in agent/src/config.ts.

    AGENT_DATA_DIR is set by the installer but a tray started from that same
    installer still has the old environment, so the fallback has to be a
    folder that is writable in its own right. Beside the executable means
    inside Program Files, where a staff account cannot write.
    """
    override = os.environ.get("AGENT_DATA_DIR")
    if override:
        directory = Path(override)
    elif os.name == "nt" and os.environ.get("ProgramData"):
        directory = Path(os.environ["ProgramData"]) / "SDCAgent"
    else:
        directory = app_dir() / "data"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def env_path() -> Path:
    return app_dir() / ".env"


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


# ------------------------------------------------------------------ agent bridge


CONSOLE_LOG_NAME = "worker-console.log"
"""Where the worker's stdout and stderr end up, under the agent's data folder."""

CONSOLE_MAX_BYTES = 1_048_576
"""Rotate at 1 MB. Small on purpose: everything here is also written,
structured, to agent-<date>.log. What is only here is whatever the agent
printed before its own logger existed."""

CONSOLE_GENERATIONS = 3
"""worker-console.log plus .1 .2 .3 - a hard ceiling of 4 MB, whatever the
worker decides to print."""


class ConsolePump(threading.Thread):
    """
    Reads the worker's console output continuously and writes a bounded copy.

    Reading is the point. The tray used to hand the worker a pipe and never
    read it, which on Windows holds about 4 KB before a synchronous write
    blocks for ever - and Node writes to pipes synchronously. The worker then
    sat in a kernel wait with no timers and no heartbeat, alive but stopped,
    and the watchdog killed a healthy process every five minutes for eleven
    hours. Handing it a plain file would also never block, but a file nothing
    supervises grows without limit, and a clinic PC cannot afford that either.

    So: drain always, write within a bound. If writing fails - a full disk, a
    rotation that cannot rename, a virus scanner holding the file - the thread
    keeps reading and throws the output away. Draining is what keeps the
    worker alive; keeping a copy is only a convenience, and the convenience
    must never be able to cost the worker.
    """

    def __init__(self, stream, path: Path) -> None:
        super().__init__(name="sdc-console-pump", daemon=True)
        self.stream = stream
        self.path = path
        self.written = 0
        self.rotations = 0
        self.discarding = False
        self._sink = None
        self._size = 0

    def run(self) -> None:
        try:
            self._open()
            for line in self.stream:
                self._write(line)
        except Exception:  # pragma: no cover - the stream closing is normal
            pass
        finally:
            self._close()

    # -- the bounded file ------------------------------------------------------
    def _open(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._size = self.path.stat().st_size if self.path.exists() else 0
            self._sink = self.path.open("a", encoding="utf-8", errors="replace")
        except Exception:
            self.discarding = True

    def _close(self) -> None:
        if self._sink:
            try:
                self._sink.close()
            except Exception:
                pass
            self._sink = None

    def _write(self, line: str) -> None:
        self.written += len(line)
        if self.discarding or not self._sink:
            return
        try:
            if self._size >= CONSOLE_MAX_BYTES:
                self._rotate()
            self._sink.write(line)
            self._sink.flush()
            self._size += len(line)
        except Exception:
            # Whatever went wrong with the file, the stream still gets read.
            self._close()
            self.discarding = True

    def _rotate(self) -> None:
        """
        worker-console.log -> .1, .1 -> .2, .2 -> .3, and .3 is gone.

        Renaming needs the file closed, which is why this thread is the only
        writer: Windows refuses to rename a file another handle still holds.
        """
        self._close()
        oldest = self.path.with_suffix(self.path.suffix + f".{CONSOLE_GENERATIONS}")
        if oldest.exists():
            oldest.unlink()
        for generation in range(CONSOLE_GENERATIONS - 1, 0, -1):
            source = self.path.with_suffix(self.path.suffix + f".{generation}")
            if source.exists():
                source.replace(self.path.with_suffix(self.path.suffix + f".{generation + 1}"))
        self.path.replace(self.path.with_suffix(self.path.suffix + ".1"))
        self._sink = self.path.open("a", encoding="utf-8", errors="replace")
        self._size = 0
        self.rotations += 1


@dataclass
class CommandResult:
    ok: bool
    output: str


class AgentBridge:
    """Runs the Node agent CLI and reads the files it writes."""

    def __init__(self) -> None:
        self.root = app_dir()
        self.background: subprocess.Popen[str] | None = None
        self.console: ConsolePump | None = None
        self._background_started: datetime | None = None

    # -- how to invoke the agent ------------------------------------------------
    def _command(self, args: list[str]) -> list[str]:
        """
        Packaged installs ship a bundled Node runtime and a compiled agent.
        A developer checkout falls back to `npx tsx src/cli.ts`.
        """
        bundled_node = self.root / "runtime" / "node.exe"
        bundled_agent = self.root / "app" / "agent.js"
        if bundled_node.exists() and bundled_agent.exists():
            return [str(bundled_node), str(bundled_agent), *args]

        built = self.root / "dist" / "agent" / "src" / "cli.js"
        if built.exists():
            return [self._resolve("node"), str(built), *args]

        # Developer checkout: run the TypeScript directly. Windows resolves
        # `npx` to npx.cmd, which Popen cannot find without a full path.
        return [self._resolve("npx"), "tsx", str(self.root / "src" / "cli.ts"), *args]

    @staticmethod
    def _resolve(program: str) -> str:
        """Full path to an executable, so Popen works without a shell."""
        found = shutil.which(program)
        if found:
            return found
        if os.name == "nt":
            for suffix in (".cmd", ".exe", ".bat"):
                found = shutil.which(program + suffix)
                if found:
                    return found
        return program

    def _environment(self) -> dict[str, str]:
        """
        Environment for every agent process this screen starts.

        The screen and the agent must agree on one data folder, and until now
        they could disagree. The agent runs with cwd={app} and calls
        dotenv.config(), so it reads {app}\\.env - and the installer only writes
        that file when it is absent, so a machine upgraded from an old release
        still has one saying AGENT_DATA_DIR=./data. That resolves to
        {app}\\data inside Program Files, while this screen falls back to
        ProgramData: two processes, two folders, and a queue the screen cannot
        see.

        Passing the resolved folder explicitly settles it. The child's
        AGENT_DATA_DIR is already set when dotenv runs, and dotenv does not
        overwrite a variable that exists, so the stale file loses without being
        touched - the JHCIS credentials beside it are left exactly as they are.
        """
        child = os.environ.copy()
        child["AGENT_DATA_DIR"] = str(data_dir())
        return child

    def _popen(self, args: list[str]) -> subprocess.Popen[str]:
        """
        Starts the agent CLI.

        Short commands are read to completion by communicate(). The always-on
        worker is drained by ConsolePump instead - see start_background. What
        must never happen again is a pipe nobody reads: an unread pipe on
        Windows holds about 4 KB, Node writes to one synchronously, and the
        worker parks in a kernel wait for ever. No timers, no heartbeat, no
        CPU, process still alive, and a watchdog killing something that was
        never unwell - every five minutes, for eleven hours, on the canary.
        Measured here, the child blocked after 3,900 bytes; an ordinary cycle
        prints 592 and the historical repair printed 4,038.
        """
        creation = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        return subprocess.Popen(
            self._command(args),
            cwd=str(self.root),
            env=self._environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creation,
        )

    def run_with_input(self, args: list[str], payload: str, timeout: int = 120) -> CommandResult:
        """
        Same as run(), but hands the agent a value on stdin.

        Used for the JHCIS password: command-line arguments are visible to every
        process on the machine, stdin is not.
        """
        try:
            process = subprocess.Popen(
                self._command(args),
                cwd=str(self.root),
                env=self._environment(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            output, _ = process.communicate(payload, timeout=timeout)
            return CommandResult(process.returncode == 0, output or "")
        except subprocess.TimeoutExpired:
            return CommandResult(False, "คำสั่งใช้เวลานานเกินไป")
        except FileNotFoundError as error:
            return CommandResult(False, f"ไม่พบโปรแกรม agent: {error}")
        except Exception as error:  # pragma: no cover - defensive
            return CommandResult(False, str(error))

    def enroll_command(self, token: str, url: str) -> list[str]:
        """
        The agent arguments an enrolment turns into.

        Separated so it can be checked without opening a window: the bug this
        replaced was invisible on screen - the address field looked saved, and
        the request went to whichever host the old .env happened to name.
        """
        args = ["enroll", "--token", token]
        if url:
            args += ["--url", url]
        return args

    def agent_version(self) -> str | None:
        """
        Version reported by the agent itself.

        Read from the agent rather than kept as a constant here, so the number
        on screen is the version of the code that will actually do the work -
        two places to edit is how it ends up saying 1.0.0 for ever.
        """
        result = self.run(["status"], timeout=90)
        if not result.ok:
            return None
        match = re.search(r"agent version\s*:\s*(\S+)", result.output)
        return match.group(1) if match else None

    def jhcis_settings(self) -> dict[str, Any]:
        """Connection the agent is actually using, password masked."""
        result = self.run(["jhcis"], timeout=60)
        if not result.ok:
            return {}
        try:
            return json.loads(result.output[result.output.index("{") :])
        except (ValueError, json.JSONDecodeError):
            return {}

    def save_jhcis(self, values: dict[str, Any]) -> CommandResult:
        """
        Stores the connection in the agent's data folder, not in .env.

        .env lives beside the executable in Program Files, which the staff
        account running the tray cannot write to - so editing the IP there
        looked like it worked and never took effect. The data folder is
        writable, and the agent locks the file down when it saves it.
        """
        return self.run_with_input(["jhcis", "--set"], json.dumps(values, ensure_ascii=False))

    def run(self, args: list[str], timeout: int = 3600) -> CommandResult:
        try:
            process = self._popen(args)
            output, _ = process.communicate(timeout=timeout)
            return CommandResult(process.returncode == 0, output or "")
        except subprocess.TimeoutExpired:
            return CommandResult(False, "คำสั่งใช้เวลานานเกินไป")
        except FileNotFoundError as error:
            return CommandResult(False, f"ไม่พบโปรแกรม agent: {error}")
        except Exception as error:  # pragma: no cover - defensive
            return CommandResult(False, str(error))

    # -- the always-on background worker ---------------------------------------
    def worker_console_log(self) -> Path:
        """The bounded file ConsolePump writes, and the .1 .2 .3 beside it."""
        folder = data_dir() / "logs"
        folder.mkdir(parents=True, exist_ok=True)
        return folder / CONSOLE_LOG_NAME

    def start_background(self) -> str | None:
        """Starts the worker; returns an error message instead of raising."""
        if self.background and self.background.poll() is None:
            return None
        try:
            self.background = self._popen(["run"])
            # Started immediately and never left unattached: the pipe above is
            # only safe for as long as somebody is emptying it.
            self.console = ConsolePump(self.background.stdout, self.worker_console_log())
            self.console.start()
            self._background_started = datetime.now(timezone.utc)
            return None
        except Exception as error:
            self.background = None
            return f"เริ่มตัวทำงานเบื้องหลังไม่สำเร็จ: {error}"

    def consume_worker_exit(self) -> dict[str, Any] | None:
        """
        Reports a worker that has exited, once, and forgets it.

        The exit code was previously read by poll() and thrown away, so a
        worker that died on its own left nothing behind on this side at all -
        which is precisely the position we were in when one did. Whatever the
        cause, the parent is the only thing still running afterwards, so it is
        the only thing that can say what it saw.
        """
        if not self.background or self.background.poll() is None:
            return None
        code = self.background.returncode
        started = self._background_started
        ran = int((datetime.now(timezone.utc) - started).total_seconds()) if started else None
        detail = {"pid": self.background.pid, "exitCode": code, "ranSeconds": ran}
        self.background = None
        self._background_started = None
        return detail

    def note(self, message: str, meta: dict[str, Any]) -> None:
        """
        Appends one line to today's log, in the shape the worker writes.

        Same file, because an operator looking for what happened should not
        have to know which process noticed it. Never raises: this is a
        diagnostic, and losing it must not disturb the window.
        """
        try:
            folder = data_dir() / "logs"
            folder.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc)
            line = json.dumps(
                {
                    "ts": stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{stamp.microsecond // 1000:03d}Z",
                    "level": "warn",
                    "message": message,
                    "meta": {**meta, "source": "tray"},
                },
                ensure_ascii=False,
            )
            path = folder / f"agent-{stamp.strftime('%Y-%m-%d')}.log"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except Exception:  # pragma: no cover - a lost diagnostic is not an error
            pass

    def stop_background(self) -> None:
        # Still only this tray's own child, by the handle it was started with.
        if self.background and self.background.poll() is None:
            self.background.terminate()
            try:
                self.background.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover
                self.background.kill()
        # The pump ends on its own when the stream closes; it is a daemon
        # thread, so a slow one can never hold the window open either.
        if self.console:
            self.console.join(timeout=5)
            self.console = None
        self.background = None

    def background_running(self) -> bool:
        return bool(self.background and self.background.poll() is None)

    # -- files the agent maintains ---------------------------------------------
    def status(self) -> dict[str, Any]:
        return read_json(data_dir() / "status.json")

    def state(self) -> dict[str, Any]:
        return read_json(data_dir() / "state.json")

    def settings(self) -> dict[str, Any]:
        stored = read_json(data_dir() / "settings.json")
        return {
            "autoSyncEnabled": True,
            "syncIntervalMinutes": 60,
            "dailyTimes": [],
            "heartbeatMinutes": 5,
            "startWithWindows": True,
            "minimiseToTray": True,
            **stored,
        }

    def save_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        merged = {**self.settings(), **patch}
        (data_dir() / "settings.json").write_text(
            json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return merged

    def credential(self) -> dict[str, Any]:
        # อยู่ในโฟลเดอร์ข้อมูลตั้งแต่ v1.0.1 (ก่อนหน้านั้นอยู่ข้าง ๆ ตัวโปรแกรม)
        current = read_json(data_dir() / "agent.config.json")
        return current or read_json(app_dir() / "agent.config.json")

    def queue_depth(self) -> tuple[int, int]:
        pending = data_dir() / "queue" / "pending"
        failed = data_dir() / "queue" / "failed"
        count = lambda folder: len(list(folder.glob("*.json"))) if folder.exists() else 0
        return count(pending), count(failed)

    def latest_log(self, lines: int = 200) -> str:
        folder = data_dir() / "logs"
        if not folder.exists():
            return "ยังไม่มีบันทึกการทำงาน"
        files = sorted(folder.glob("agent-*.log"))
        if not files:
            return "ยังไม่มีบันทึกการทำงาน"
        try:
            content = files[-1].read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception as error:  # pragma: no cover
            return f"อ่านบันทึกไม่ได้: {error}"

        readable: list[str] = []
        for line in content[-lines:]:
            try:
                entry = json.loads(line)
                # The file keeps UTC and is never rewritten. Slicing the ISO
                # string here showed that UTC straight to the operator, seven
                # hours behind the clock in the corner of their screen.
                readable.append(
                    f"{theme.clock(entry.get('ts'))}  {entry.get('level', '').upper():5}  "
                    f"{entry.get('message', '')}"
                )
            except Exception:
                readable.append(line)
        return "\n".join(readable)

    # -- JHCIS credentials live in .env, never sent anywhere --------------------
    def read_env(self) -> dict[str, str]:
        values: dict[str, str] = {}
        path = env_path()
        if not path.exists():
            return values
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
        return values

    def write_env(self, values: dict[str, str]) -> None:
        current = self.read_env()
        current.update(values)
        body = "\n".join(f"{key}={value}" for key, value in current.items())
        env_path().write_text(f"{body}\n", encoding="utf-8")


# ------------------------------------------------------------------ autostart


def set_autostart(enabled: bool) -> str:
    """Registers the app under HKCU Run - per user, no admin rights needed."""
    if os.name != "nt":
        return "ตั้งค่าเปิดพร้อมเครื่องได้เฉพาะบน Windows"
    try:
        import winreg

        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        target = (
            f'"{sys.executable}"'
            if getattr(sys, "frozen", False)
            else f'"{sys.executable}" "{Path(__file__).resolve()}"'
        )
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, APP_ID, 0, winreg.REG_SZ, f"{target} --tray")
            else:
                try:
                    winreg.DeleteValue(key, APP_ID)
                except FileNotFoundError:
                    pass
        return "บันทึกการตั้งค่าเปิดพร้อม Windows แล้ว"
    except Exception as error:  # pragma: no cover - depends on the machine
        return f"ตั้งค่าเปิดพร้อม Windows ไม่สำเร็จ: {error}"


# ------------------------------------------------------------------------- UI


class AgentApp(ctk.CTk):
    """
    The window.

    Laid out as a fixed sidebar and one page at a time, rather than tabs: a
    tab strip reads as a prototype, and it gave no room for the thing that
    actually matters - one glance telling a เจ้าหน้าที่ whether data is moving.

    Every size, colour and space comes from theme.py. Nothing here invents its
    own padding, and no widget is given a width because it happened to look
    right; columns carry weights so Thai text can grow without being clipped at
    125% or 150% display scaling.
    """

    NAV = [
        ("overview", "ภาพรวม", "◉"),
        ("sync", "การซิงก์", "↻"),
        ("connection", "การเชื่อมต่อ", "⇄"),
        ("settings", "ตั้งค่า", "⚙"),
        ("logs", "บันทึกการทำงาน", "≡"),
    ]

    def __init__(self, start_in_tray: bool = False) -> None:
        super().__init__()
        ctk.set_appearance_mode("light")

        self.bridge = AgentBridge()
        self.messages: queue.Queue[tuple[str, str]] = queue.Queue()
        self.tray_icon = None
        self.busy = False
        self.app_version = "?"
        self.current_page = "overview"
        self.pages: dict[str, ctk.CTkFrame] = {}
        self.nav_buttons: dict[str, ctk.CTkButton] = {}
        self._last_log = ""

        self.title(APP_NAME)
        self.geometry("{}x{}".format(*theme.WINDOW_DEFAULT))
        self.minsize(*theme.WINDOW_MIN)
        self.configure(fg_color=theme.CANVAS)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # Settings variables exist before any page is built, because pages read
        # them as they are constructed and the tray toggle is needed on close.
        self.auto_var = ctk.BooleanVar(value=True)
        self.startup_var = ctk.BooleanVar(value=True)
        self.tray_var = ctk.BooleanVar(value=True)

        self._build_header()
        self._build_shell()
        self._load_settings_into_form()
        self._select_page("overview")

        # Watchdog bookkeeping. Held here rather than inside the check so a
        # restart is remembered across polls - that is what stops a failing
        # worker being restarted every two seconds.
        self._worker_seen_at: datetime | None = None
        # The last valid tick read from status.json, carried across rounds so
        # one failed read (the file is replaced by rename every 30s) cannot
        # look like a worker that has never reported. See theme.remember_tick.
        self._worker_last_tick: datetime | None = None
        self._watchdog_checked_at: datetime | None = None
        # Times of recent restarts, so the allowance is per window rather
        # than per lifetime - a machine that recovered five times over a
        # week must still be allowed a sixth.
        self._watchdog_restarts: list[datetime] = []
        # Recovery must never fight intent: a tray that is closing, or an
        # operator who stopped the worker, does not want it handed back.
        self._worker_should_run = True

        # The window must open even when the worker cannot start, otherwise the
        # operator has no way to fix the settings that caused it.
        self.worker_error = self.bridge.start_background()
        self._schedule_poll()
        self._resolve_version()

        if TRAY_AVAILABLE:
            self._start_tray()
        if start_in_tray:
            self.after(300, self.withdraw)

    # -- small building blocks --------------------------------------------------

    def _font(self, size_key: str, weight: str = "normal") -> ctk.CTkFont:
        return ctk.CTkFont(size=theme.TYPE[size_key], weight=weight)

    def _card(self, parent: Any, title: str | None = None) -> ctk.CTkFrame:
        """A white panel. Titles are optional so cards can nest cleanly."""
        card = ctk.CTkFrame(parent, fg_color=theme.SURFACE, corner_radius=theme.RADIUS["md"])
        if title:
            ctk.CTkLabel(
                card,
                text=title,
                font=self._font("section", "bold"),
                text_color=theme.INK,
                anchor="w",
            ).pack(
                fill="x",
                padx=theme.SPACE["lg"],
                pady=(theme.SPACE["md"], theme.SPACE["xs"]),
            )
        return card

    def _primary(self, parent: Any, text: str, command: Any) -> ctk.CTkButton:
        return ctk.CTkButton(
            parent,
            text=text,
            command=command,
            fg_color=theme.BRAND,
            hover_color=theme.BRAND_HOVER,
            height=theme.BUTTON_HEIGHT,
            corner_radius=theme.RADIUS["sm"],
            font=self._font("body", "bold"),
        )

    def _secondary(self, parent: Any, text: str, command: Any) -> ctk.CTkButton:
        return ctk.CTkButton(
            parent,
            text=text,
            command=command,
            fg_color=theme.SURFACE,
            text_color=theme.BRAND,
            border_width=1,
            border_color=theme.LINE,
            hover_color=theme.BRAND_SOFT,
            height=theme.BUTTON_HEIGHT,
            corner_radius=theme.RADIUS["sm"],
            font=self._font("body"),
        )

    def _kv(self, parent: Any, row: int, label: str) -> ctk.CTkLabel:
        """A label/value pair on the shared grid, returning the value widget."""
        ctk.CTkLabel(
            parent,
            text=label,
            text_color=theme.MUTED,
            font=self._font("body"),
            anchor="w",
        ).grid(row=row, column=0, sticky="w", pady=theme.SPACE["xs"] // 2)
        value = ctk.CTkLabel(
            parent, text="-", font=self._font("body"), anchor="w", text_color=theme.INK
        )
        value.grid(row=row, column=1, sticky="w", padx=(theme.SPACE["md"], 0))
        return value

    # -- shell ------------------------------------------------------------------

    def _build_header(self) -> None:
        header = ctk.CTkFrame(self, fg_color=theme.SIDEBAR, corner_radius=0, height=64)
        header.pack(fill="x")
        header.pack_propagate(False)
        header.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(
            header,
            text="ศูนย์ข้อมูลการใช้ยา อำเภอสันกำแพง",
            text_color="white",
            font=self._font("display", "bold"),
            anchor="w",
        ).grid(row=0, column=0, sticky="w", padx=(theme.SPACE["xl"], theme.SPACE["md"]))

        # Facility, pcucode and version together: who this machine speaks for,
        # and which build is speaking - the two questions asked first when a
        # รพ.สต. reports a problem.
        self.facility_label = ctk.CTkLabel(
            header,
            text="ยังไม่ได้ลงทะเบียนกับศูนย์กลาง",
            text_color=theme.SIDEBAR_TEXT,
            font=self._font("body"),
            anchor="w",
        )
        self.facility_label.grid(row=0, column=1, sticky="w")

        self.version_label = ctk.CTkLabel(
            header,
            text="เวอร์ชัน ...",
            text_color=theme.SIDEBAR_TEXT,
            font=self._font("body"),
            anchor="e",
        )
        self.version_label.grid(row=0, column=2, sticky="e", padx=theme.SPACE["xl"])

    def _build_shell(self) -> None:
        shell = ctk.CTkFrame(self, fg_color="transparent")
        shell.pack(fill="both", expand=True)
        shell.grid_columnconfigure(1, weight=1)
        shell.grid_rowconfigure(0, weight=1)

        sidebar = ctk.CTkFrame(
            shell, fg_color=theme.SIDEBAR, corner_radius=0, width=theme.SIDEBAR_WIDTH
        )
        sidebar.grid(row=0, column=0, sticky="nsw")
        sidebar.grid_propagate(False)

        for index, (key, label, glyph) in enumerate(self.NAV):
            button = ctk.CTkButton(
                sidebar,
                text=f"  {glyph}   {label}",
                anchor="w",
                command=lambda k=key: self._select_page(k),
                fg_color="transparent",
                hover_color=theme.SIDEBAR_ACTIVE,
                text_color=theme.SIDEBAR_TEXT,
                corner_radius=theme.RADIUS["sm"],
                height=theme.NAV_ITEM_HEIGHT,
                font=self._font("body"),
            )
            button.pack(
                fill="x",
                padx=theme.SPACE["md"],
                pady=(theme.SPACE["md"] if index == 0 else theme.SPACE["xs"], 0),
            )
            self.nav_buttons[key] = button

        self.content = ctk.CTkFrame(shell, fg_color="transparent")
        self.content.grid(row=0, column=1, sticky="nsew")
        self.content.grid_columnconfigure(0, weight=1)
        self.content.grid_rowconfigure(0, weight=1)

        for key, builder in (
            ("overview", self._page_overview),
            ("sync", self._page_sync),
            ("connection", self._page_connection),
            ("settings", self._page_settings),
            ("logs", self._page_logs),
        ):
            page = ctk.CTkFrame(self.content, fg_color="transparent")
            page.grid(row=0, column=0, sticky="nsew")
            builder(page)
            self.pages[key] = page

    def _select_page(self, key: str) -> None:
        self.current_page = key
        self.pages[key].tkraise()
        for nav_key, button in self.nav_buttons.items():
            selected = nav_key == key
            button.configure(
                fg_color=theme.SIDEBAR_ACTIVE if selected else "transparent",
                text_color="white" if selected else theme.SIDEBAR_TEXT,
                font=self._font("body", "bold" if selected else "normal"),
            )

    def _page_title(self, parent: Any, text: str, subtitle: str) -> None:
        ctk.CTkLabel(
            parent, text=text, font=self._font("title", "bold"), text_color=theme.INK, anchor="w"
        ).pack(fill="x", padx=theme.SPACE["xl"], pady=(theme.SPACE["lg"], 0))
        ctk.CTkLabel(
            parent, text=subtitle, font=self._font("caption"), text_color=theme.MUTED, anchor="w"
        ).pack(fill="x", padx=theme.SPACE["xl"], pady=(2, theme.SPACE["md"]))

    # -- pages ------------------------------------------------------------------

    def _page_overview(self, page: Any) -> None:
        """
        Everything that matters, without scrolling: are the links up, what is
        the current run doing, and when did data last arrive.
        """
        self._page_title(page, "ภาพรวม", "สถานะการเชื่อมต่อและการซิงก์ข้อมูลของเครื่องนี้")

        body = ctk.CTkFrame(page, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=theme.SPACE["xl"], pady=(0, theme.SPACE["lg"]))
        body.grid_columnconfigure((0, 1, 2), weight=1, uniform="status")
        body.grid_rowconfigure(1, weight=1)

        self.status_cards: dict[str, dict[str, ctk.CTkLabel]] = {}
        for column, key in enumerate(("jhcis", "central", "worker")):
            card = self._card(body)
            card.grid(
                row=0,
                column=column,
                sticky="nsew",
                padx=(0 if column == 0 else theme.SPACE["md"], 0),
            )
            head = ctk.CTkFrame(card, fg_color="transparent")
            head.pack(fill="x", padx=theme.SPACE["lg"], pady=(theme.SPACE["md"], 0))
            dot = ctk.CTkLabel(head, text="●", font=self._font("body"), text_color=theme.MUTED)
            dot.pack(side="left", padx=(0, theme.SPACE["sm"]))
            name = ctk.CTkLabel(
                head, text="", font=self._font("caption"), text_color=theme.MUTED, anchor="w"
            )
            name.pack(side="left")
            value = ctk.CTkLabel(
                card, text="-", font=self._font("section", "bold"), anchor="w", text_color=theme.INK
            )
            value.pack(fill="x", padx=theme.SPACE["lg"], pady=(theme.SPACE["xs"], 0))
            detail = ctk.CTkLabel(
                card,
                text="",
                font=self._font("caption"),
                text_color=theme.MUTED,
                anchor="w",
                justify="left",
            )
            detail.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
            self.status_cards[key] = {"dot": dot, "name": name, "value": value, "detail": detail}

        # The current sync is the loudest thing on the page by design.
        sync_card = self._card(body, "การซิงก์รอบปัจจุบัน")
        sync_card.grid(
            row=1, column=0, columnspan=3, sticky="nsew", pady=(theme.SPACE["md"], 0)
        )

        self.sync_headline = ctk.CTkLabel(
            sync_card, text="พร้อมทำงาน", font=self._font("title", "bold"), anchor="w"
        )
        self.sync_headline.pack(fill="x", padx=theme.SPACE["lg"])

        self.sync_range = ctk.CTkLabel(
            sync_card,
            text="ยังไม่ได้เลือกช่วง",
            font=self._font("body"),
            text_color=theme.MUTED,
            anchor="w",
        )
        self.sync_range.pack(fill="x", padx=theme.SPACE["lg"], pady=(2, theme.SPACE["sm"]))

        bar_row = ctk.CTkFrame(sync_card, fg_color="transparent")
        bar_row.pack(fill="x", padx=theme.SPACE["lg"])
        bar_row.grid_columnconfigure(0, weight=1)
        self.progress = ctk.CTkProgressBar(
            bar_row, height=12, progress_color=theme.BRAND, corner_radius=theme.RADIUS["sm"]
        )
        self.progress.set(0)
        self.progress.grid(row=0, column=0, sticky="ew")
        self.progress_percent = ctk.CTkLabel(
            bar_row, text="0%", font=self._font("body", "bold"), text_color=theme.INK, width=48
        )
        self.progress_percent.grid(row=0, column=1, padx=(theme.SPACE["md"], 0))

        counters = ctk.CTkFrame(sync_card, fg_color="transparent")
        counters.pack(fill="x", padx=theme.SPACE["lg"], pady=(theme.SPACE["md"], 0))
        counters.grid_columnconfigure(tuple(range(5)), weight=1, uniform="counter")
        self.counter_labels: list[tuple[ctk.CTkLabel, ctk.CTkLabel]] = []
        for column in range(5):
            caption = ctk.CTkLabel(
                counters, text="", font=self._font("caption"), text_color=theme.MUTED, anchor="w"
            )
            caption.grid(row=0, column=column, sticky="w")
            value = ctk.CTkLabel(
                counters, text="-", font=self._font("section", "bold"), anchor="w",
                text_color=theme.INK,
            )
            value.grid(row=1, column=column, sticky="w")
            self.counter_labels.append((caption, value))

        timing = ctk.CTkFrame(sync_card, fg_color="transparent")
        timing.pack(fill="x", padx=theme.SPACE["lg"], pady=(theme.SPACE["md"], theme.SPACE["md"]))
        self.sync_timing = ctk.CTkLabel(
            timing, text="", font=self._font("caption"), text_color=theme.MUTED, anchor="w"
        )
        self.sync_timing.pack(fill="x")

        summary = ctk.CTkFrame(body, fg_color="transparent")
        summary.grid(row=2, column=0, columnspan=3, sticky="ew", pady=(theme.SPACE["md"], 0))
        summary.grid_columnconfigure((0, 1, 2), weight=1, uniform="summary")
        self.summary_labels: dict[str, ctk.CTkLabel] = {}
        for column, (key, label) in enumerate(
            (
                ("last_sync", "ซิงก์สำเร็จล่าสุด"),
                ("watermark", "ข้อมูลล่าสุดถึงวันที่"),
                ("next_sync", "รอบอัตโนมัติถัดไป"),
            )
        ):
            cell = self._card(summary)
            cell.grid(
                row=0, column=column, sticky="ew", padx=(0 if column == 0 else theme.SPACE["md"], 0)
            )
            ctk.CTkLabel(
                cell, text=label, font=self._font("caption"), text_color=theme.MUTED, anchor="w"
            ).pack(fill="x", padx=theme.SPACE["lg"], pady=(theme.SPACE["md"], 0))
            value = ctk.CTkLabel(
                cell, text="-", font=self._font("section", "bold"), anchor="w", text_color=theme.INK
            )
            value.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
            self.summary_labels[key] = value

        actions = ctk.CTkFrame(body, fg_color="transparent")
        actions.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(theme.SPACE["md"], 0))
        self.sync_button = self._primary(
            actions, "ซิงก์เดี๋ยวนี้", lambda: self._run_async(["sync"], "กำลังซิงก์ข้อมูล...")
        )
        self.sync_button.pack(side="left")
        self.verify_button = self._secondary(
            actions, "ตรวจสอบความครบถ้วน", lambda: self._run_async(["verify"], "กำลังตรวจสอบ...")
        )
        self.verify_button.pack(side="left", padx=theme.SPACE["sm"])
        self.retry_button = self._secondary(
            actions, "ส่งข้อมูลค้างอีกครั้ง", lambda: self._run_async(["retry"], "กำลังส่งข้อมูลค้าง...")
        )
        self.retry_button.pack(side="left")
        self.action_hint = ctk.CTkLabel(
            actions, text="", font=self._font("caption"), text_color=theme.MUTED
        )
        self.action_hint.pack(side="left", padx=theme.SPACE["md"])

    def _page_sync(self, page: Any) -> None:
        self._page_title(page, "การซิงก์", "รายละเอียดรอบปัจจุบันและผลการซิงก์ล่าสุด")

        body = ctk.CTkFrame(page, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=theme.SPACE["xl"], pady=(0, theme.SPACE["lg"]))
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(1, weight=1)

        detail = self._card(body, "รอบปัจจุบัน")
        detail.grid(row=0, column=0, sticky="ew")
        grid = ctk.CTkFrame(detail, fg_color="transparent")
        grid.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
        grid.grid_columnconfigure(1, weight=1)
        self.detail_labels = {
            key: self._kv(grid, row, label)
            for row, (key, label) in enumerate(
                (
                    ("phase", "สถานะ"),
                    ("range", "ช่วงวันที่รับบริการ"),
                    ("batch", "รหัสรอบ"),
                    ("expected", "พบใน JHCIS"),
                    ("extracted", "อ่านแล้ว"),
                    ("uploaded", "ส่งออกแล้ว"),
                    ("accepted", "ศูนย์กลางรับแล้ว"),
                    ("rejected", "ปฏิเสธ"),
                    ("queue", "คิวรอส่ง"),
                    ("started", "เริ่มเมื่อ"),
                )
            )
        }

        recent = self._card(body, "ผลการทำงานล่าสุด")
        recent.grid(row=1, column=0, sticky="nsew", pady=(theme.SPACE["md"], 0))
        self.recent_box = ctk.CTkTextbox(
            recent,
            height=120,
            font=ctk.CTkFont(family="Consolas", size=theme.TYPE["caption"]),
            fg_color=theme.CANVAS,
            border_width=0,
        )
        self.recent_box.pack(
            fill="both", expand=True, padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"])
        )

    def _page_connection(self, page: Any) -> None:
        """
        JHCIS and Central are different systems with different failures, so
        they get different panels and their own test buttons - it must never be
        ambiguous which one a button is about to talk to.
        """
        self._page_title(page, "การเชื่อมต่อ", "ตั้งค่าปลายทาง JHCIS และการลงทะเบียนกับศูนย์กลาง")

        body = ctk.CTkScrollableFrame(page, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=theme.SPACE["xl"], pady=(0, theme.SPACE["lg"]))
        body.grid_columnconfigure(0, weight=1)

        jhcis = self._card(body, "ฐานข้อมูล JHCIS (เก็บไว้ในเครื่องนี้เท่านั้น)")
        jhcis.pack(fill="x")
        form = ctk.CTkFrame(jhcis, fg_color="transparent")
        form.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["sm"]))
        form.grid_columnconfigure(1, weight=1)

        self.env_entries: dict[str, ctk.CTkEntry] = {}
        fields = [
            ("JHCIS_DB_HOST", "เครื่องฐานข้อมูล (IP)", "192.168.1.10"),
            ("JHCIS_DB_PORT", "พอร์ต", "3306"),
            ("JHCIS_DB_DATABASE", "ชื่อฐานข้อมูล", "jhcisdb"),
            ("JHCIS_DB_USER", "ผู้ใช้ (สิทธิ์อ่านอย่างเดียว)", "readonly"),
            ("JHCIS_DB_PASSWORD", "รหัสผ่าน", ""),
        ]
        for row, (key, label, placeholder) in enumerate(fields):
            ctk.CTkLabel(
                form,
                text=label,
                text_color=theme.MUTED,
                font=self._font("body"),
                anchor="w",
                width=theme.LABEL_WIDTH,
            ).grid(row=row, column=0, sticky="w", pady=theme.SPACE["xs"])
            entry = ctk.CTkEntry(
                form,
                placeholder_text=placeholder,
                show="*" if key.endswith("PASSWORD") else "",
                height=32,
                corner_radius=theme.RADIUS["sm"],
                border_color=theme.LINE,
            )
            entry.grid(row=row, column=1, sticky="ew", pady=theme.SPACE["xs"])
            self.env_entries[key] = entry

        jhcis_actions = ctk.CTkFrame(jhcis, fg_color="transparent")
        jhcis_actions.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
        self._secondary(jhcis_actions, "บันทึกและทดสอบการเชื่อมต่อ JHCIS", self._test_jhcis).pack(
            side="left"
        )
        self.jhcis_hint = ctk.CTkLabel(
            jhcis_actions, text="", font=self._font("caption"), text_color=theme.MUTED
        )
        self.jhcis_hint.pack(side="left", padx=theme.SPACE["md"])

        central = self._card(body, "ศูนย์กลาง (Central)")
        central.pack(fill="x", pady=(theme.SPACE["md"], 0))
        cgrid = ctk.CTkFrame(central, fg_color="transparent")
        cgrid.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["sm"]))
        cgrid.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(
            cgrid,
            text="ที่อยู่ศูนย์กลาง",
            text_color=theme.MUTED,
            font=self._font("body"),
            anchor="w",
            width=theme.LABEL_WIDTH,
        ).grid(row=0, column=0, sticky="w", pady=theme.SPACE["xs"])
        central_entry = ctk.CTkEntry(
            cgrid, placeholder_text="https://", height=32, corner_radius=theme.RADIUS["sm"],
            border_color=theme.LINE,
        )
        central_entry.grid(row=0, column=1, sticky="ew", pady=theme.SPACE["xs"])
        self.env_entries["CENTRAL_API_URL"] = central_entry

        self.central_labels = {
            key: self._kv(cgrid, row, label)
            for row, (key, label) in enumerate(
                (("enrolled", "สถานะการลงทะเบียน"), ("facility", "สถานบริการ"), ("ack", "ติดต่อสำเร็จล่าสุด")),
                start=1,
            )
        }

        enroll_row = ctk.CTkFrame(central, fg_color="transparent")
        enroll_row.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
        ctk.CTkLabel(
            enroll_row,
            text="รหัสลงทะเบียน (ขอจากผู้ดูแลระบบ ใช้ได้ครั้งเดียว)",
            text_color=theme.MUTED,
            font=self._font("caption"),
            anchor="w",
        ).pack(fill="x", pady=(0, theme.SPACE["xs"]))
        row = ctk.CTkFrame(enroll_row, fg_color="transparent")
        row.pack(fill="x")
        self.token_entry = ctk.CTkEntry(
            row, placeholder_text="ENR-...", height=32, corner_radius=theme.RADIUS["sm"],
            border_color=theme.LINE,
        )
        self.token_entry.pack(side="left", fill="x", expand=True)
        self._primary(row, "ลงทะเบียนกับศูนย์กลาง", self._enroll).pack(
            side="left", padx=(theme.SPACE["sm"], 0)
        )

        # Time and updates: both are about this PC keeping itself usable
        # without anyone driving out to it, and both are read-only here - the
        # buttons only ask a task that already exists to run now.
        upkeep = self._card(body, "เวลาเครื่องและการอัปเดต")
        upkeep.pack(fill="x", pady=(theme.SPACE["md"], 0))
        ugrid = ctk.CTkFrame(upkeep, fg_color="transparent")
        ugrid.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["sm"]))
        ugrid.grid_columnconfigure(1, weight=1)
        self.upkeep_labels = {
            key: self._kv(ugrid, row, label)
            for row, (key, label) in enumerate(
                (
                    ("clock", "เวลาเครื่อง"),
                    ("clock_detail", ""),
                    ("update", "อัปเดตอัตโนมัติ"),
                    ("update_detail", ""),
                    ("versions", "เวอร์ชัน"),
                )
            )
        }

        upkeep_row = ctk.CTkFrame(upkeep, fg_color="transparent")
        upkeep_row.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
        self._secondary(upkeep_row, "ซิงก์เวลา Windows", self._sync_windows_time).pack(side="left")
        self._secondary(upkeep_row, "ตรวจสอบอัปเดตตอนนี้", self._check_updates).pack(
            side="left", padx=(theme.SPACE["sm"], 0)
        )
        self._secondary(
            upkeep_row, "เปิดการตั้งค่าเวลา Windows", self._open_time_settings
        ).pack(side="left", padx=(theme.SPACE["sm"], 0))

        self.connection_hint = ctk.CTkLabel(
            body, text="", font=self._font("caption"), text_color=theme.MUTED, anchor="w"
        )
        self.connection_hint.pack(fill="x", pady=(theme.SPACE["sm"], 0))

    def _page_settings(self, page: Any) -> None:
        """Schedule and Windows behaviour only - no connection fields here."""
        self._page_title(page, "ตั้งค่า", "ตารางการซิงก์อัตโนมัติและพฤติกรรมของโปรแกรม")

        body = ctk.CTkFrame(page, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=theme.SPACE["xl"], pady=(0, theme.SPACE["lg"]))
        body.grid_columnconfigure(0, weight=1)

        schedule = self._card(body, "ตารางการซิงก์อัตโนมัติ")
        schedule.grid(row=0, column=0, sticky="ew")
        grid = ctk.CTkFrame(schedule, fg_color="transparent")
        grid.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
        grid.grid_columnconfigure(1, weight=1)

        ctk.CTkSwitch(
            grid,
            text="ซิงก์อัตโนมัติ",
            variable=self.auto_var,
            progress_color=theme.BRAND,
            font=self._font("body"),
        ).grid(row=0, column=0, columnspan=2, sticky="w", pady=(theme.SPACE["xs"], theme.SPACE["sm"]))

        ctk.CTkLabel(
            grid, text="ทุก ๆ", text_color=theme.MUTED, font=self._font("body"), anchor="w",
            width=theme.LABEL_WIDTH,
        ).grid(row=1, column=0, sticky="w", pady=theme.SPACE["xs"])
        self.interval_menu = ctk.CTkOptionMenu(
            grid,
            values=["15 นาที", "30 นาที", "1 ชั่วโมง", "3 ชั่วโมง", "12 ชั่วโมง", "วันละครั้ง", "ไม่ใช้"],
            fg_color=theme.BRAND,
            button_color=theme.BRAND,
            button_hover_color=theme.BRAND_HOVER,
            font=self._font("body"),
        )
        self.interval_menu.grid(row=1, column=1, sticky="w", pady=theme.SPACE["xs"])

        ctk.CTkLabel(
            grid, text="หรือเวลาที่กำหนด", text_color=theme.MUTED, font=self._font("body"),
            anchor="w", width=theme.LABEL_WIDTH,
        ).grid(row=2, column=0, sticky="w", pady=theme.SPACE["xs"])
        self.times_entry = ctk.CTkEntry(
            grid, placeholder_text="08:00, 16:30", height=32,
            corner_radius=theme.RADIUS["sm"], border_color=theme.LINE,
        )
        self.times_entry.grid(row=2, column=1, sticky="ew", pady=theme.SPACE["xs"])
        ctk.CTkLabel(
            grid,
            text="ใส่เวลาแบบ 24 ชั่วโมง คั่นด้วยจุลภาค",
            text_color=theme.MUTED,
            font=self._font("caption"),
            anchor="w",
        ).grid(row=3, column=1, sticky="w")

        windows = self._card(body, "การทำงานร่วมกับ Windows")
        windows.grid(row=1, column=0, sticky="ew", pady=(theme.SPACE["md"], 0))
        wbody = ctk.CTkFrame(windows, fg_color="transparent")
        wbody.pack(fill="x", padx=theme.SPACE["lg"], pady=(0, theme.SPACE["md"]))
        ctk.CTkSwitch(
            wbody,
            text="เปิดโปรแกรมอัตโนมัติเมื่อเริ่มเครื่อง",
            variable=self.startup_var,
            progress_color=theme.BRAND,
            font=self._font("body"),
        ).pack(anchor="w", pady=theme.SPACE["xs"])
        ctk.CTkSwitch(
            wbody,
            text="ย่อลงถาดระบบเมื่อปิดหน้าต่าง (โปรแกรมยังทำงานต่อ)",
            variable=self.tray_var,
            progress_color=theme.BRAND,
            font=self._font("body"),
        ).pack(anchor="w", pady=theme.SPACE["xs"])

        save_row = ctk.CTkFrame(body, fg_color="transparent")
        save_row.grid(row=2, column=0, sticky="ew", pady=(theme.SPACE["md"], 0))
        self._primary(save_row, "บันทึกการตั้งค่า", self._save_settings).pack(side="left")
        self.settings_hint = ctk.CTkLabel(
            save_row, text="", font=self._font("caption"), text_color=theme.OK
        )
        self.settings_hint.pack(side="left", padx=theme.SPACE["md"])

    def _page_logs(self, page: Any) -> None:
        self._page_title(page, "บันทึกการทำงาน", "บันทึกล่าสุดของโปรแกรมในเครื่องนี้")

        body = ctk.CTkFrame(page, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=theme.SPACE["xl"], pady=(0, theme.SPACE["lg"]))
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(1, weight=1)

        controls = ctk.CTkFrame(body, fg_color="transparent")
        controls.grid(row=0, column=0, sticky="ew", pady=(0, theme.SPACE["sm"]))

        ctk.CTkLabel(
            controls, text="ระดับ", text_color=theme.MUTED, font=self._font("body")
        ).pack(side="left", padx=(0, theme.SPACE["sm"]))
        self.log_level = ctk.CTkOptionMenu(
            controls,
            values=["ทั้งหมด", "เฉพาะ ERROR", "ERROR + WARN"],
            width=160,
            fg_color=theme.SURFACE,
            text_color=theme.INK,
            button_color=theme.LINE,
            button_hover_color=theme.LINE,
            font=self._font("body"),
            command=lambda _: self._render_log(force=True),
        )
        self.log_level.pack(side="left")

        self._secondary(
            controls, "เปิดโฟลเดอร์บันทึก", lambda: webbrowser.open(str(data_dir() / "logs"))
        ).pack(side="left", padx=theme.SPACE["sm"])
        self._secondary(controls, "คัดลอกข้อผิดพลาดล่าสุด", self._copy_last_error).pack(side="left")
        self.log_hint = ctk.CTkLabel(
            controls, text="", font=self._font("caption"), text_color=theme.MUTED
        )
        self.log_hint.pack(side="left", padx=theme.SPACE["md"])

        self.log_box = ctk.CTkTextbox(
            body,
            height=240,
            font=ctk.CTkFont(family="Consolas", size=theme.TYPE["caption"]),
            fg_color=theme.SURFACE,
            border_width=0,
            corner_radius=theme.RADIUS["md"],
        )
        self.log_box.grid(row=1, column=0, sticky="nsew")

    # -- behaviour --------------------------------------------------------------

    def _copy_last_error(self) -> None:
        for line in reversed(self.bridge.latest_log(400).splitlines()):
            if "ERROR" in line:
                self.clipboard_clear()
                self.clipboard_append(line.strip())
                self.log_hint.configure(text="คัดลอกแล้ว", text_color=theme.OK)
                self.after(4000, lambda: self.log_hint.configure(text=""))
                return
        self.log_hint.configure(text="ไม่พบข้อผิดพลาดในบันทึกล่าสุด", text_color=theme.MUTED)
        self.after(4000, lambda: self.log_hint.configure(text=""))

    def _render_log(self, force: bool = False) -> None:
        content = self.bridge.latest_log()
        level = self.log_level.get()
        if level == "เฉพาะ ERROR":
            content = "\n".join(l for l in content.splitlines() if "ERROR" in l)
        elif level == "ERROR + WARN":
            content = "\n".join(l for l in content.splitlines() if "ERROR" in l or "WARN" in l)
        content = content or "ไม่มีบันทึกที่ตรงกับตัวกรอง"
        if force or content != self._last_log:
            self._last_log = content
            self.log_box.delete("1.0", "end")
            self.log_box.insert("1.0", content)
            self.log_box.see("end")

    def _load_settings_into_form(self) -> None:
        settings = self.bridge.settings()
        self.auto_var.set(bool(settings.get("autoSyncEnabled", True)))
        minutes = int(settings.get("syncIntervalMinutes", 60))
        if hasattr(self, "interval_menu"):
            self.interval_menu.set(
                {
                    0: "ไม่ใช้",
                    15: "15 นาที",
                    30: "30 นาที",
                    60: "1 ชั่วโมง",
                    180: "3 ชั่วโมง",
                    720: "12 ชั่วโมง",
                    1440: "วันละครั้ง",
                }.get(minutes, "1 ชั่วโมง")
            )
            self.times_entry.delete(0, "end")
            self.times_entry.insert(0, ", ".join(settings.get("dailyTimes", [])))
        self.startup_var.set(bool(settings.get("startWithWindows", True)))
        self.tray_var.set(bool(settings.get("minimiseToTray", True)))

        if not hasattr(self, "env_entries"):
            return

        # JHCIS settings come from the agent itself - the values it is actually
        # using, which may be the file in the data folder rather than .env.
        env = self.bridge.read_env()
        jhcis = self.bridge.jhcis_settings()
        current = {
            "JHCIS_DB_HOST": str(jhcis.get("host", "")) or env.get("JHCIS_DB_HOST", ""),
            "JHCIS_DB_PORT": str(jhcis.get("port", "")) or env.get("JHCIS_DB_PORT", ""),
            "JHCIS_DB_DATABASE": str(jhcis.get("database", "")) or env.get("JHCIS_DB_DATABASE", ""),
            "JHCIS_DB_USER": str(jhcis.get("user", "")) or env.get("JHCIS_DB_USER", ""),
            # The password is never read back out. Blank means "keep the one
            # already stored", so moving a server does not require retyping it.
            "JHCIS_DB_PASSWORD": "",
        }
        for key, entry in self.env_entries.items():
            entry.delete(0, "end")
            entry.insert(0, current.get(key, env.get(key, "")))
        if hasattr(self, "jhcis_hint"):
            self.jhcis_hint.configure(
                text="เว้นช่องรหัสผ่านไว้ = ใช้รหัสเดิม" if jhcis.get("hasPassword") else "",
                text_color=theme.MUTED,
            )

    def _save_settings(self) -> None:
        minutes = {
            "ไม่ใช้": 0,
            "15 นาที": 15,
            "30 นาที": 30,
            "1 ชั่วโมง": 60,
            "3 ชั่วโมง": 180,
            "12 ชั่วโมง": 720,
            "วันละครั้ง": 1440,
        }[self.interval_menu.get()]

        times = [
            part.strip()
            for part in self.times_entry.get().split(",")
            if len(part.strip()) == 5 and part.strip()[2] == ":"
        ]

        self.bridge.save_settings(
            {
                "autoSyncEnabled": bool(self.auto_var.get()),
                "syncIntervalMinutes": minutes,
                "dailyTimes": times,
                "startWithWindows": bool(self.startup_var.get()),
                "minimiseToTray": bool(self.tray_var.get()),
            }
        )
        message = set_autostart(bool(self.startup_var.get()))

        # The worker re-reads settings each tick, so only the schedule needs no
        # restart; it is restarted anyway because startup behaviour changed.
        self.bridge.stop_background()
        self.worker_error = self.bridge.start_background()

        self.settings_hint.configure(text=f"บันทึกแล้ว · {message}", text_color=theme.OK)
        self.after(6000, lambda: self.settings_hint.configure(text=""))

    def _save_connection(self) -> CommandResult:
        """
        Hands the JHCIS settings to the agent, which owns the file.

        The Central address is not written here. It used to be pushed into
        {app}\\.env, which a staff account cannot write, so the OSError was
        swallowed and the address the operator typed went nowhere - and the
        enrolment that followed used whatever the old file happened to say.
        It is passed to `enroll --url` instead, and the agent stores it in
        agent.config.json where it is writable and where it already belongs.
        """
        return self._persist_jhcis()

    def _persist_jhcis(self) -> CommandResult:
        """
        Sends the JHCIS fields to the agent, which owns the file and its
        permissions. An empty password box means "keep the one already saved".
        """
        values: dict[str, Any] = {
            "host": self.env_entries["JHCIS_DB_HOST"].get().strip(),
            "port": self.env_entries["JHCIS_DB_PORT"].get().strip() or 3306,
            "database": self.env_entries["JHCIS_DB_DATABASE"].get().strip() or "jhcisdb",
            "user": self.env_entries["JHCIS_DB_USER"].get().strip(),
        }
        password = self.env_entries["JHCIS_DB_PASSWORD"].get()
        if password:
            values["password"] = password
        # Omitting the key entirely is what tells the agent to keep the old one.
        return self.bridge.save_jhcis(values)

    def _test_jhcis(self) -> None:
        """Saves what is on screen, then asks the agent to connect to it."""
        self.jhcis_hint.configure(text="กำลังบันทึกและทดสอบ...", text_color=theme.MUTED)
        self.update_idletasks()

        saved = self._save_connection()
        if not saved.ok:
            self.jhcis_hint.configure(text=saved.output.strip()[:120], text_color=theme.DANGER)
            return

        result = self.bridge.run(["doctor"], timeout=120)
        if result.ok and "CONNECTED" in result.output:
            self.jhcis_hint.configure(text="เชื่อมต่อ JHCIS สำเร็จ", text_color=theme.OK)
            # Let the background worker pick up the new target immediately.
            self.bridge.stop_background()
            self.worker_error = self.bridge.start_background()
        else:
            tail = [line for line in result.output.splitlines() if line.strip()][-1:]
            self.jhcis_hint.configure(
                text=f"เชื่อมต่อไม่สำเร็จ: {tail[0][:100] if tail else 'ตรวจสอบ IP/พอร์ต'}",
                text_color=theme.DANGER,
            )

    # -- time and updates ------------------------------------------------------

    def _run_task(self, name: str) -> tuple[bool, str]:
        """
        Asks Windows to run one of the two tasks the installer registered.

        The names are literals in this file and the tasks' actions are fixed in
        the installer, so there is nothing here for a caller to steer: this
        cannot be talked into running an arbitrary program as SYSTEM. A member
        of staff signed in normally may not be allowed to start a task that
        runs as SYSTEM at all, which is fine - both tasks have their own
        schedule and will come round on their own.
        """
        try:
            result = subprocess.run(
                ["schtasks", "/Run", "/TN", name],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                timeout=30,
            )
            if result.returncode == 0:
                return True, ""
            return False, (result.stderr or result.stdout or "").strip()[:200]
        except Exception as error:  # pragma: no cover - depends on the machine
            return False, str(error)[:200]

    def _sync_windows_time(self) -> None:
        ok, detail = self._run_task("SDCAgentTimeSync")
        self.connection_hint.configure(
            text=(
                "สั่งซิงก์เวลา Windows แล้ว ระบบจะตรวจอีกครั้งในไม่กี่วินาที"
                if ok
                else f"สั่งซิงก์เวลาเองไม่ได้ ({detail}) ระบบจะซิงก์ให้อัตโนมัติภายในหนึ่งชั่วโมง"
            ),
            text_color=theme.OK if ok else theme.WARN,
        )

    def _check_updates(self) -> None:
        ok, detail = self._run_task("SDCAgentAutoUpdate")
        self.connection_hint.configure(
            text=(
                "กำลังตรวจสอบรุ่นใหม่ ถ้ามีจะดาวน์โหลดและติดตั้งให้เอง"
                if ok
                else f"สั่งตรวจอัปเดตเองไม่ได้ ({detail}) ระบบจะตรวจให้อัตโนมัติทุก 30 นาที"
            ),
            text_color=theme.OK if ok else theme.WARN,
        )

    def _open_time_settings(self) -> None:
        """Windows' own date and time page - we never edit those settings for them."""
        try:
            os.startfile("ms-settings:dateandtime")  # noqa: S606 - fixed URI
        except Exception:
            webbrowser.open("ms-settings:dateandtime")

    def _enroll(self) -> None:
        token = self.token_entry.get().strip()
        if not token:
            self.connection_hint.configure(text="กรุณากรอกรหัสลงทะเบียน", text_color=theme.DANGER)
            return
        url = self.env_entries["CENTRAL_API_URL"].get().strip()
        if not url:
            self.connection_hint.configure(text="กรุณากรอกที่อยู่ศูนย์กลาง", text_color=theme.DANGER)
            return
        self._save_connection()
        self._run_async(self.bridge.enroll_command(token, url), "กำลังลงทะเบียน...")

    def _action_buttons(self) -> list[ctk.CTkButton]:
        return [self.sync_button, self.verify_button, self.retry_button]

    def _run_async(self, args: list[str], busy_text: str) -> None:
        if self.busy:
            return

        # Anything that would move dispensing data is refused while the centre
        # has this สถานบริการ paused, and refused here rather than left to fail
        # later: the agent would decline it anyway, but a person watching would
        # see a run start and stop with no explanation. There is no override -
        # only the centre can lift a pause, and a button offering to try
        # anyway would be a button that does nothing.
        if args and args[0] in {"sync", "verify", "retry"}:
            notice = theme.paused_notice(self.bridge.status())
            if notice:
                self.sync_headline.configure(text=notice.splitlines()[0], text_color=theme.WARN)
                self.log_hint.configure(text=notice, text_color=theme.WARN)
                return

        self.busy = True
        for button in self._action_buttons():
            button.configure(state="disabled")
        self.sync_headline.configure(text=busy_text, text_color=theme.BRAND)

        def worker() -> None:
            result = self.bridge.run(args)
            self.messages.put(("done" if result.ok else "error", result.output.strip()))

        threading.Thread(target=worker, daemon=True).start()

    def _schedule_poll(self) -> None:
        self._refresh()
        self._watchdog()
        self.after(POLL_SECONDS * 1000, self._schedule_poll)

    def _watchdog(self) -> None:
        """
        Restarts the worker this tray started, when it stops working.

        Two failures need this and they look nothing like each other from
        outside. A worker can be alive with its process in the task list and
        quietly doing nothing, and a worker can exit and leave the tray sitting
        there with no worker at all. Neither used to be noticed: "the process
        exists" was all anybody checked, and a รพ.สต. stayed offline until
        somebody closed and reopened the program.

        It lives in the tray on purpose. A timer inside the worker cannot
        notice that the worker's own timers have stopped, and nothing inside a
        process that has exited can restart it. Only another process can.

        The decision is in theme.watchdog_decision so every awkward case - a
        machine waking from sleep, a worker that has only just started, an
        operator deliberately closing the program - can be checked without a
        window or a real stalled process.
        """
        now = datetime.now(timezone.utc)
        running = self.bridge.background_running()

        # Whatever killed it, this is the only process left to say so. Written
        # before the restart decision, so the log shows the death and the
        # recovery in that order.
        exited = self.bridge.consume_worker_exit()
        if exited is not None and self._worker_should_run:
            self.bridge.note("worker exited unexpectedly", exited)

        if running and self._worker_seen_at is None:
            self._worker_seen_at = now
        if not running:
            self._worker_seen_at = None
            self._worker_last_tick = None

        # A read that fails, or a file with no usable stamp, changes nothing:
        # the previous good stamp stands and keeps ageing. Only a valid stamp
        # replaces it.
        self._worker_last_tick = theme.remember_tick(
            self._worker_last_tick, self.bridge.status().get("lastWorkerTickAt"),
        )

        restart, reason = theme.watchdog_decision(
            child_running=running,
            should_run=self._worker_should_run,
            last_tick=self._worker_last_tick,
            now=now,
            first_seen=self._worker_seen_at,
            last_checked=self._watchdog_checked_at,
            restarts=self._watchdog_restarts,
        )
        self._watchdog_checked_at = now
        if not restart:
            return

        self._watchdog_restarts.append(now)
        self._worker_seen_at = None
        # The stamp belonged to the worker being replaced; the new one starts
        # with nothing and gets its own grace.
        self._worker_last_tick = None
        self.bridge.note(
            "watchdog restarting worker",
            {"reason": reason, "restartsInWindow": len(self._watchdog_restarts)},
        )
        # Only this tray's own child, by the handle it was started with - never
        # by image name, which would take down whatever else the clinic runs.
        self.bridge.stop_background()
        self.worker_error = self.bridge.start_background()
        self.log_hint.configure(
            text=f"{reason} เริ่มใหม่ให้แล้ว ครั้งที่ {len(self._watchdog_restarts)}",
            text_color=theme.WARN,
        )

    def _refresh(self) -> None:
        while not self.messages.empty():
            kind, output = self.messages.get()
            if kind == "version":
                # Not the result of a command the operator ran: it must not
                # clear the busy state or overwrite the headline.
                self._apply_version(output)
                continue
            self.busy = False
            tail = output.strip().splitlines()[-1] if output.strip() else ""
            if kind == "error":
                self.sync_headline.configure(text=f"ไม่สำเร็จ: {tail}"[:140], text_color=theme.DANGER)
            self._load_settings_into_form()

        status = self.bridge.status()
        state = self.bridge.state()
        credential = self.bridge.credential()
        settings = self.bridge.settings()
        pending, failed = self.bridge.queue_depth()

        if credential:
            self.facility_label.configure(
                text="{} · {} · pcucode {}".format(
                    credential.get("facilityCode", "-"),
                    credential.get("facilityName", "-"),
                    credential.get("expectedPcucode", "-"),
                )
            )
        else:
            self.facility_label.configure(text="ยังไม่ได้ลงทะเบียนกับศูนย์กลาง")

        # Every visible state comes from theme.py, so what the screen says and
        # what the tests assert cannot drift apart.
        for item in theme.system_status(status, credential, self.bridge.background_running(), self.worker_error):
            widgets = self.status_cards[item.key]
            colour = theme.TONE_COLOURS[item.tone]
            widgets["dot"].configure(text_color=colour)
            widgets["name"].configure(text=item.label)
            widgets["value"].configure(text=item.text, text_color=colour)
            widgets["detail"].configure(text=item.detail)

        view = theme.sync_view(status)
        if not self.busy:
            self.sync_headline.configure(
                text=view.headline[:140], text_color=theme.TONE_COLOURS[view.tone]
            )
        self.sync_range.configure(text=f"ช่วงวันที่รับบริการ  {view.range_text}")
        self.progress.set(view.progress)
        self.progress_percent.configure(text=view.percent_text)
        for (caption, value), (label, text) in zip(self.counter_labels, view.counters):
            caption.configure(text=label)
            value.configure(text=text)
        self.sync_timing.configure(
            text=(
                f"เริ่มเมื่อ {view.started_text} · ใช้เวลา {view.elapsed_text}"
                if view.active
                else f"เริ่มเมื่อ {view.started_text}"
            )
        )

        # Starting a second run would be refused by the agent's lock anyway;
        # saying so before the click is kinder than an error afterwards.
        blocked = self.busy or view.active
        for button in self._action_buttons():
            button.configure(state="disabled" if blocked else "normal")
        self.action_hint.configure(text=view.busy_reason if view.active else "")

        last_sync = state.get("lastSyncAt") or status.get("lastSyncAt")
        self.summary_labels["last_sync"].configure(
            text=theme.thai_datetime(last_sync) if last_sync else "ยังไม่เคยซิงก์"
        )
        # A service date, not a moment: 2026-08-08 means that day in the
        # hospital's records and must not be shifted by a timezone.
        self.summary_labels["watermark"].configure(text=state.get("lastSyncedVisitDate") or "-")
        self.summary_labels["next_sync"].configure(
            text=(
                "ปิดการซิงก์อัตโนมัติ"
                if not settings.get("autoSyncEnabled", True)
                else theme.next_sync_text(settings, state, status=status)
            )
        )

        self.detail_labels["phase"].configure(text=view.headline[:80])
        self.detail_labels["range"].configure(text=view.range_text)
        self.detail_labels["batch"].configure(text=status.get("batchRef") or "-")
        self.detail_labels["expected"].configure(text=theme.number(status.get("recordsExpected")))
        self.detail_labels["extracted"].configure(text=theme.number(status.get("recordsExtracted")))
        self.detail_labels["uploaded"].configure(text=theme.number(status.get("recordsUploaded")))
        self.detail_labels["accepted"].configure(text=theme.number(status.get("recordsAccepted")))
        self.detail_labels["rejected"].configure(text=theme.number(status.get("recordsRejected")))
        self.detail_labels["queue"].configure(
            text=f"{pending} ชุด" + (f" (ล้มเหลว {failed} ชุด)" if failed else "")
        )
        self.detail_labels["started"].configure(text=view.started_text)

        self.central_labels["enrolled"].configure(
            text="ลงทะเบียนแล้ว" if credential else "ยังไม่ได้ลงทะเบียน"
        )
        self.central_labels["facility"].configure(
            text=credential.get("facilityName", "-") if credential else "-"
        )
        self.central_labels["ack"].configure(
            text=theme.relative(status.get("centralAckAt"), datetime.now(timezone.utc))
        )

        # Both of these are pure view-models in theme.py, so the smoke test
        # covers every state without a window.
        now = datetime.now(timezone.utc)
        clock_item = theme.clock_status(status, now)
        update_item = theme.update_status(status, self.app_version, now)
        self.upkeep_labels["clock"].configure(
            text=clock_item.text, text_color=theme.TONE_COLOURS[clock_item.tone]
        )
        self.upkeep_labels["clock_detail"].configure(text=clock_item.detail)
        self.upkeep_labels["update"].configure(
            text=update_item.text, text_color=theme.TONE_COLOURS[update_item.tone]
        )
        self.upkeep_labels["update_detail"].configure(text=update_item.detail)
        latest = status.get("updateLatestVersion") or self.app_version
        self.upkeep_labels["versions"].configure(
            text=f"ปัจจุบัน {self.app_version} · ล่าสุด {latest}"
        )

        if self.current_page == "sync":
            recent = status.get("message") or ""
            error = status.get("lastError") or ""
            text = "\n".join(part for part in (recent, error) if part) or "ยังไม่มีผลการทำงานล่าสุด"
            if text != self.recent_box.get("1.0", "end").strip():
                self.recent_box.delete("1.0", "end")
                self.recent_box.insert("1.0", text)

        if self.current_page == "logs":
            self._render_log()

    # -- tray ------------------------------------------------------------------
    def _tray_image(self):  # pragma: no cover - visual only
        image = Image.new("RGB", (64, 64), BRAND)
        draw = ImageDraw.Draw(image)
        draw.ellipse((16, 16, 48, 48), fill="white")
        draw.ellipse((26, 26, 38, 38), fill=BRAND)
        return image

    def _start_tray(self) -> None:  # pragma: no cover - visual only
        menu = pystray.Menu(
            pystray.MenuItem("เปิดหน้าต่าง", lambda: self.after(0, self._show_window), default=True),
            pystray.MenuItem(
                "ซิงก์ข้อมูลเดี๋ยวนี้",
                lambda: self.after(0, lambda: self._run_async(["sync"], "กำลังซิงก์ข้อมูล...")),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("ออกจากโปรแกรม", lambda: self.after(0, self._quit)),
        )
        # Hovering the tray icon is the quickest way to check the version when
        # the window is closed, which is how it normally runs.
        tooltip = "\n".join([APP_NAME, f"เวอร์ชัน {self.app_version}"])
        self.tray_icon = pystray.Icon(APP_ID, self._tray_image(), tooltip, menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def _show_window(self) -> None:
        self.deiconify()
        self.lift()
        self.focus_force()

    def _resolve_version(self) -> None:
        """
        Asks the agent its version off the main thread and shows it.

        On a slow machine the first agent call takes a few seconds; the window
        must not wait for it, so it opens saying "..." and fills in when the
        answer arrives.
        """

        def worker() -> None:
            version = self.bridge.agent_version()
            self.messages.put(("version", version or "?"))

        threading.Thread(target=worker, daemon=True).start()

    def _apply_version(self, version: str) -> None:
        self.app_version = version
        label = f"เวอร์ชัน {version}"
        self.version_label.configure(text=label)
        self.title(f"{APP_NAME} - {label}")
        if self.tray_icon is not None:
            self.tray_icon.title = "\n".join([APP_NAME, label])

    def _on_close(self) -> None:
        if self.tray_var.get() and TRAY_AVAILABLE:
            self.withdraw()
        else:
            self._quit()

    def _quit(self) -> None:
        # Said before the worker is stopped, so a poll that lands mid-shutdown
        # does not helpfully start it again on the way out.
        self._worker_should_run = False
        self.bridge.stop_background()
        if self.tray_icon:
            self.tray_icon.stop()
        self.destroy()
        os._exit(0)


#: ชื่อเดียวกับ AppMutex ใน sdc-agent.iss - ตัวติดตั้งใช้ตรวจว่าโปรแกรมยังเปิดอยู่ไหม
#: ถ้าเปลี่ยนชื่อนี้ ต้องแก้ในไฟล์ .iss ให้ตรงกันด้วย
APP_MUTEX = "SDCAgentRunningMutex"


def _claim_single_instance() -> object | None:
    """
    จอง mutex ของ Windows ไว้ตลอดอายุโปรแกรม

    ทำสองอย่างพร้อมกัน: กันเปิดซ้อนหลายหน้าต่าง (ซึ่งจะแย่งกันเขียน status.json)
    และทำให้ตัวติดตั้งเวอร์ชันใหม่รู้ว่ายังมีตัวเก่าทำงานอยู่ แล้วขอปิดก่อนติดตั้ง
    """
    if os.name != "nt":
        return None
    import ctypes

    handle = ctypes.windll.kernel32.CreateMutexW(None, False, APP_MUTEX)
    if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        return None
    return handle


def main() -> None:
    start_in_tray = "--tray" in sys.argv
    # เก็บ handle ไว้ในตัวแปร local ของ main เพื่อไม่ให้ถูกปล่อยคืนก่อนโปรแกรมจบ
    mutex = _claim_single_instance()
    if mutex is None and os.name == "nt":
        # เปิดอยู่แล้ว - ไม่ต้องเปิดซ้ำ ผู้ใช้กดไอคอนในถาดระบบได้เลย
        return
    app = AgentApp(start_in_tray=start_in_tray)
    app.mainloop()


if __name__ == "__main__":
    main()
