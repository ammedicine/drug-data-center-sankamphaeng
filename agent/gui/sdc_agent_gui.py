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
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import customtkinter as ctk

try:  # tray icon is optional so the app still opens on a machine without it
    import pystray
    from PIL import Image, ImageDraw

    TRAY_AVAILABLE = True
except Exception:  # pragma: no cover - depends on the target machine
    TRAY_AVAILABLE = False

APP_NAME = "ศูนย์ข้อมูลการใช้ยา - โปรแกรมเชื่อมข้อมูล JHCIS"
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
    override = os.environ.get("AGENT_DATA_DIR")
    directory = Path(override) if override else app_dir() / "data"
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


@dataclass
class CommandResult:
    ok: bool
    output: str


class AgentBridge:
    """Runs the Node agent CLI and reads the files it writes."""

    def __init__(self) -> None:
        self.root = app_dir()
        self.background: subprocess.Popen[str] | None = None

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

    def _popen(self, args: list[str]) -> subprocess.Popen[str]:
        creation = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        return subprocess.Popen(
            self._command(args),
            cwd=str(self.root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creation,
        )

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
    def start_background(self) -> str | None:
        """Starts the worker; returns an error message instead of raising."""
        if self.background and self.background.poll() is None:
            return None
        try:
            self.background = self._popen(["run"])
            return None
        except Exception as error:
            self.background = None
            return f"เริ่มตัวทำงานเบื้องหลังไม่สำเร็จ: {error}"

    def stop_background(self) -> None:
        if self.background and self.background.poll() is None:
            self.background.terminate()
            try:
                self.background.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover
                self.background.kill()
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
        return read_json(app_dir() / "agent.config.json")

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
                readable.append(
                    f"{entry.get('ts', '')[11:19]}  {entry.get('level', '').upper():5}  "
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
    def __init__(self, start_in_tray: bool = False) -> None:
        super().__init__()
        ctk.set_appearance_mode("light")
        ctk.set_default_color_theme("green")

        self.bridge = AgentBridge()
        self.messages: queue.Queue[tuple[str, str]] = queue.Queue()
        self.tray_icon = None
        self.busy = False

        self.title(APP_NAME)
        self.geometry("880x620")
        self.minsize(820, 560)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self._build_header()
        self._build_tabs()
        self._load_settings_into_form()

        # The window must open even when the worker cannot start, otherwise the
        # operator has no way to fix the settings that caused it.
        self.worker_error = self.bridge.start_background()
        self._schedule_poll()

        if TRAY_AVAILABLE:
            self._start_tray()
        if start_in_tray:
            self.after(300, self.withdraw)

    # -- layout ----------------------------------------------------------------
    def _build_header(self) -> None:
        header = ctk.CTkFrame(self, fg_color=BRAND, corner_radius=0)
        header.pack(fill="x")

        ctk.CTkLabel(
            header,
            text="ศูนย์ข้อมูลการใช้ยา อำเภอสันกำแพง",
            text_color="white",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(side="left", padx=20, pady=(14, 2))

        self.facility_label = ctk.CTkLabel(
            header, text="", text_color="#d3f5f0", font=ctk.CTkFont(size=12)
        )
        self.facility_label.pack(side="left", padx=(0, 20), pady=(16, 2))

        self.connection_label = ctk.CTkLabel(
            header, text="กำลังตรวจสอบ...", text_color="white", font=ctk.CTkFont(size=12)
        )
        self.connection_label.pack(side="right", padx=20)

    def _build_tabs(self) -> None:
        self.tabs = ctk.CTkTabview(self, fg_color="#f6f8fa")
        self.tabs.pack(fill="both", expand=True, padx=16, pady=16)
        self.tab_status = self.tabs.add("สถานะการทำงาน")
        self.tab_settings = self.tabs.add("ตั้งค่า")
        self.tab_logs = self.tabs.add("บันทึกการทำงาน")

        self._build_status_tab()
        self._build_settings_tab()
        self._build_logs_tab()

    def _card(self, parent: Any, title: str) -> ctk.CTkFrame:
        card = ctk.CTkFrame(parent, fg_color="white", corner_radius=12)
        card.pack(fill="x", padx=4, pady=8)
        ctk.CTkLabel(
            card, text=title, font=ctk.CTkFont(size=13, weight="bold"), anchor="w"
        ).pack(fill="x", padx=16, pady=(12, 4))
        return card

    def _build_status_tab(self) -> None:
        card = self._card(self.tab_status, "สถานะปัจจุบัน")

        self.phase_label = ctk.CTkLabel(
            card, text="พร้อมทำงาน", font=ctk.CTkFont(size=15, weight="bold"), anchor="w"
        )
        self.phase_label.pack(fill="x", padx=16)

        self.progress = ctk.CTkProgressBar(card, height=14, progress_color=BRAND)
        self.progress.set(0)
        self.progress.pack(fill="x", padx=16, pady=(10, 4))

        self.progress_label = ctk.CTkLabel(
            card, text="ยังไม่มีการซิงก์", text_color=MUTED, font=ctk.CTkFont(size=12), anchor="w"
        )
        self.progress_label.pack(fill="x", padx=16, pady=(0, 14))

        info = self._card(self.tab_status, "ข้อมูลการซิงก์")
        grid = ctk.CTkFrame(info, fg_color="transparent")
        grid.pack(fill="x", padx=16, pady=(0, 14))
        self.info_labels: dict[str, ctk.CTkLabel] = {}
        rows = [
            ("last_sync", "ซิงก์สำเร็จล่าสุด"),
            ("watermark", "ข้อมูลถึงวันที่"),
            ("queue", "คิวรอส่ง"),
            ("worker", "ตัวทำงานเบื้องหลัง"),
        ]
        for index, (key, label) in enumerate(rows):
            ctk.CTkLabel(
                grid, text=label, text_color=MUTED, font=ctk.CTkFont(size=12), anchor="w", width=160
            ).grid(row=index, column=0, sticky="w", pady=3)
            value = ctk.CTkLabel(grid, text="-", font=ctk.CTkFont(size=12), anchor="w")
            value.grid(row=index, column=1, sticky="w", pady=3)
            self.info_labels[key] = value

        actions = ctk.CTkFrame(self.tab_status, fg_color="transparent")
        actions.pack(fill="x", padx=4, pady=(4, 0))

        self.sync_button = ctk.CTkButton(
            actions,
            text="ซิงก์ข้อมูลเดี๋ยวนี้",
            command=lambda: self._run_async(["sync"], "กำลังซิงก์ข้อมูล..."),
            fg_color=BRAND,
            hover_color=BRAND_HOVER,
            height=38,
        )
        self.sync_button.pack(side="left", padx=(0, 8))

        ctk.CTkButton(
            actions,
            text="ตรวจการเชื่อมต่อ JHCIS",
            command=lambda: self._run_async(["doctor"], "กำลังตรวจการเชื่อมต่อ..."),
            fg_color="white",
            text_color=BRAND,
            border_width=1,
            border_color="#e3e8ee",
            hover_color="#eefcfa",
            height=38,
        ).pack(side="left", padx=8)

        ctk.CTkButton(
            actions,
            text="ส่งข้อมูลที่ค้างอีกครั้ง",
            command=lambda: self._run_async(["retry"], "กำลังส่งข้อมูลที่ค้าง..."),
            fg_color="white",
            text_color=BRAND,
            border_width=1,
            border_color="#e3e8ee",
            hover_color="#eefcfa",
            height=38,
        ).pack(side="left", padx=8)

    def _build_settings_tab(self) -> None:
        scroll = ctk.CTkScrollableFrame(self.tab_settings, fg_color="transparent")
        scroll.pack(fill="both", expand=True)

        schedule = self._card(scroll, "ตารางการซิงก์อัตโนมัติ")
        body = ctk.CTkFrame(schedule, fg_color="transparent")
        body.pack(fill="x", padx=16, pady=(0, 14))

        self.auto_var = ctk.BooleanVar(value=True)
        ctk.CTkSwitch(
            body, text="ซิงก์อัตโนมัติ", variable=self.auto_var, progress_color=BRAND
        ).grid(row=0, column=0, columnspan=2, sticky="w", pady=(4, 10))

        ctk.CTkLabel(body, text="ทุก ๆ", text_color=MUTED, anchor="w").grid(
            row=1, column=0, sticky="w"
        )
        self.interval_menu = ctk.CTkOptionMenu(
            body,
            values=["15 นาที", "30 นาที", "1 ชั่วโมง", "3 ชั่วโมง", "12 ชั่วโมง", "วันละครั้ง", "ไม่ใช้"],
            fg_color=BRAND,
            button_color=BRAND,
            button_hover_color=BRAND_HOVER,
        )
        self.interval_menu.grid(row=1, column=1, sticky="w", padx=(8, 0), pady=4)

        ctk.CTkLabel(body, text="หรือเวลาที่กำหนด", text_color=MUTED, anchor="w").grid(
            row=2, column=0, sticky="w", pady=(10, 0)
        )
        self.times_entry = ctk.CTkEntry(body, placeholder_text="08:00, 16:30", width=240)
        self.times_entry.grid(row=2, column=1, sticky="w", padx=(8, 0), pady=(10, 0))
        ctk.CTkLabel(
            body,
            text="ใส่เวลาแบบ 24 ชั่วโมง คั่นด้วยจุลภาค เช่น 08:00, 16:30",
            text_color=MUTED,
            font=ctk.CTkFont(size=11),
            anchor="w",
        ).grid(row=3, column=1, sticky="w", padx=(8, 0))

        windows = self._card(scroll, "การทำงานบน Windows")
        wbody = ctk.CTkFrame(windows, fg_color="transparent")
        wbody.pack(fill="x", padx=16, pady=(0, 14))
        self.startup_var = ctk.BooleanVar(value=True)
        ctk.CTkSwitch(
            wbody,
            text="เปิดโปรแกรมอัตโนมัติเมื่อเริ่มเครื่อง",
            variable=self.startup_var,
            progress_color=BRAND,
        ).pack(anchor="w", pady=4)
        self.tray_var = ctk.BooleanVar(value=True)
        ctk.CTkSwitch(
            wbody,
            text="ย่อลงถาดระบบเมื่อปิดหน้าต่าง (โปรแกรมยังทำงานต่อ)",
            variable=self.tray_var,
            progress_color=BRAND,
        ).pack(anchor="w", pady=4)

        jhcis = self._card(scroll, "การเชื่อมต่อ JHCIS (เก็บไว้ในเครื่องนี้เท่านั้น)")
        jbody = ctk.CTkFrame(jhcis, fg_color="transparent")
        jbody.pack(fill="x", padx=16, pady=(0, 14))
        self.env_entries: dict[str, ctk.CTkEntry] = {}
        fields = [
            ("JHCIS_DB_HOST", "เครื่องฐานข้อมูล", "localhost"),
            ("JHCIS_DB_PORT", "พอร์ต", "3306"),
            ("JHCIS_DB_DATABASE", "ชื่อฐานข้อมูล", "jhcisdb"),
            ("JHCIS_DB_USER", "ผู้ใช้ (สิทธิ์อ่านอย่างเดียว)", "readonly"),
            ("JHCIS_DB_PASSWORD", "รหัสผ่าน", ""),
            ("CENTRAL_API_URL", "ที่อยู่ระบบศูนย์กลาง", "https://"),
        ]
        for index, (key, label, placeholder) in enumerate(fields):
            ctk.CTkLabel(jbody, text=label, text_color=MUTED, anchor="w", width=200).grid(
                row=index, column=0, sticky="w", pady=3
            )
            entry = ctk.CTkEntry(
                jbody,
                width=320,
                placeholder_text=placeholder,
                show="*" if key.endswith("PASSWORD") else "",
            )
            entry.grid(row=index, column=1, sticky="w", pady=3)
            self.env_entries[key] = entry

        enroll = self._card(scroll, "ลงทะเบียนกับระบบศูนย์กลาง")
        ebody = ctk.CTkFrame(enroll, fg_color="transparent")
        ebody.pack(fill="x", padx=16, pady=(0, 14))
        ctk.CTkLabel(
            ebody,
            text="ขอรหัสลงทะเบียน (enrollment token) จากผู้ดูแลระบบส่วนกลาง ใช้ได้ครั้งเดียว",
            text_color=MUTED,
            font=ctk.CTkFont(size=11),
            anchor="w",
        ).pack(anchor="w", pady=(0, 6))
        row = ctk.CTkFrame(ebody, fg_color="transparent")
        row.pack(fill="x")
        self.token_entry = ctk.CTkEntry(row, placeholder_text="ENR-...", width=380)
        self.token_entry.pack(side="left")
        ctk.CTkButton(
            row,
            text="ลงทะเบียน",
            width=120,
            fg_color=BRAND,
            hover_color=BRAND_HOVER,
            command=self._enroll,
        ).pack(side="left", padx=8)

        save_row = ctk.CTkFrame(scroll, fg_color="transparent")
        save_row.pack(fill="x", pady=(8, 16))
        ctk.CTkButton(
            save_row,
            text="บันทึกการตั้งค่า",
            command=self._save_settings,
            fg_color=BRAND,
            hover_color=BRAND_HOVER,
            height=38,
            width=170,
        ).pack(side="left")
        self.settings_hint = ctk.CTkLabel(save_row, text="", text_color=OK, anchor="w")
        self.settings_hint.pack(side="left", padx=12)

    def _build_logs_tab(self) -> None:
        self.log_box = ctk.CTkTextbox(self.tab_logs, font=ctk.CTkFont(family="Consolas", size=11))
        self.log_box.pack(fill="both", expand=True, padx=4, pady=4)

        row = ctk.CTkFrame(self.tab_logs, fg_color="transparent")
        row.pack(fill="x", padx=4, pady=(0, 4))
        ctk.CTkButton(
            row,
            text="เปิดโฟลเดอร์ข้อมูล",
            command=lambda: webbrowser.open(str(data_dir())),
            fg_color="white",
            text_color=BRAND,
            border_width=1,
            border_color="#e3e8ee",
            hover_color="#eefcfa",
        ).pack(side="left")

    # -- behaviour --------------------------------------------------------------
    def _load_settings_into_form(self) -> None:
        settings = self.bridge.settings()
        self.auto_var.set(bool(settings.get("autoSyncEnabled", True)))
        minutes = int(settings.get("syncIntervalMinutes", 60))
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

        env = self.bridge.read_env()
        for key, entry in self.env_entries.items():
            entry.delete(0, "end")
            entry.insert(0, env.get(key, ""))

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
        self.bridge.write_env({key: entry.get().strip() for key, entry in self.env_entries.items()})
        message = set_autostart(bool(self.startup_var.get()))

        # The worker re-reads settings each tick, but JHCIS credentials are read
        # at start-up, so a restart is the honest way to apply them.
        self.bridge.stop_background()
        self.worker_error = self.bridge.start_background()

        self.settings_hint.configure(text=f"บันทึกแล้ว · {message}", text_color=OK)
        self.after(6000, lambda: self.settings_hint.configure(text=""))

    def _enroll(self) -> None:
        token = self.token_entry.get().strip()
        if not token:
            self.settings_hint.configure(text="กรุณากรอกรหัสลงทะเบียน", text_color=DANGER)
            return
        self._run_async(["enroll", "--token", token], "กำลังลงทะเบียน...")

    def _run_async(self, args: list[str], busy_text: str) -> None:
        if self.busy:
            return
        self.busy = True
        self.sync_button.configure(state="disabled")
        self.phase_label.configure(text=busy_text, text_color=BRAND)

        def worker() -> None:
            result = self.bridge.run(args)
            self.messages.put(("done" if result.ok else "error", result.output.strip()))

        threading.Thread(target=worker, daemon=True).start()

    def _schedule_poll(self) -> None:
        self._refresh()
        self.after(POLL_SECONDS * 1000, self._schedule_poll)

    def _refresh(self) -> None:
        while not self.messages.empty():
            kind, output = self.messages.get()
            self.busy = False
            self.sync_button.configure(state="normal")
            tail = output.strip().splitlines()[-1] if output.strip() else ""
            if kind == "error":
                self.phase_label.configure(text=f"ไม่สำเร็จ: {tail}"[:120], text_color=DANGER)
            else:
                self.phase_label.configure(text=tail[:120] or "ทำงานเสร็จแล้ว", text_color=OK)
            self._load_settings_into_form()

        status = self.bridge.status()
        state = self.bridge.state()
        credential = self.bridge.credential()
        pending, failed = self.bridge.queue_depth()

        if credential:
            self.facility_label.configure(
                text=f"{credential.get('facilityCode', '')} · {credential.get('facilityName', '')}"
            )
        else:
            self.facility_label.configure(text="ยังไม่ได้ลงทะเบียนกับศูนย์กลาง")

        jhcis = status.get("jhcisConnected")
        central = status.get("centralConnected")
        marks = {
            True: "เชื่อมต่อแล้ว",
            False: "ไม่ได้เชื่อมต่อ",
            None: "ยังไม่ทราบ",
        }
        self.connection_label.configure(
            text=f"JHCIS: {marks[jhcis]}   ·   ศูนย์กลาง: {marks[central]}"
        )

        total = int(status.get("total") or 0)
        uploaded = int(status.get("uploaded") or 0)
        extracted = int(status.get("extracted") or 0)
        phase = status.get("phase", "idle")

        if not self.busy:
            phase_text = {
                "idle": "พร้อมทำงาน",
                "starting": "กำลังเตรียมข้อมูล",
                "extracting": "กำลังอ่านข้อมูลจาก JHCIS",
                "uploading": "กำลังส่งข้อมูลขึ้นศูนย์กลาง",
                "done": status.get("message") or "ซิงก์สำเร็จ",
                "error": status.get("message") or "พบข้อผิดพลาด",
            }.get(phase, phase)
            colour = {"error": DANGER, "done": OK}.get(phase, BRAND)
            self.phase_label.configure(text=phase_text, text_color=colour)

        if total > 0:
            done = max(uploaded, min(extracted, total))
            self.progress.set(min(1.0, done / total))
            self.progress_label.configure(
                text=(
                    f"อ่านแล้ว {extracted:,} / {total:,} รายการ · "
                    f"ส่งขึ้นศูนย์กลางแล้ว {uploaded:,} รายการ"
                )
            )
        else:
            self.progress.set(0)
            self.progress_label.configure(text="ยังไม่มีการซิงก์ในรอบนี้")

        self.info_labels["last_sync"].configure(
            text=(state.get("lastSyncAt") or status.get("lastSyncAt") or "ยังไม่เคยซิงก์")[:19].replace("T", " ")
        )
        self.info_labels["watermark"].configure(text=state.get("lastSyncedVisitDate") or "-")
        self.info_labels["queue"].configure(
            text=f"{pending} ชุด" + (f" (ล้มเหลว {failed} ชุด)" if failed else "")
        )
        self.info_labels["worker"].configure(
            text=(
                "กำลังทำงาน"
                if self.bridge.background_running()
                else (self.worker_error or "หยุดอยู่")
            )
        )

        if self.tabs.get() == "บันทึกการทำงาน":
            content = self.bridge.latest_log()
            if content != self.log_box.get("1.0", "end").strip():
                self.log_box.delete("1.0", "end")
                self.log_box.insert("1.0", content)
                self.log_box.see("end")

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
        self.tray_icon = pystray.Icon(APP_ID, self._tray_image(), APP_NAME, menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def _show_window(self) -> None:
        self.deiconify()
        self.lift()
        self.focus_force()

    def _on_close(self) -> None:
        if self.tray_var.get() and TRAY_AVAILABLE:
            self.withdraw()
        else:
            self._quit()

    def _quit(self) -> None:
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
