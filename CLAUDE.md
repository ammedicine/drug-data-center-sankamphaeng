# CLAUDE.md — คู่มือเตือนตัวเองก่อนลงมือทุกครั้ง

> ไฟล์นี้คือ working memory ของ agent ที่พัฒนา repo นี้
> **อ่านไฟล์นี้ก่อนเริ่มงานทุกครั้ง และอัปเดตทุกครั้งที่จบ phase**

## 0. กฎเหล็กของการทำงาน (ตัวเราเอง)

1. **อ่านโค้ดเดิมก่อนเสมอ** — `grep`/`ls` หา module ที่มีอยู่ก่อนจะเขียนใหม่
2. **ห้ามสร้างไฟล์ใหม่พร่ำเพรื่อ** — ถ้ามีไฟล์ที่รับผิดชอบเรื่องนั้นอยู่แล้ว ให้แก้ไฟล์นั้น
   - logic ฝั่ง web ทั้งหมดอยู่ใน `src/lib/*` (auth, db, rbac, api)
   - logic ฝั่ง agent ทั้งหมดอยู่ใน `agent/src/*`
   - เอกสารมีแค่ที่ระบุใน §6 ห้ามเพิ่มไฟล์ .md ใหม่โดยไม่จำเป็น
3. **ห้ามเดา schema JHCIS** — ตรวจจาก DB จริงเสมอ (ผลตรวจอยู่ §3)
4. **JHCISDB = READ ONLY** ห้าม INSERT/UPDATE/DELETE/DDL
5. **ห้าม hardcode / commit secret** ทุกชนิด ใช้ `.env` + `.env.example`
6. **ห้ามเชื่อ facility_id จาก client** — derive จาก session (web) หรือ agent ที่ authenticate แล้ว (API)
7. ก่อนปิดงาน: `npm run lint` → `npm run typecheck` → `npm test` → `npm run build`
8. อ่าน `PROJECT_SPEC.md` + `JHCIS_INTEGRATION.md` + `AGENTS.md` เป็น requirement ที่ authoritative

## 1. Architecture (ห้ามละเมิด)

```
JHCISDB (LAN, read-only) → Local Agent (outbound only) → HTTPS + HMAC
   → Central API (Next.js on Vercel) → TiDB Cloud → Web Dashboard
```

ห้าม: Browser→JHCISDB, Central→JHCISDB, inbound port เข้า รพ.สต.

## 1.5 หน้าโปรแกรมของ Agent (Windows)

```
agent/gui/sdc_agent_gui.py   หน้าจอ CustomTkinter + ไอคอนถาดระบบ (pystray)
agent/gui/theme.py           design token + ตัวแปลงสถานะเป็นสิ่งที่หน้าจอแสดง (pure)
agent/gui/smoke_test.py      ทดสอบตรรกะโดยไม่เปิดหน้าต่าง (ใช้ตอน desktop ล็อก/CI)
agent/installer/build.ps1    bundle agent -> node runtime -> PyInstaller -> Inno Setup
agent/installer/sdc-agent.iss สคริปต์ Inno Setup (autostart, ProgramData, uninstall)
```

- หน้าจอ **ไม่มีตรรกะดึงข้อมูล** เป็นแค่ตัวสั่งงาน `agent` (Node) และอ่านไฟล์สถานะ
- ไฟล์ที่เป็นสะพานระหว่างสองฝั่ง: `data/settings.json` (ตารางเวลา) กับ `data/status.json`
  (เฟส/ความคืบหน้า เขียนแบบ temp+rename ทุกครั้ง)
- เครื่องปลายทางไม่ต้องมี Node/Python เพราะตัวติดตั้งแนบ `node.exe` + `agent.js` + exe ของหน้าจอ
- Inno Setup 6 ติดตั้งแล้วที่ `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`
  **build ตัวติดตั้งจริงได้แล้ว** (ทดสอบครั้งแรกสำเร็จ 2026-09-05 = `SDCAgent-Setup-1.0.1.exe` 38.6 MB)
- ผลลัพธ์ build อยู่ที่ `agent/build/` (ชิ้นส่วน) และ `agent/installer/output/` (ตัวติดตั้ง) — gitignore แล้ว

### บทเรียนจากการ build ครั้งแรก (อย่าให้เกิดซ้ำ)
1. **`.ps1` และ `.iss` ต้องเป็น UTF-8 *มี BOM*** — Windows PowerShell 5.1 อ่านไฟล์ที่ไม่มี BOM
   เป็น ANSI ทำให้ข้อความไทยเพี้ยนจนวงคำพูดพัง (`The string is missing the terminator`)
2. **stderr ของ native tool ≠ error** — PyInstaller/esbuild/ISCC พิมพ์ progress ทาง stderr
   พอ `$ErrorActionPreference = "Stop"` จะกลายเป็น NativeCommandError ทั้งที่ exit code = 0
   ใช้ helper `Invoke-Native { } "ชื่อ"` ที่ตัดสินจาก `$LASTEXITCODE` เท่านั้น
3. **เวอร์ชันต้องใช้ `git describe --tags --abbrev=0`** ไม่ใช่ `--dirty` เพราะได้ `1.0.1-dirty`
   ซึ่งใช้เป็น VersionInfo ของ Windows ไม่ได้ (script เตือนแทนถ้า tree ไม่ตรง tag)
4. **`{commonstartup}` ไม่ใช่ `{userstartup}`** — ตัวติดตั้งรันด้วยสิทธิ์ผู้ดูแล ถ้าใช้ per-user
   ทางลัดจะไปอยู่ Startup ของบัญชีผู้ดูแล เจ้าหน้าที่ล็อกอินแล้วโปรแกรมไม่เปิดเอง

### การแจกตัวติดตั้ง (repo เป็น private ตั้งแต่ 2026-09-05)
- โค้ดปิดหมด แต่ผู้ใช้/คนภายนอกโหลดตัวติดตั้งได้ที่ **`/download/agent`** (ไม่ต้องล็อกอิน)
  route นี้ดึงไฟล์จาก GitHub Release ด้วย `GITHUB_TOKEN` ฝั่ง server แล้ว stream ต่อ
  -> token ไม่เคยถึง browser และ route **ไม่รับพารามิเตอร์ใด ๆ** จึงชี้ไป repo/ไฟล์อื่นไม่ได้
- หน้า `/sync` มีการ์ดบอกเวอร์ชัน (git tag), ขนาดไฟล์, วันที่เผยแพร่ + ปุ่มดาวน์โหลด
- ชื่อไฟล์ต้องเป็น `SDCAgent-Setup-<version>.exe` (pattern อยู่ใน `agent-release.ts`)
- ออกเวอร์ชันใหม่: `git tag v1.0.2` -> `agent\installeruild.ps1` (อ่านเวอร์ชันจาก git tag เอง)
  -> `gh release create v1.0.2 <setup.exe>` — ขั้นตอนเต็มอยู่ใน `.NOTES` ของ build.ps1

