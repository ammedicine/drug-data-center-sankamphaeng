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
agent/gui/smoke_test.py      ทดสอบตรรกะโดยไม่เปิดหน้าต่าง (ใช้ตอน desktop ล็อก/CI)
agent/installer/build.ps1    bundle agent -> node runtime -> PyInstaller -> Inno Setup
agent/installer/sdc-agent.iss สคริปต์ Inno Setup (autostart, ProgramData, uninstall)
```

- หน้าจอ **ไม่มีตรรกะดึงข้อมูล** เป็นแค่ตัวสั่งงาน `agent` (Node) และอ่านไฟล์สถานะ
- ไฟล์ที่เป็นสะพานระหว่างสองฝั่ง: `data/settings.json` (ตารางเวลา) กับ `data/status.json`
  (เฟส/ความคืบหน้า เขียนแบบ temp+rename ทุกครั้ง)
- เครื่องปลายทางไม่ต้องมี Node/Python เพราะตัวติดตั้งแนบ `node.exe` + `agent.js` + exe ของหน้าจอ
- **เครื่องนี้ยังไม่ได้ติดตั้ง Inno Setup** (ISCC.exe) จึงยัง build ตัวติดตั้งจริงไม่ได้

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

ข้อมูลจริงเก็บเป็น UTF-8 (ยืนยันด้วย HEX) → client ต้องใช้ `charset: utf8mb3`

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
- **01 ยาแผนปัจจุบัน, 05 วัคซีน, 10 ยาสมุนไพร** เท่านั้นที่นับเป็นยา
- ที่เหลือ (02 เวชภัณฑ์มิใช่ยา, 06 หัตถการ, 11 ครุภัณฑ์ ฯลฯ) เป็นวัสดุ/บริการ ถ้ารวมเข้าไปยอดจะเพี้ยน
- USER / FACILITY_ADMIN / ADMIN → บังคับเห็นแค่ 3 หมวดนี้ (`resolveDrugTypeScope`)
- SUPER_ADMIN → ค่าเริ่มต้นก็ 3 หมวดนี้ แต่ติ๊กเพิ่มหมวดอื่นได้
- Agent ยัง sync ทุกหมวดขึ้น Central (ตัดตอนแสดงผล ไม่ตัดตอนเก็บ) เพื่อให้ super admin ตรวจย้อนหลังได้

### กลยุทธ์ incremental ที่เลือก (เพราะ dateupdate เชื่อไม่ได้)
ใช้ **date window ของ `visit.visitdate`** + deterministic key
`record_key = sha256(facility_id|pcucode|visitno|drugcode)`
sync ถัดไปเริ่มจาก `last_visit_date - REPROCESS_DAYS (default 7)` เพื่อจับข้อมูลย้อนหลังที่คีย์ทีหลัง
Central ใช้ `INSERT ... ON DUPLICATE KEY UPDATE` บน record_key → ส่งซ้ำได้ ไม่เกิดข้อมูลซ้ำ

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
