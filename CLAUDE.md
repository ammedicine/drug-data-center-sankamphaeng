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

### กลยุทธ์ incremental ที่เลือก (เพราะ dateupdate เชื่อไม่ได้)
ใช้ **date window ของ `visit.visitdate`** + deterministic key
`record_key = sha256(facility_id|pcucode|visitno|drugcode)`
sync ถัดไปเริ่มจาก `last_visit_date - REPROCESS_DAYS (default 7)` เพื่อจับข้อมูลย้อนหลังที่คีย์ทีหลัง
Central ใช้ `INSERT ... ON DUPLICATE KEY UPDATE` บน record_key → ส่งซ้ำได้ ไม่เกิดข้อมูลซ้ำ

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
- [ ] PHASE 12 — Production deploy (รอ TiDB Cloud + Vercel env จริง — ดู docs/DEPLOYMENT.md)

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