### การอัปเกรดทับเวอร์ชันเก่า (ทำในตัวติดตั้งแล้ว)
1. `taskkill /F /T /IM SDCAgent.exe` ปิดทั้ง tray และ node.exe ที่เป็นลูก
2. ลบ scheduled task เก่าถ้ามี
3. รัน uninstaller ของเวอร์ชันเดิมแบบ `/VERYSILENT` แล้วค่อยวางไฟล์ใหม่
4. **ห้ามแตะ `%ProgramData%\SDCAgent`** (คิวที่ยังส่งไม่สำเร็จ + credential)
5. **ห้ามเปลี่ยน `AppId`** ใน .iss ไม่งั้นเวอร์ชันเก่าจะค้างคู่กับตัวใหม่ กลายเป็น agent 2 ตัว
### โฟลเดอร์ข้อมูลของ agent (บทเรียน 2026-09-05)
- **ห้ามใส่ `AGENT_DATA_DIR=./data` ใน `.env.example`** เพราะตัวติดตั้ง copy ไฟล์นี้ไปเป็น `.env`
  ใน Program Files -> agent อ่านแล้วชี้กลับมาที่โฟลเดอร์โปรแกรม ซึ่ง**ผู้ใช้ทั่วไปเขียนไม่ได้**
  (ที่เครื่อง dev ไม่เจอเพราะรันเป็น admin) เว้นค่าว่างไว้เสมอ
- ค่าเริ่มต้นเมื่อไม่ตั้ง `AGENT_DATA_DIR` = `%ProgramData%\SDCAgent` (ทั้งฝั่ง Node และ GUI)
  ต้องแก้ให้ตรงกันทั้ง `agent/src/config.ts` และ `gui/sdc_agent_gui.py`
- `agent/.env` ของ dev ยังตั้ง `./data` ได้ (gitignore อยู่แล้ว) และ test ตั้ง env เอง

### เปลี่ยนปลายทาง JHCISDB จากหน้าจอ (ย้ายวง LAN / ย้ายเครื่อง server)
- ตั้งได้ที่แท็บ "ตั้งค่า" -> การเชื่อมต่อ JHCIS -> ปุ่ม **บันทึกแล้วทดสอบการเชื่อมต่อ**
- **ห้ามเขียนลง `.env` อีก** — `.env` อยู่ใน Program Files ผู้ใช้ทั่วไปเขียนไม่ได้
  ของเดิมจึงดูเหมือนบันทึกสำเร็จแต่ค่าไม่เปลี่ยนจริง
- ค่าใหม่เก็บที่ `%AGENT_DATA_DIR%\jhcis.json` (ACL เหมือน agent.config.json) และ
  **ทับค่าใน `.env` เสมอ** (`jhcisConfig()` อ่าน override ก่อน)
- หน้าจอไม่ได้เขียนไฟล์เอง แต่เรียก `agent jhcis --set` แล้วส่ง JSON ทาง **stdin**
  (ไม่ส่งทาง argv เพราะรหัสผ่านจะโผล่ใน process list) — `agent jhcis` อ่านค่าปัจจุบันแบบปิดรหัสผ่าน
- **เว้นช่องรหัสผ่านว่าง = ใช้รหัสเดิม** (ย้าย IP โดยไม่ต้องพิมพ์รหัสใหม่)
- `gui/smoke_test.py` ตรวจ save/load รอบนี้ให้ด้วย รันได้โดยไม่ต้องเปิดหน้าต่าง

### หน้าจอ Agent (redesign 2026-09-06)
- โครงเป็น **sidebar ซ้าย + เนื้อหาขวา** 5 หน้า: ภาพรวม · การซิงก์ · การเชื่อมต่อ · ตั้งค่า · บันทึก
- **`gui/theme.py` เป็นที่เดียวที่กำหนด** ระยะห่าง (4/8/12/16/24/32), ขนาดตัวอักษร, สี, ขนาดหน้าต่าง
  ห้าม hardcode padding/สี/ความกว้างใน `sdc_agent_gui.py` อีก
- **ตรรกะว่าจอจะแสดงอะไร อยู่ใน theme.py ทั้งหมด** (`system_status`, `sync_view`, `next_sync_text`)
  เป็น pure function -> `smoke_test.py` ตรวจได้ทุกสถานะโดยไม่ต้องเปิดหน้าต่าง (เครื่อง build ไม่มีจอ)
- ขนาดหน้าต่าง 1100x720 · **ต่ำสุด 960x700** (ไม่ใช่ 640 เพราะวัดจริงแล้วหน้าภาพรวมสูง 626px
  ถ้าต่ำกว่านี้จะโดนตัด) — เปลี่ยนเมื่อไรต้องวัดใหม่
- สี 4 โทนเท่านั้น: เขียว=ปกติ · เหลือง=ข้อมูลเก่า/กำลัง retry · แดง=ผิดพลาด · เทา=ยังไม่ทราบ
- progress คิดจาก **accepted+rejected / expected** ไม่ใช่จำนวนที่อ่านได้ เพราะการอ่านนำการส่งเสมอ
  ถ้าใช้ยอดอ่าน หลอดจะเต็ม 100% ทั้งที่ข้อมูลยังส่งไม่หมด
- ปุ่มที่ทำให้ซิงก์ซ้อนจะถูก disable พร้อมบอกเหตุผล เมื่อ `syncPhase` อยู่ใน READING/UPLOADING/VERIFYING
- PyInstaller ต้องมี `--paths gui --hidden-import theme` ไม่งั้น exe จะหา theme ไม่เจอ

- GUI จอง mutex `SDCAgentRunningMutex` = ตัวเดียวกับ `AppMutex` ใน .iss (กันเปิดซ้อน + ให้ installer รู้ว่ายังเปิดอยู่)

## 2. โครงสร้าง repo (คุมให้อยู่แค่นี้)

```
/                     Next.js 15 App Router (Central Web + Central API) — deploy Vercel
  src/app/(auth)/     login
  src/app/(app)/      dashboard, reports, admin  (protected)
  src/app/api/agent/  Agent API (HMAC)
  src/lib/db/         drizzle schema + client   ← schema กลางอยู่ที่ schema.ts ไฟล์เดียว
  src/lib/auth/       session, password, rbac, facility scope
  src/lib/agent-auth/ HMAC verify, nonce/replay, enrollment
  src/lib/services/   business logic (usage report, sync ingest, audit)
  src/components/ui/  design system (PageHeader, StatCard, DataTable, ...)
  drizzle/            migrations (generated)
agent/                Local Agent (Node + TS, Windows service)
  src/jhcis/          adapter: connection, schema-inspector, repositories, extractor
  src/queue/          SQLite offline queue
  src/central/        HTTPS client (HMAC signing)
  src/cli.ts          doctor | enroll | sync | run
```

## 3. JHCIS schema ที่ **ตรวจจาก DB จริง** แล้ว (localhost:3333, MySQL 5.6.45, jhcisdb)

ข้อมูลจริงเก็บเป็น UTF-8 (ยืนยันด้วย HEX) → client ต้องใช้ **`charset: utf8_general_ci`**

> **แก้ความเข้าใจผิดเดิม (2026-09-09)** เคยเขียนว่าให้ใช้ `utf8mb3` — **ใช้ไม่ได้**
> MySQL 5.1 ไม่รู้จักชื่อ `utf8mb3_general_ci` และ **ไม่มี `utf8mb4` เลย**
> ของจริงที่เจอ: agent ขอ `utf8mb4_general_ci` -> driver ไม่ error แต่ session ค้างที่
> ค่าเริ่มต้นของ server คือ **latin1** -> server แปลงอักษรไทยเป็น `?` ตั้งแต่ก่อนส่ง
> ข้อมูลจึงหายที่ต้นทาง กู้ไม่ได้ (ชื่อยาใน Central เสีย 2,919/14,772 รายการ)
> `utf8_general_ci` ใช้ได้ตั้งแต่ **5.1.73 ถึง 8.4.3** (MySQL 8 map เป็นตระกูล utf8mb3)
> ทดสอบกับ server จริงทั้งสองรุ่นแล้ว และ `charsetReport()` จะตรวจ session ซ้ำหลังต่อ
> ถ้าไม่ใช่ตระกูล utf8 จะสั่ง `SET NAMES utf8` (เฉพาะ session ไม่แตะ JHCIS) แล้วตรวจใหม่
> **record_key ไม่กระทบ** เพราะสร้างจาก facility|pcucode|visitNo|drugCode ซึ่งเป็น ASCII

