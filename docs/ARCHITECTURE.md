# ARCHITECTURE

ระบบรวบรวมข้อมูลปริมาณการจ่ายยาจาก JHCISDB ของ รพ.สต. หลายแห่งที่อยู่คนละวง LAN

## 1. ภาพรวม

```
รพ.สต. A (LAN)            Internet                Vercel / TiDB Cloud
┌────────────────┐                              ┌──────────────────────┐
│ JHCISDB (5.1)  │  read-only                   │  Central API         │
│  MySQL 5.6     │◄──────────┐                  │  (Next.js Route      │
└────────────────┘           │                  │   Handlers)          │
                             │                  │        │             │
┌────────────────┐   HTTPS + HMAC (outbound)    │        ▼             │
│ Local Agent    │──────────────────────────────►  TiDB Cloud (MySQL)  │
│  - inspector   │                              │        │             │
│  - extractor   │                              │        ▼             │
│  - offline คิว │                              │  Central Web (SSR)   │
└────────────────┘                              └──────────────────────┘
รพ.สต. B, C, ... เหมือนกันทุกแห่ง
```

กฎที่ห้ามละเมิด (PROJECT_SPEC §2, §32):

- Browser **ห้าม** ต่อ JHCISDB
- Central Server **ห้าม** ต่อ JHCISDB
- รพ.สต. **ไม่ต้องเปิด inbound port** ใด ๆ — Agent เป็น outbound-only
- Agent เป็น **READ-ONLY** ต่อ JHCISDB (บังคับใน `agent/src/jhcis/connection.ts`)

## 2. องค์ประกอบ

| ส่วน | ที่อยู่ | หน้าที่ |
|---|---|---|
| Central Web | `src/app/(app)/**` | Dashboard, รายงาน, หน้าผู้ดูแล (Server Components) |
| Central API | `src/app/api/agent/**` | รับข้อมูลจาก Agent (ลงลายเซ็น HMAC) |
| Export API | `src/app/api/reports/**` | ส่งออก CSV ตาม scope ของผู้ใช้ |
| Auth/RBAC | `src/lib/auth/**` | session (JWT ใน httpOnly cookie), facility isolation |
| Agent auth | `src/lib/agent-auth/**` | HMAC verify, replay guard, enrollment, การเข้ารหัส secret |
| Business logic | `src/lib/services/**` | sync ingest, รายงาน, monitoring, audit |
| Schema | `src/lib/db/schema.ts` | ตารางกลางทั้งหมด (ไฟล์เดียว) |
| Contract ร่วม | `src/lib/shared/canonical.ts` | ใช้ทั้งฝั่ง server และ Agent (record key, HMAC, types) |
| Local Agent | `agent/src/**` | ต่อ JHCIS, ตรวจ schema, ดึงข้อมูล, คิว, อัปโหลด |

`src/lib/shared/canonical.ts` ถูก import โดย Agent ผ่าน path alias `@shared/*`
ทำให้ **record key และวิธีลงลายเซ็นมีนิยามเดียวทั้งระบบ** ไม่มีการคัดลอกโค้ดซ้ำ

## 3. Data flow ของหนึ่งรอบ sync

```
SchemaInspector  ── ตรวจ schema จริง + pcucode ──► ตรวจว่า pcucode ตรงกับสถานบริการ
       │
UsageExtractor   ── SELECT เฉพาะคอลัมน์ที่ต้องใช้ (visitdrug ⋈ visit ⋈ cdrug)
       │
OfflineQueue     ── เขียน payload + stable chunkRef/hash ลงดิสก์ก่อนส่ง (chunk ละ 500 แถว)
       │
CentralClient    ── POST /sync/start → /sync/upload (n ครั้ง) → /sync/complete
       │              ทุก request ลงลายเซ็น HMAC + nonce + timestamp
Central API      ── verify hash → receipt transaction → upsert record_key + rejects + counters
       │
TiDB             ── drug_usage (unique record_key) + sync_batches + sync_rejects + upload receipts
       │
Web              ── aggregate ในฐานข้อมูล แล้วแสดงผล
```

## 4. เหตุผลของการตัดสินใจสำคัญ

- **Agent อ่านผ่าน `visit.visitdate` ไม่ใช่ `visitdrug.dateupdate`** — จาก DB จริงพบว่า
  `dateupdate` สูงสุดอยู่ที่ 2026-01-14 ขณะที่ `visitdate` ถึง 2026-08-08 จึงใช้ไม่ได้
  เป็น change marker (ดู CLAUDE.md §3)
