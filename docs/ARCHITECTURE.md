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
OfflineQueue     ── เขียนลงดิสก์ก่อนส่ง (chunk ละ 500 แถว)
       │
CentralClient    ── POST /sync/start → /sync/upload (n ครั้ง) → /sync/complete
       │              ทุก request ลงลายเซ็น HMAC + nonce + timestamp
Central API      ── validate ราย record → upsert ตาม record_key → นับ accepted/rejected
       │
TiDB             ── drug_usage (unique record_key) + sync_batches + sync_rejects
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