### backlog: JHCIS LEGACY CHARSET EXTENSION (ยังไม่ทำ — v1.1.8+)
ยังไม่มีหลักฐานว่ามี รพ.สต. ใดใช้คอลัมน์ tis620 จริง ถ้าเจอเมื่อไรค่อยทำ:
TIS-620 / Windows-874 · fallback อ่าน raw byte เมื่อ metadata ประกาศผิด ·
iconv-lite + การ bundle เข้า PyInstaller · เมทริกซ์ MySQL 5.5/5.7 จริง ·
การรักษาอักขระ 4 ไบต์แบบ capability-aware

### `visitdrug` (การจ่ายยา) — PK `(pcucode, visitno, drugcode)`
| column | type | ใช้ทำอะไร |
|---|---|---|
| pcucode | char(5) | รหัสสถานบริการ (facility ต้นทาง) |
| visitno | int(11) | อ้างอิง visit |
| drugcode | char(24) | อ้างอิง cdrug |
| **unit** | int(11) | **จำนวนที่จ่าย (quantity)** ← ชื่อคอลัมน์คือ `unit` ไม่ใช่ quantity |
| dose | varchar(100) | วิธีใช้ |
| clinic, costprice, realprice, dentalcode, doctor1..3 | | ไม่ส่งขึ้น Central (ไม่จำเป็น) |
| dateupdate | datetime | **ไม่น่าเชื่อถือ**: max = 2026-01-14 ขณะที่ visitdate ถึง 2026-08-08 |

**ไม่มี** column วันที่จ่ายใน visitdrug → ต้อง JOIN `visit.visitdate`
**ไม่มี** column หน่วยนับใน visitdrug → หน่วยมาจาก `cdrug.unitsell` (fallback `unitusage`)

### `visit` — PK `(pcucode, visitno)`
ใช้แค่ `pcucode, visitno, visitdate` (+`dateupdate`) เท่านั้น
**ห้ามดึง** pid, symptoms, weight/height/pressure, rightno, ชื่อ/บัตร ปชช. → Data Privacy §20

### `cdrug` (drug master) — PK `drugcode`
ใช้: `drugcode, drugname, drugnamethai, druggenericname, drugtype, drugtypesub, drugflag, unitsell, unitusage`
drugtype ที่พบจริง: 02(5468) 01(656) 11(619) 05(182) 03(178) 10(146) 06(95) 91(34) 07(24) 04(8)
ความหมายที่ยืนยัน: 01=ยาแผนปัจจุบัน, 05=วัคซีน, 10=สมุนไพร | drugflag 1=ใช้งาน 2=ปิด

### Facility identity ในแต่ละ JHCISDB (ยืนยันจาก DB จริง)
- **1 สถานบริการ = 1 JHCISDB** แยกกันชัดเจน (`SELECT DISTINCT pcucode FROM visitdrug` -> `05957` ค่าเดียว)
- รหัสของตัวเองอ่านจาก `office.offid` โดย **ข้ามแถว placeholder `0000x`** (dev DB: `05957`, `offid506=50130402`)
- ชื่อสถานบริการอ่านจาก `chospital.hosname` โดย join `hoscode = offid` (dev DB: "รพ.สต.บ้านหนองโค้ง ม.8 ต.ท่าวังตาล อ.สันกำแพง")
- Agent ต้อง auto-detect pcucode -> ส่งไป Central -> **Central ตรวจว่าตรงกับ `facilities.jhcis_pcucode` ของ facility ที่ผูกกับ agent** ถ้าไม่ตรงต้อง reject ทั้ง batch (กัน agent ส่งข้ามสถานบริการ)
- extraction query ต้อง `WHERE pcucode = ?` เสมอ ห้ามดึงข้ามรหัส

### เวอร์ชันเป้าหมาย
- Production ที่ใช้จริง = **JHCIS V5.1** (dev DB ตัวนี้ก็คือ V5.1 บน MySQL 5.6)
- ยังต้องมี capability detection ไว้รองรับ version ใหม่กว่า (`supportsQuantity`, `supportsDrugType`, ...) ตาม JHCIS_INTEGRATION.md §28
- MySQL 5.6 -> **ห้ามใช้ CTE / window function / JSON functions** ใน query ฝั่ง JHCIS

### ปริมาณข้อมูล (dev DB)
cdrug 7,410 / visitdrug 265,787 / visit 130,422 / pcucode เดียว = `05957` / visitdate 1972-12-24 → 2026-08-08

### ความครบถ้วนของ visitdrug (ตรวจแล้ว 2026-09-04)
ลำดับการทำงานจริงของ JHCIS: เปิดคิว -> ได้ `visit.visitno` -> คียาให้คนนั้น -> แถวยาไปอยู่ `visitdrug`
(แต่ละแถวมี visitno กำกับ และ **ไม่ได้เรียงลำดับ** ในตาราง)

| ตรวจ | ผล |
|---|---|
| `visitdrug` ทั้งหมด (pcucode 05957) | 265,787 |
| JOIN `visit` ติด | 265,769 |
| **ไม่มี visit คู่กัน (visit ถูกลบ)** | **18** |

- เดิมใช้ `JOIN visit` แบบ INNER -> 18 แถวนั้นหายเงียบ ๆ **แก้แล้วเป็น LEFT JOIN**
- แถวที่ไม่มี visit ใช้วันที่จาก `DATE(vd.dateupdate)` แทน และตั้งธง `drug_usage.visit_missing = 1`
- `agent doctor` แสดงหัวข้อ "ความครบถ้วนของข้อมูล visitdrug" ให้เห็นตัวเลขนี้ทุกครั้ง
- **หลักการ: ยึด `visitdrug` เป็นตัวตั้ง ส่วน `visit` เป็นแค่ตัวให้วันที่ ห้ามใช้เป็นตัวกรองทิ้งแถว**

### การตรวจนับก่อน-หลังทุกครั้งที่ซิงก์ (กันข้อมูลตกหล่น)
1. **ก่อนซิงก์**: `countUsage()` นับจำนวนแถวในช่วงที่จะซิงก์ ส่งไปเปิด batch เป็น `records_read`
2. **หลังซิงก์**: เรียก `/api/agent/sync/audit` นับแถวที่ศูนย์กลางมีจริงในช่วงเดียวกัน
3. ถ้าน้อยกว่าที่ควรมี -> หาเดือนที่ไม่ตรง แล้ว **ซิงก์ซ้ำเฉพาะเดือนนั้น** (รอบซ่อมตั้ง `reconcile:false` กันวนซ้ำ)
4. นับใหม่อีกครั้ง ถ้ายังขาด -> batch เป็น **FAILED** พร้อมตัวเลข และ **ไม่เลื่อน watermark**
   (ครั้งถัดไปจะซิงก์ช่วงเดิมซ้ำ ไม่ปล่อยให้ข้อมูลหายเงียบ)
5. ส่วนต่างที่เท่ากับจำนวนแถวที่ถูกปฏิเสธ (เช่น drugcode ว่าง) ไม่นับเป็นข้อมูลหาย

> เดิมระบบปิด batch เป็น COMPLETED เมื่อคิวว่างเท่านั้น จึงเคยรายงานว่าสำเร็จทั้งที่ปลายทางขาด 500 แถว