- **Incremental แบบ date window + reprocess 7 วัน** แทนการเชื่อ timestamp — ปลอดภัยเพราะ
  ปลายทาง upsert ด้วย record key จึงส่งซ้ำได้โดยไม่เกิดข้อมูลซ้ำ
- **คิวเป็นไฟล์ JSON ไม่ใช่ SQLite** — Agent ต้องติดตั้งบนเครื่อง Windows ของ รพ.สต.
  ที่คุม runtime ไม่ได้ การพึ่ง native binding คือสาเหตุติดตั้งล้มเหลวอันดับหนึ่ง
- **secret ของ Agent เก็บแบบเข้ารหัส (AES-256-GCM) ไม่ใช่ hash** — ฝั่ง server ต้องใช้ค่า
  จริงเพื่อคำนวณ HMAC การเก็บ hash แล้วใช้ hash เป็นกุญแจเท่ากับไม่ได้ป้องกันอะไรเลย
- **ไม่ใช้ FOREIGN KEY บน TiDB** — รักษา integrity ที่ชั้น service แทน เพราะ FK บน TiDB
  เพิ่งรองรับและมีต้นทุนต่อ bulk upsert หลายล้านแถว (ดู docs/DATABASE.md)

## 5. Global Sync Start Date (forward policy implemented; rollout pending)

Global Sync Start Date เป็นนโยบายเดียวระดับอำเภอที่ Central เป็นเจ้าของและ `SUPER_ADMIN`
เท่านั้นที่เปลี่ยนได้ State machine แยกสองสถานะ:

- **desired date/revision** — ค่าที่ Agent ต้องรับและบันทึกอย่าง durable
- **active date/revision** — ค่าที่ Central ใช้บังคับ ingest หลังผ่าน rollout gate

revision นี้แยกจาก pause `controlRevision` โดยเด็ดขาด การบันทึกวันเดิมไม่สร้าง revision ใหม่
และ rollback ต้องสร้าง revision ที่สูงขึ้น ไม่ลดเลขเดิม

Central เก็บ policy ใน `system_settings` และส่ง desired/active state ผ่าน heartbeat แบบ optional
พร้อมรับ applied revision ที่ผูกกับ Agent identity ซึ่ง authenticate แล้วเท่านั้น Agent v1.1.17
นำ desired policy ไปใช้ และ `/admin/fleet` รองรับ readiness/activation กับ active-floor enforcement
แล้ว และ upload chunk receipts ป้องกัน counter/reject ซ้ำจาก ambiguous retry แล้ว ส่วน backfill
และ quarantine telemetry ยังไม่ได้ทำ

```
SUPER_ADMIN sets desired policy
        │
        ▼
Central heartbeat delivery ──► capable Agent persists/applies ──► acknowledgement
        │                                                        │
        └──────── fleet readiness + explicit approval ◄──────────┘
                                  │
                                  ▼
                         activate Central floor
```

ถ้าไม่มี policy row flow นี้ไม่เริ่ม: Agent เดิมใช้ local/default `syncStartDate`, ซิงก์ตามปกติ
และไม่ต้อง acknowledge การรองรับใช้ capability `remoteSyncStartDate`; `syncStartDate` เดิม
ยังคงความหมายเดิม

การ activate ไม่จำเป็นต้องรอ Agent ออฟไลน์ทุกเครื่อง แต่ override ทำได้เมื่อ fleet มี desired
pause, ไม่มี active Central batch, `SUPER_ADMIN` ยืนยันพร้อมเหตุผล และมี audit เท่านั้น
Agent ที่ยัง pending/unsupported ต้องคง paused จนกว่าจะอัปเกรด รับ policy และรายงาน applied

การเลื่อนวันไม่ลบ Central history และไม่ใช่ purge การเลื่อนไปข้างหน้ารักษา watermark กับแถวเดิม
ส่วนรายการคิวต่ำกว่า floor ไป quarantine การเลื่อนย้อนหลังเพียงเปิดช่วงที่ยอมรับได้; historical
recovery ต้องเป็น `MANUAL_RANGE` + reconciliation แบบ explicit และต้องมีทั้ง
`remoteSyncStartDate` กับ `idempotentUploadChunk`