### การตรวจสอบและซ่อมข้อมูลเอง (`agent verify`)
- เทียบจำนวนแถว **รายเดือน** ระหว่าง JHCIS กับ Central (`POST /api/agent/sync/audit`)
- เดือนไหนไม่ตรง -> ซิงก์ใหม่เฉพาะเดือนนั้น แล้ว **ตรวจซ้ำอีกรอบ**
- เดือนที่ยังไม่ตรงหลังซ่อม = แถวที่ต้นทางไม่ผ่าน validation (เช่น drugcode ว่าง) จะรายงานไว้ ไม่วนซ้ำ
- สั่งจากหน้าเว็บได้ด้วยปุ่ม "ตรวจสอบความครบถ้วน" (ธง `agents.verify_requested_at` -> heartbeat)
- ชุดข้อมูลที่ค้างเพราะ batch เดิมถูกปิดไปแล้ว จะถูกย้ายไป batch ใหม่อัตโนมัติ (`recoverOrphanChunks`)

### การแบ่งหน้าดึงข้อมูล (สำคัญต่อความครบและความเร็ว)
- คีย์เรียงที่ใช้คือ `(visitdate, visitno, drugcode)` ซึ่ง **unique** เพราะ PK ของ visitdrug คือ
  `(pcucode, visitno, drugcode)` -> ต่อให้ตารางเรียงมั่วก็ไม่มีแถวข้ามหรือซ้ำ
- **ห้ามใช้ `LIMIT/OFFSET`** สำหรับ full sync: offset ลึกทำให้ scan ซ้ำทุกหน้า (265k แถวใช้เวลาเป็นชั่วโมง)
- วิธีที่ใช้: ไล่ `visit` ผ่าน index `vs_date` แบบ keyset (`visitdate, visitno` > cursor) ครั้งละ 400 visit
  แล้วดึง `visitdrug` ของชุด visitno นั้นผ่าน PK -> เร็วและคงลำดับ
- แถว orphan ดึงแยกอีกรอบเดียวตอนท้าย

### หน่วยนับยา ต้องแปลงรหัสก่อน (ยืนยันจาก DB จริง)
- `cdrug.unitsell` / `cdrug.unitusage` เก็บ **รหัส** ไม่ใช่ชื่อ (เช่น 027, 009, 006)
- ตารางแปลงคือ **`cdrugunitsell(unitsellcode, unitsellname)`** — 027=เม็ด, 009=แคปซูล, 006=ขวด
- Agent LEFT JOIN ตารางนี้ตั้งแต่ต้นทาง แล้วส่งขึ้น Central เป็น `unit` (ชื่อ) + `unitCode` (รหัสเดิมไว้ตรวจสอบ)
- ถ้าไม่มีตารางนี้ SchemaInspector จะเตือนและ fallback เป็นรหัส (`supportsUnitName: false`)

### หมวดยา (drugtype) ที่ถือว่าเป็น "ยา"
- **01 ยาแผนปัจจุบัน + 10 ยาสมุนไพร** เท่านั้นที่แสดงเป็นค่าเริ่มต้น (`PRIMARY_DRUG_TYPES`)
- **05 วัคซีน ถูกตัดออกจากค่าเริ่มต้น** (2026-09-05) เพราะงานวัคซีนรายงานผ่าน EPI ซึ่งระบบนี้ไม่ครอบคลุม
  ถ้านับรวมจะซ้ำซ้อน — SUPER_ADMIN ยังติ๊กดู 05 ได้ที่ตัวกรองรายงาน (ซ่อน ไม่ได้ทิ้ง)
- ที่เหลือ (02 เวชภัณฑ์มิใช่ยา, 06 หัตถการ, 11 ครุภัณฑ์ ฯลฯ) เป็นวัสดุ/บริการ ถ้ารวมเข้าไปยอดจะเพี้ยน
- USER / FACILITY_ADMIN / ADMIN → บังคับเห็นแค่ 01+10 (`resolveDrugTypeScope`)
- Agent ยัง sync ทุกหมวดขึ้น Central (ตัดตอนแสดงผล ไม่ตัดตอนเก็บ) เพื่อให้ super admin ตรวจย้อนหลังได้

### สถานะรหัสยา (`cdrug.drugflag`)
- **`1` = เปิดใช้งาน · `2` = ปิดใช้งาน · นอกนั้น (NULL / ไม่มีแถวใน `drugs`) = "ไม่ทราบสถานะ"** ห้ามเดาว่าเปิด
- ตัวตัดสินกลางคือ `drugStatus()` ใน `src/lib/shared/drug-types.ts` (rank 0 เปิด / 1 ไม่ทราบ / 2 ปิด)
  ใช้ทั้งฝั่ง client (ตาราง, drilldown) และ SQL (`retired` ใน `reports.ts`) ให้เรียงเหมือนกันทุกหน้า
- **บั๊กที่เจอ 2026-09-05:** `fetchDrugMaster()` มี `LIMIT 2000` ทั้งที่ cdrug มี 7,410 แถว
  → รหัสหลังตัวที่ 2000 ไม่มี master, LEFT JOIN ได้ NULL, หน้าเว็บเลยขึ้น "เปิดใช้งาน" ทั้งที่ปิดไปแล้ว
  แก้เป็น `streamDrugMaster()` ไล่ keyset ตาม drugcode แล้วอัปโหลดทีละ 1,000 แถว
  (หลังแก้: master ครบ 7,410 · เหลือรหัสที่ใช้จริงแต่ไม่มีใน cdrug 54 รหัส → ขึ้น "ไม่ทราบสถานะ")

### กลยุทธ์ incremental ที่เลือก (เพราะ dateupdate เชื่อไม่ได้)
ใช้ **date window ของ `visit.visitdate`** + deterministic key
`record_key = sha256(facility_id|pcucode|visitno|drugcode)`
sync ถัดไปเริ่มจาก `last_visit_date - REPROCESS_DAYS (default 7)` เพื่อจับข้อมูลย้อนหลังที่คีย์ทีหลัง
Central ใช้ `INSERT ... ON DUPLICATE KEY UPDATE` บน record_key → ส่งซ้ำได้ ไม่เกิดข้อมูลซ้ำ

### ประสิทธิภาพหน้ารายงาน (วัดจริง 2026-09-05)
- **ความช้าที่รู้สึกตอน dev ส่วนใหญ่คือ compile ของ dev server** (dashboard 14.3s, sync 12.8s ครั้งแรก)
  บน production ไม่มี — วัด `next start` ได้ dashboard 255-270ms, รายงาน 80-88ms, sync ~260ms
- RTT ไป TiDB แค่ ~47ms ไม่ใช่คอขวด · คอขวดคือ query สแกนทั้งตาราง
- **index เดิมทุกตัวขึ้นต้นด้วย `facility_id`** แต่ SUPER_ADMIN ดูทุกสถานบริการ (ไม่มีเงื่อนไข facility)
  -> ใช้ index ไม่ได้ กลายเป็น `IndexFullScan` 265,786 แถวต่อ query (หน้าเดียวมี 6-8 query)
  เพิ่ม `drug_usage_window_idx (usage_date, drug_type, drug_code, quantity)` = migration 0005
- `src/lib/services/report-cache.ts` cache ผลรายงาน (TTL 300s) key = ค่าที่เข้า WHERE ทั้งหมด
  (รวม facility scope -> คนละสิทธิ์คนละ key ไม่รั่ว) และ **ล้างทันทีที่ agent ส่งข้อมูลเข้า**
  (`invalidateUsageReports()` เรียกจาก `ingestUsageRecords` + `upsertDrugMaster`)
- pool ขยายเป็น 10 เพราะหน้าเดียวยิง 8 query พร้อมกัน pool 5 ทำให้ต่อคิว
- ถ้าต้องวัดใหม่: `EXPLAIN ANALYZE` ดูว่ายังเป็น TableFullScan ไหม และ `ANALYZE TABLE drug_usage`
  หลังเพิ่ม index ทุกครั้ง (stats เก่าทำให้ optimizer เลือกแผนผิด)

### ช่วงเวลาเริ่มต้นของรายงาน
- ใช้ **ปีงบประมาณไทย** (1 ต.ค. - 30 ก.ย.) เป็นค่าเริ่มต้นทุกหน้า: 1 ต.ค. ของปีงบฯ ปัจจุบัน ถึง **วันนี้**
- `src/lib/fiscal-year.ts` เป็นตัวคำนวณกลาง (`currentFiscalRange`, `buildFiscalYear`, `recentFiscalYears`)
- หน้าแดชบอร์ด/รายงานเลือกช่วงเองได้ และเลือกเป็น "ปีงบประมาณ" ย้อนหลัง 5 ปีได้

## 3.5 สิทธิ์ผู้ใช้ (4 ระดับ)

| role | เห็นข้อมูล | จัดการระบบ |
|---|---|---|
| SUPER_ADMIN | ทุกสถานบริการ ทุกหมวดยา | ได้ทั้งหมด (facility/agent/user) |
| ADMIN | ทุกสถานบริการ เฉพาะยา 3 หมวด | **ไม่ได้** (อ่านอย่างเดียว) |
| FACILITY_ADMIN | สถานบริการตัวเอง เฉพาะยา 3 หมวด | ผู้ใช้ในสถานบริการตัวเอง + สั่งซิงก์ |
| USER | สถานบริการตัวเอง เฉพาะยา 3 หมวด | ไม่ได้ |

- สมัครสมาชิกเองได้ที่ `/register` เก็บ: ชื่อ-นามสกุล, ตำแหน่ง, user id, รหัสผ่าน, รหัสสถานบริการ (pcucode), ชื่อสถานบริการ
- บัญชีที่สมัครเองจะ **inactive จนกว่าผู้ดูแลอนุมัติ** ที่ `/admin/users` (ถ้าเปิดใช้ทันทีเท่ากับไม่มี facility isolation)
- login ด้วย **user id** หรืออีเมลก็ได้ (บัญชีเก่าที่ seed ไว้ยังใช้อีเมลได้)

## 4. สถานะการทำงาน (อัปเดตทุกครั้ง)

- [x] PHASE 0 — สำรวจ JHCISDB จริง + บันทึก schema (§3)
- [x] PHASE 1 — scaffold Next.js 15 + Drizzle schema (13 ตาราง) + migration `drizzle/0000_*.sql`
- [x] PHASE 2 — Auth (JWT httpOnly cookie) + RBAC + facility isolation (`resolveFacilityScope`)
- [x] PHASE 3 — Agent enrollment (token ครั้งเดียว) + HMAC auth + replay guard
- [x] PHASE 4 — Heartbeat + config + schema report
- [x] PHASE 5 — JHCIS extraction layer (inspector + extractor + `agent doctor`) — ทดสอบกับ DB จริงผ่าน
- [x] PHASE 6 — Sync pipeline (คิวไฟล์, retry/backoff, idempotency ด้วย record_key)
- [x] PHASE 7 — drug_usage + drugs + upsert
- [x] PHASE 8 — รายงาน (summary, ตาราง, trend, drug detail, facility comparison, CSV export)
- [x] PHASE 9 — Admin monitoring (/admin/monitoring, /admin/agents, /sync) + Sync Now
- [x] PHASE 10 — UI/UX (design system + component ตาม §19)
- [x] PHASE 11 — security checklist + unit test 20 ข้อ (docs/SECURITY.md)
- [x] PHASE 12 — เชื่อม TiDB Cloud จริงแล้ว (migrate + seed + sync + รายงาน ผ่านครบวง)
      เหลือ deploy ขึ้น Vercel
- [x] PHASE 13 — สถานะตามจริง + realtime (ดู §8), หน้าจอ agent ใหม่, ท่อส่งแบบ producer/consumer (§9)

### ผลทดสอบกับของจริง (2026-09-04, รอบเต็ม)
- sync ทั้งฐาน: **265,786 / 265,787 แถว** เข้า TiDB (ขาด 1 แถวที่ `drugcode` ว่าง ซึ่งถูกปฏิเสธ
  พร้อมเหตุผลใน `sync_rejects` ตามที่ควรเป็น)
- ตรวจยาเทียบทีละตัว: P1 (0.1% TA LOTION) ปีงบ 2569 = 60 ครั้ง / 70 ขวด **ตรงกับ JHCIS เป๊ะ**
- `agent verify` เทียบ 202 เดือน เจอไม่ตรง 2 เดือน ซ่อมสำเร็จ 1 เดือน อีกเดือนรายงานว่าซ่อมไม่ได้
  (เป็นแถว drugcode ว่าง)

### บั๊กสำคัญที่เจอรอบนี้และแก้แล้ว
1. **INNER JOIN visit ทำให้ 18 แถวหายเงียบ** -> เปลี่ยนเป็น LEFT JOIN + ธง `visit_missing`
2. **LIMIT/OFFSET ทำให้ full sync ช้ามาก** -> เปลี่ยนเป็น keyset ไล่ `visit` ผ่าน index `vs_date`
3. **zod ที่ route ตีตกทั้งชุด 500 แถว เพราะ drugcode ว่าง 1 แถว** -> ย้ายกฎรายแถวไปที่ service
   (route ตรวจแค่รูปร่าง) ตาม JHCIS_INTEGRATION §23 "record เดียวผิดต้องไม่ล้มทั้ง batch"
4. **chunk ที่ batch ถูกปิดแล้วค้างถาวรใน failed/** -> ย้ายไป batch ใหม่อัตโนมัติ

### ผลทดสอบกับของจริง (2026-09-04)
- TiDB Cloud `sankamphaeng_drug` (TiDB v8.5.3 serverless) — 15 ตาราง, migration 0000-0002
- sync ข้อมูลจริง 2026-06-01→08-08 = **4,650 แถว** ปฏิเสธ 0 · sync ซ้ำแล้วยัง 4,650 (idempotent)
- หน่วยแปลงถูก: เม็ด/ขวด/แคปซูล/หลอด/อัน
- รายงานหน้าเว็บ: ยา 3 หมวด = 93,618 หน่วย (01 = 93,260 / 10 = 358)

### บั๊กที่เจอตอนทดสอบจริงและแก้แล้ว
1. `getUsageTrend` — drizzle เรนเดอร์ expression เดียวกันต่างกันใน SELECT (`usage_date`) กับ GROUP BY
   (`drug_usage`.`usage_date`) พอเจอ ONLY_FULL_GROUP_BY ของ TiDB เลยพัง → แก้เป็น group/order by alias
2. อัปโหลด drug master ล้ม แล้ว throw ออกจาก `run()` ทำให้ไม่ปิด batch และไม่ flush คิว → จับ error แล้วไปต่อ
3. ลืม apply migration 0002 → upload ล้มทั้งหมด แต่ **คิวออฟไลน์เก็บครบ** พอ migrate แล้ว `retry` ส่งได้ทั้ง 4,650

### ทดสอบแล้ว
- `tests/security.test.ts` — 20 เคส: facility isolation, record key, HMAC, การเข้ารหัส credential
- `tests/agent-pipeline.test.ts` — 6 เคส E2E ยิงจาก **JHCISDB จริง (05957)** เข้า mock Central API
  ที่ตรวจลายเซ็นด้วยโค้ดชุดเดียวกับ production: extract → sign → chunk → คิว → upload → complete
  รวมถึงเคสเน็ตหลุดกลางทางแล้วกู้คืนได้ (ข้ามอัตโนมัติถ้าต่อ JHCIS ไม่ได้)
- **บั๊กที่เทสจับได้และแก้แล้ว:** เดิมถ้าอัปโหลด drug master ล้ม จะ throw ออกจาก `run()`
  ทำให้ไม่ได้ปิด batch และไม่ได้ flush คิว → ตอนนี้จับ error แล้วทำงานต่อ (master จะส่งใหม่รอบหน้า)

### ยังไม่ได้ทดสอบ (ต้องมี TiDB ก่อน)
- ฝั่ง Central จริง: migrate → seed → enroll → รับข้อมูลลง TiDB → รายงานบนเว็บ
  (local MySQL 5.6 ใช้แทนไม่ได้ เพราะ schema ใช้ JSON column ซึ่งมีตั้งแต่ 5.7)
- facility isolation ระดับ integration (ตอนนี้มี unit test ของ `resolveFacilityScope` แล้ว)

## 5. คำสั่งที่ใช้บ่อย

```bash
npm run dev            # Central Web
npm run db:generate    # drizzle-kit generate
npm run db:push        # push schema ไป TiDB
npm run lint / typecheck / test / build
cd agent && npm run doctor   # ตรวจ JHCIS connection + schema
```

## 6. เอกสารในโปรเจค (มีเท่านี้ พอ)

| ไฟล์ | เนื้อหา |
|---|---|
| AGENTS.md | กฎสำหรับ AI agent (ห้ามแก้เนื้อหาเดิม) |
| PROJECT_SPEC.md | requirement หลัก (ห้ามแก้) |
| JHCIS_INTEGRATION.md | requirement JHCIS (ห้ามแก้) |
| CLAUDE.md | ไฟล์นี้ — working memory + schema จริง + สถานะ |
| docs/ARCHITECTURE.md | ภาพรวมระบบ + data flow |
| docs/API.md | Central API + HMAC spec |
| docs/DATABASE.md | schema กลาง + index |
| docs/SECURITY.md | security checklist + threat model |
| docs/SYNC.md | sync pipeline + idempotency |
| docs/AGENT.md | ติดตั้ง/ใช้งาน Agent |
| docs/DEPLOYMENT.md | Vercel + TiDB |

## 7. กติกาเวลาทดสอบในเครื่อง

- **ห้ามรัน `next build` ขณะ dev server ทำงาน** — มันเขียนทับ `.next` แล้ว dev server พังทันที
  ถ้าเผลอ ให้หยุด dev server → `rm -rf .next` → เริ่มใหม่
- client component **ห้าม** import `src/lib/shared/canonical.ts` (มี `node:crypto`) ให้ใช้ `drug-types.ts` แทน
- migration ต้อง `npm run db:generate` **แล้ว** `npm run db:migrate` ทุกครั้ง ก่อนทดสอบ sync

## 8. สถานะการเชื่อมต่อต้องเป็นความจริง (Phase 1)

- **บั๊กเดิม: `centralConnected: !permanent`** — error 401/403 ถือว่า "ยังต่อได้" เพราะไม่ permanent
  ตอนนี้แยกเป็น `centralState`: `CONNECTED` / `NETWORK_ERROR` / `AUTH_ERROR` / `UNKNOWN`
  พร้อม `centralAttemptAt` (ลองเมื่อไหร่) และ `centralAckAt` (ศูนย์กลางตอบจริงเมื่อไหร่)
- ค่าคงที่กลางอยู่ที่ **`src/lib/shared/agent-status.ts`** ที่เดียว: heartbeat 30 วินาที,
  ถือว่า stale ที่ 90 วินาที, หน้าเว็บ poll 5 วินาที — ห้ามเขียนตัวเลขพวกนี้ซ้ำที่อื่น
- `jhcisConnected` เก็บลง Central แล้ว (migration 0008) หน้าเว็บจึงรู้ว่า LAN ฝั่ง รพ.สต. ล่ม
- `/api/sync/live` **ต้อง auth และไม่รับพารามิเตอร์ใด ๆ** (USER เห็นแค่ agent ของตัวเอง ไม่มี secret ในผลลัพธ์)
- **cross-process lock** ที่ `<data>/sync.lock` — tray กับ scheduler อยู่คนละ process
  เคยซิงก์ทับกันได้ ตอนนี้ตัวที่สองเจอ `SyncLockedError` แล้วข้ามรอบ (lock ค้างเกิน 5 นาที
  หรือ pid ตายแล้ว = ยึดต่อได้ ไม่ค้างถาวร)

## 8.5 การชนกันของการเขียนตอนหลาย Agent ส่งพร้อมกัน (v1.1.4)

- ทดสอบ 15 agent จำลองบนเครื่องเดียว (harness อยู่ที่ `build/fleet/` ไม่เข้า git)
  ยิงเข้า **route จริง + service จริง + drizzle จริง** ต่อฐานทดสอบ `sdc_fleet_central`
  บน MySQL 8.4 (คนละ server กับ JHCIS ที่ port 3333 — **ห้ามแตะ 3333**)
- **ต้นเหตุที่ยืนยันแล้วด้วย `SHOW ENGINE INNODB STATUS`**: deadlock อยู่ที่ **PRIMARY index**
  ของ `drug_usage` ซึ่งเรียงตาม `id` แบบ AUTO_INCREMENT -> ทุก agent ต่อแถวลง **หน้าเดียวกัน**
  แล้วรอ insert intention lock ของกันและกัน ไม่เกี่ยวกับ `record_key` เลย
- สิ่งที่วัดแล้ว **ไม่ช่วย**: เรียง chunk ตาม record_key (15.3% -> 15.8% = เท่าเดิม)
- สิ่งที่วัดแล้ว **แย่ลง**: ลด `UPSERT_CHUNK` (500 = 15.8% · 250 = 18.4% · 100 = 22.1%)
  เพราะ 1 request แตกเป็นหลาย statement -> โอกาสแพ้เพิ่มขึ้นตามจำนวน statement
  **ดังนั้น UPSERT_CHUNK ต้องคงที่ 500** ห้ามลดโดยไม่มีหลักฐานใหม่
- สิ่งที่ **ช่วยจริง**: `withWriteConflictRetry` (`src/lib/db/retry.ts`) retry เฉพาะ error ที่
  ฐานข้อมูลบอกเองว่า transient (1213/1205 + รหัส TiDB) 4 ครั้ง หน่วง 50/150/400 ms มี jitter
  -> first insert 15 agent **ไม่มี 500 เลย** (0/185) · re-upload 15.8% -> 9.8%
- **ห้ามอ้างว่า TiDB มีอาการนี้** — production ยังไม่เคยเจอ และ TiDB ไม่มี tail page แบบ InnoDB
- ไม่ว่ากรณีไหน **ข้อมูลไม่เคยหาย**: คิวของ agent ส่งซ้ำจนครบทุกครั้ง (45,035/45,035, pending 0)

## 8.6 การลงทะเบียนใหม่กับ watermark (บันทึกจากของจริง 2026-09-09)

- **ความคืบหน้าการซิงก์ผูกกับ `agentId`** ที่ `agents.last_synced_visit_date` ฝั่งศูนย์กลาง
  ส่วนในเครื่องคือ `state.json.lastSyncedVisitDate`
- เดินหน้าได้ทางเดียวคือ `completeBatch` (`GREATEST(ค่าเดิม, วันที่ล่าสุดของ batch)`)
  ถอยหลังได้จาก `purgeFacilityUsage` (ผู้ดูแลล้างข้อมูล) เท่านั้น
- **ลงทะเบียนใหม่ = agent identity ใหม่ = watermark ที่ศูนย์กลางเป็น NULL**
  แล้ว `adoptCentralWatermark()` ในเครื่องจะ **ยอมถอยตามศูนย์กลางเสมอ** ซึ่งเป็นเจตนา
  (ถ้าผู้ดูแลล้างข้อมูลบางช่วง agent ต้องกลับไปเก็บใหม่ ไม่ใช่ข้ามไป)
- ผลคือ **สถานบริการที่ซิงก์ครบแล้ว ถ้าลงทะเบียนใหม่จะกลับไปเริ่มไล่ตรวจใหม่**
  - **ไม่ใช่ข้อมูลหาย** — ส่งซ้ำได้ปลอดภัยเพราะ `record_key` เป็น upsert
  - **ไม่ได้อัปโหลดประวัติทั้งหมดซ้ำ** `skipMatchingMonths` เทียบรายเดือนก่อน
    แล้วอ่านเฉพาะเดือนที่ไม่ตรง (แก้ความเข้าใจผิดเดิมที่เขียนว่าต้องส่งซ้ำทั้งช่วง)
  - **แต่ v1.1.5 มีบั๊ก**: เดือนที่มีแถวซึ่งถูกปฏิเสธถาวรจะ "ไม่ตรง" ตลอดกาล
    เพราะเทียบจำนวนต้นทางกับ **จำนวนที่ศูนย์กลางรับ** เท่านั้น -> วนซ่อมทุกชั่วโมง
    และ watermark ค้างอยู่ที่เดือนนั้น (ของจริง: 2024-02-29) **แก้แล้วใน v1.1.6**
- **ห้ามแก้ watermark ใน production ด้วย SQL มือ** และ **ไม่มี** ทางที่ระบบรองรับให้ดันไปข้างหน้า
  (ตรวจแล้ว: ไม่มี endpoint / ไม่มีปุ่มผู้ดูแล / `agent verify` ก็ไม่แตะ watermark)
- **ตอนอัปเกรดปกติให้คงการลงทะเบียนเดิมไว้** ลงทะเบียนใหม่เฉพาะเมื่อจำเป็นต้องหมุนกุญแจจริง ๆ
  ถ้าลงทะเบียนใหม่ไปแล้ว ปล่อยให้ส่งซ้ำจนจบเองได้

### สิ่งที่แก้ใน v1.1.6 (สองเรื่อง คนละเรื่องกัน)
1. **นับให้ครบ ไม่ใช่นับเฉพาะที่รับได้** — `src/lib/shared/ingest-rules.ts` เป็นที่เดียว
   ที่นิยามว่าแถวไหนที่ศูนย์กลางเก็บไม่ได้ถาวร (drugcode ว่าง / visitno <= 0)
   มีทั้งรูป SQL (`ELIGIBLE_SOURCE_ROW_SQL` ใช้ใน `monthlyTally`) และรูป TypeScript
   (`isIneligibleSourceRow` ใช้ใน `validate()` ฝั่ง server) วางติดกันและมีเทสว่าตรงกัน
   -> เดือนที่ต่างกันเพราะแถวแบบนี้ **ถือว่าครบ** ไม่วนซ่อมอีก
2. **VERIFIED THROUGH** — เดิม watermark = ปลายช่วงที่ *อ่านจริง* ถ้าข้ามเดือนที่ตรงแล้ว
   watermark จะค้างอยู่ที่เดือนสุดท้ายที่อัปโหลด และรอบที่ตรวจแล้วไม่มีอะไรต้องส่ง
   **ไม่เปิด batch เลย จึงไม่ขยับ watermark ตลอดกาล**
   ตอนนี้: ตรวจครบทั้งช่วงและไม่มีช่องโหว่ -> เลื่อน watermark ไปปลายช่วงที่ *ขอตรวจ*
   และรอบที่ไม่มีอะไรต้องส่งจะเปิด batch ว่าง (recordsRead 0) ปิดเป็น COMPLETED
   ผ่าน start/complete ปกติ ไม่มี endpoint ใหม่ ไม่ข้ามการยืนยันตัวตน
   - **ห้ามเลื่อนถ้า**: ยังมี gap ที่อธิบายไม่ได้ / batch ล้ม / คิวค้าง / ศูนย์กลางติดต่อไม่ได้
   - การถอย watermark จาก purge ยังทำงานเหมือนเดิม (มีเทสคุม)
3. `monthlyTally` เคยใช้ alias `AS rows` ซึ่งเป็นคำสงวนใน MySQL 8 (JHCIS จริงเป็น 5.6
   จึงไม่เคยพัง) ใส่ backtick แล้ว
4. หน้าจอบันทึก **สาเหตุที่ตัวทำงานหลุด** ลง log เดียวกับ agent แล้ว (pid / exit code /
   อยู่มานานเท่าไร / watchdog ทำอะไร) เดิม `poll()` อ่าน exit code แล้วทิ้ง จึงไม่เหลือหลักฐาน

### backlog: RE-ENROLLMENT CONTINUITY (ยังไม่ทำ)
แนวคิดอนาคต: ให้ agent ที่ลงทะเบียนใหม่ของสถานบริการเดิม **รับช่วงความคืบหน้าที่ยืนยันแล้ว
ระดับสถานบริการ** แทนการเริ่มจากศูนย์ — **ต้องผ่านการทบทวนความปลอดภัยก่อน** เพราะ watermark
คือสิ่งที่บอกว่า agent ข้ามข้อมูลช่วงไหนได้ เครื่องที่เพิ่งลงทะเบียนต้องไม่สามารถอ้างว่า
ข้อมูลที่ยังไม่เคยอ่านนั้นครบแล้ว ต้องพิจารณาพร้อมกัน: security model · เจ้าของ facility ·
ความหมายของ purge · การ reconcile · การเปลี่ยนเครื่องแทนของเดิม

## 8.7 เวลาเครื่องและการอัปเดตอัตโนมัติ (v1.1.7)

### เวลาเครื่องผิด ≠ สิทธิ์ถูกเพิกถอน
- ของจริง 2026-09-09: นาฬิกา Windows คลาดไป 41 นาที -> ลงลายเซ็นไม่ผ่าน replay window
  หน้าจอขึ้นว่า **"สิทธิ์ถูกเพิกถอน"** ทั้งที่ credential ปกติดี
- ต้นเหตุ: `centralFailure()` แปลง **ทุก 401** เป็น `AUTH_ERROR` ซึ่งหน้าจอแปลว่าเพิกถอน
- แก้: `classifyCentralFailure()` ใน `src/lib/shared/agent-status.ts` อ่าน **error code**
  - `TIMESTAMP_SKEW` / `BAD_TIMESTAMP` -> `CLOCK_SKEW`
  - เฉพาะรหัสที่ยืนยันว่าถูกยกเลิกจริง -> `CREDENTIAL_REVOKED`
  - 401/403 อื่น -> `AUTH_ERROR` (บอกว่าถูกปฏิเสธ **ห้าม** บอกให้ลงทะเบียนใหม่)
- **replay window ยังเป็น ±300 วินาทีเท่าเดิม ห้ามขยายเพื่อรองรับเครื่องที่เวลาเพี้ยน**
  เกณฑ์ของ agent อยู่ **ข้างใน** หน้าต่างนั้น: <120 ปกติ · 120-299 เตือน+ซิงก์ · >=300 ผิดพลาด
- `GET /api/time` ไม่ต้องยืนยันตัวตน **โดยตั้งใจ** — เครื่องที่เวลาเพี้ยนเซ็นคำขอไม่ได้
  จึงเข้าถึง endpoint ที่ต้องเซ็นไม่ได้เลย และ endpoint นี้ไม่มีข้อมูลลับ/สถานบริการใด ๆ
- ซิงก์เวลาแบบ **มีขอบเขต**: 3 ครั้ง หน่วง 5/15/30 วินาที แล้วหยุดเป็น `CLOCK_SYNC_FAILED`
  + cooldown 30 นาที **ห้ามวน w32tm ไม่รู้จบ**

### อัปเดตอัตโนมัติ
- `GET /api/agent/update` อ่าน `/releases/latest` ของ GitHub ฝั่ง server
  ซึ่ง **ตัด draft / prerelease / tag ที่ไม่มี release ออกให้อยู่แล้ว**
  -> v1.1.4 (มี tag แต่ตั้งใจไม่มี release) จะไม่มีวันถูกเสนอ
- **SHA-256 มาจาก `asset.digest` ของ GitHub เท่านั้น** (อ่านฝั่ง server)
  ไม่มี hash = แสดงว่ามีรุ่นใหม่ได้ แต่ `autoInstall:false` **ห้ามติดตั้งเอง**
  (HTTPS พิสูจน์ว่าใครส่งไฟล์ ไม่ได้พิสูจน์ว่าไฟล์คือของที่เผยแพร่)
- เทียบเวอร์ชันด้วย **ตัวเลข** (`src/lib/shared/version.ts`) ไม่ใช่สตริง
  ("1.1.10" < "1.1.9" ถ้าเทียบสตริง = ฟลีตจะหยุดอัปเดตที่ patch ที่ 9 เงียบ ๆ)
  เท่ากันหรือเก่ากว่า = ไม่ทำอะไร **ห้าม downgrade**
- **โมเดลสิทธิ์ (สำคัญที่สุด)** — ตัวติดตั้งรันด้วยสิทธิ์ผู้ดูแล ดังนั้น
  1. งานตามเวลา `SDCAgentTimeSync` / `SDCAgentAutoUpdate` มี **action ตายตัว**
     ชี้ไป `node.exe` + `agent.js` ใน Program Files **ห้ามรับ argument จากภายนอก**
  2. ตัวอัปเดตหา manifest / hash / ไฟล์ **ด้วยตัวเอง** ไม่รับ path จาก tray
  3. ดาวน์โหลดลง `%ProgramData%\SDCAgent\updates` ที่ **ไม่มี users-modify**
     (ถ้าผู้ใช้ทั่วไปเขียนได้ = สลับไฟล์หลังตรวจ hash ก่อนรัน = ยกระดับสิทธิ์)
  4. ไฟล์ที่ hash ไม่ตรง **ถูกลบทิ้ง** ไม่ปล่อยไว้ให้ถูกเรียกใช้
- ทั้งสองงานมี **ตารางเวลาของตัวเอง** (เวลา 1 ชม. · อัปเดต **30 นาที ตั้งแต่ v1.1.9** เดิม 4 ชม.) เพราะผู้ใช้ทั่วไป
  อาจไม่มีสิทธิ์สั่ง `schtasks /Run` งานที่รันเป็น SYSTEM ปุ่มบนหน้าจอเป็นแค่ตัวเร่ง
- **กระจายเวลาติดตั้ง 30 นาที** ด้วย hash ของ agentId เดิม (`updateOffsetSeconds`)
  ดาวน์โหลดไม่ต้องกระจาย ติดตั้ง/restart ต้องกระจาย
- **v1.1.9: ตรวจรุ่นใหม่ทุก 30 นาที** งาน `SDCAgentAutoUpdate` เป็น `/SC MINUTE /MO 30 /ST 00:MM`
  โดย MM = `updateCheckSlotMinute(agentId หรือ hostname)` (0-29) จาก `agent update-slot`
  -> แต่ละเครื่องตรวจคนละนาทีในครึ่งชั่วโมง ไม่ถามพร้อมกัน · ติดตั้งทับใช้ `/F` จึงแทนที่งานเดิม
  ของ 1.1.7/1.1.8 โดยไม่ซ้ำ · การตรวจแบบไม่มีรุ่นใหม่ = 1 request ไป Vercel -> 1 request ไป
  GitHub ฝั่ง server · **ไม่แตะ TiDB เลย** (0 read / 0 write) และไม่แตะ JHCIS/คิว/watermark
- หมายเหตุ: `updateOffsetSeconds` (กระจายตอนติดตั้ง) มีอยู่แต่ **ไม่ได้ถูกเรียกใช้** ใน `autoUpdate()`
  การกระจายจริงมาจากนาทีประจำเครื่องของงานตรวจข้างบน
- ติดตั้งด้วย `/VERYSILENT /NORESTART` **ห้ามใส่ `/SUPPRESSMSGBOXES`**
  (เคยทำให้คำถามก่อนติดตั้งของ Inno ตอบ Cancel เอง = exit 2 สามครั้งติด)
- **ข้อจำกัด bootstrap**: v1.1.6 อัปเดตตัวเองไม่ได้เพราะยังไม่มีตัวอัปเดต
  ต้องติดตั้ง v1.1.7 ด้วยมือครั้งเดียว หลังจากนั้นรุ่นถัดไปจึงอัปเดตเองได้

## 9. ท่อส่งข้อมูล (Phase 3) — วัดก่อนแก้เสมอ

- อ่านกับส่ง**ทำงานพร้อมกัน**แล้ว (เดิมอ่านจนจบค่อยส่ง) รายละเอียดใน `docs/SYNC.md` §4.1-4.2, §7
- **ห้ามเพิ่ม upload concurrency ต่อ agent** — 20 สถานบริการยิงพร้อมกันอยู่แล้ว
  เพิ่มความขนานต่อเครื่อง = ย้ายคอขวดไปที่ TiDB
- ผลวัดจริง (mock Central 40ms, `agent/bench.mts`):

  | | ก่อน | หลัง |
  |---|---|---|
  | 4,650 แถว รวม | 13.20 s | 7.35 s |
  | เริ่มส่งครั้งแรกที่ | 12,479 ms | 4,002 ms |
  | 20,374 แถว รวม | 21.65 s | 7.83 s |
  | 20,374 แถว rows/sec | 941 | 2,604 |
  | คิวสูงสุดบนดิสก์ | 11 | 6 (12 พอดีเมื่อ latency 250ms) |
  | จำนวน request | 41 | 41 (ไม่เปลี่ยน) |

- ศูนย์กลางล่ม (`--outage 8`): ยอม `Retry-After`, ดึงต่อจนจบ, เก็บคิว 10 chunk บนดิสก์,
  พอกลับมาส่งครบ 4,650 แถว เหลือค้าง 0
- **TiDB ยังไม่ใช่คอขวด** — ~565 ms ต่อ 500 แถว ที่ RTT ~47ms ยังไม่มีหลักฐานให้ทำ Phase 4
  (Redis/QStash/queue กลาง) ถ้าจะเสนอ ต้องมี metric ใหม่ก่อน ไม่ใช่ความรู้สึก
