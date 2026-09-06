# SYNC — Pipeline, Idempotency, Offline Queue

## 1. ลำดับการทำงาน

```
Extract → Validate → Normalize → Batch → Upload → Verify → Commit
```

| ขั้น | ที่ไหน | ไฟล์ |
|---|---|---|
| Extract | Agent | `agent/src/jhcis/extractor.ts` |
| Normalize | Agent | แปลงเป็น `DrugUsageRecord` (canonical) |
| Batch/Queue | Agent | `agent/src/queue/queue.ts` (เขียนดิสก์ก่อนส่งเสมอ) |
| Upload | Agent → API | `agent/src/central/client.ts` |
| Validate | Central | `src/lib/services/sync.ts` → `validate()` |
| Commit | Central | upsert `drug_usage` + ปิด batch |

## 2. Sync modes

| mode | ช่วงวันที่ |
|---|---|
| `INITIAL` | ตั้งแต่ `MIN(visitdate)` ถึง `MAX(visitdate)` |
| `INCREMENTAL` | `watermark - reprocessDays` ถึง `MAX(visitdate)` |
| `MANUAL_RANGE` | ตามที่ผู้ใช้ระบุ `--from/--to` |
| `RETRY` | ส่งเฉพาะ chunk ที่ค้างในคิว (`sdc-agent retry`) |

**ทำไมต้อง `reprocessDays` (ค่าเริ่มต้น 7):** JHCIS V5.1 ไม่มี change marker ที่เชื่อถือได้
(`visitdrug.dateupdate` ล้าหลัง `visit.visitdate` จริงหลายเดือนใน DB ตัวอย่าง)
จึงย้อนอ่านซ้ำ 7 วันทุกครั้งเพื่อจับรายการที่คีย์ย้อนหลัง — ทำได้เพราะการส่งซ้ำไม่สร้างข้อมูลซ้ำ

## 2.1 Sync Now (สั่งซิงก์เดี๋ยวนี้)

ผู้ที่มีสิทธิ์ (SUPER_ADMIN / FACILITY_ADMIN ของสถานบริการนั้น) กดปุ่มบนเว็บ →
ระบบตั้ง `agents.sync_requested_at` → Agent เห็น `syncRequested: true` ใน heartbeat รอบถัดไป
(≤ 5 นาที) แล้วเริ่มซิงก์ทันที

ออกแบบเช่นนี้เพราะ Central **ไม่สามารถ** เรียกเข้า LAN ของ รพ.สต. ได้ตาม architecture
(ไม่มี inbound port) การสั่งงานจึงต้องเป็นแบบ pull เท่านั้น

## 2.2 ความครบถ้วน: ยึด visitdrug เป็นตัวตั้ง

ลำดับจริงใน JHCIS: เปิดคิว -> `visit` (visitno + visitdate) -> คียา -> `visitdrug`

`visitdrug` คือแหล่งข้อมูลจริงของการจ่ายยา ส่วน `visit` ให้แค่วันที่ ดังนั้น:

- ใช้ **LEFT JOIN visit** ไม่ใช่ INNER JOIN (บน DB จริงพบ 18 แถวที่ visit ถูกลบไปแล้ว
  ซึ่ง INNER JOIN จะทำให้หายเงียบ ๆ)
- แถวที่ไม่มี visit -> วันที่ใช้ `DATE(visitdrug.dateupdate)` และตั้งธง `visit_missing = 1`
- `agent doctor` รายงานจำนวนแถวทั้งหมด/แถวที่ไม่มี visit ทุกครั้ง ไม่ปล่อยให้เงียบ

### การไล่ข้อมูล (paging)

`visitdrug` เก็บแบบไม่เรียงลำดับ จึงต้องมีคีย์เรียงที่ unique:
`(visitdate, visitno, drugcode)` ตรงกับ PK `(pcucode, visitno, drugcode)` -> ไม่ข้าม ไม่ซ้ำ

Agent ไล่ `visit` ผ่าน index `vs_date` ครั้งละ 400 รายการแบบ keyset แล้วดึง `visitdrug`
ของ visitno ชุดนั้นผ่าน PK — ไม่ใช้ `LIMIT/OFFSET` เพราะ offset ลึกทำให้การ sync ทั้งฐานช้ามาก

## 2.3 ตรวจนับก่อนและหลังทุกครั้ง

```
นับที่ JHCIS (records_read)  ->  ซิงก์  ->  นับที่ศูนย์กลาง (audit)
                                              |
                                    ต่างกัน? -> ซิงก์ซ้ำเฉพาะเดือนที่ขาด -> นับใหม่
                                              |
                              ยังต่าง -> batch = FAILED + ไม่เลื่อน watermark
```

- ส่วนต่างที่เท่ากับจำนวนแถวที่ถูกปฏิเสธ (มีเหตุผลบันทึกใน `sync_rejects`) ไม่ถือว่าข้อมูลหาย
- รอบซ่อมจะไม่ตรวจซ้ำอีก (`reconcile: false`) จึงไม่มีการวนไม่รู้จบ
- ผลการตรวจแสดงใน CLI, ในโปรแกรมหน้าจอ และเก็บใน `sync_batches.error_message`

## 3. Idempotency

```
record_key = sha256(facility_id | pcucode | visit_no | drug_code)
```

ตรงกับ primary key จริงของ `visitdrug (pcucode, visitno, drugcode)` บวก facility กลาง
ฝั่ง Central ใช้ `INSERT ... ON DUPLICATE KEY UPDATE` บน unique index ของ `record_key`

ผลลัพธ์: retry / timeout / restart / manual sync ซ้ำ → ข้อมูลไม่ซ้ำ ค่าล่าสุดชนะ
ไม่พึ่ง UUID สุ่มเป็นตัวกันซ้ำ (JHCIS_INTEGRATION §13)

ระดับ batch: `sync/start` ด้วย `batchRef` เดิมจะคืน batch เดิม (`resumed: true`) ไม่สร้างซ้ำ

## 4. Offline queue

```
agent/data/queue/pending/<batchRef>__000001.json   รอส่ง
agent/data/queue/failed/<batchRef>__000001.json    ล้มเหลวถาวร (4xx)
```

- เขียนแบบ temp แล้ว rename → ไฟล์ที่อ่านได้คือไฟล์ที่สมบูรณ์เสมอ
- เน็ตหลุด → `flushQueue()` หยุดทันที เก็บของไว้ รอบถัดไปส่งต่อจากเดิม
- 4xx (ยกเว้น 408/429) → ย้ายเข้า `failed/` เพราะส่งกี่ครั้งก็ไม่ผ่าน
- `sdc-agent retry` ย้าย `failed/` กลับเข้า `pending/` แล้วลองใหม่

### 4.1 ผู้ผลิต/ผู้บริโภค + คิวมีขอบเขต (2026-09-06)

เดิมเป็นสองขั้นเรียงกัน: อ่าน JHCIS จนครบ **แล้วค่อย** เริ่มส่ง แปลว่าไม่มีอะไรถึงศูนย์กลาง
เลยจนกว่าจะอ่านจบ และคิวโตได้ไม่จำกัด ตอนนี้ตัวอ่านกับตัวส่งทำงานพร้อมกัน

- **upload concurrency = 1 ต่อ agent** ไม่ยิงขนาน เพราะ 20 สถานบริการยิงพร้อมกันอยู่แล้ว
  การเพิ่มความขนานต่อเครื่องคือการย้ายคอขวดไปไว้ที่ TiDB
- **backpressure**: คิวบนดิสก์เกิน `MAX_PENDING_CHUNKS` (12) ตัวอ่านหยุดรอจนเหลือ
  `RESUME_PENDING_CHUNKS` (6) → หน่วยความจำและดิสก์มีเพดาน ไม่โตตามขนาดช่วงข้อมูล
- ถ้าตัวส่งส่งอะไรไม่ได้เลย (ศูนย์กลางล่ม) จะ **ไม่รอค้าง** — ตัวอ่านทำต่อจนจบแล้วเก็บลงคิว
  ข้อมูลอยู่บนดิสก์ครบ รอบถัดไปส่งต่อ (ทดสอบด้วย `bench.mts --outage`)
- durability ไม่เปลี่ยน: ยัง temp+rename, ยัง record_key เดิม, ยัง idempotent

### 4.2 กระจายเวลาซิงก์ (`agent/src/schedule.ts`)

ทุกเครื่องตั้ง "ทุก 1 ชั่วโมง" เหมือนกัน = ตื่นพร้อมกันทุกต้นชั่วโมง

- offset มาจาก `sha256(agentId)` → **เครื่องเดิมได้ช่องเดิมเสมอ** (คาดเดาได้ ตรวจสอบได้)
- แบบ interval กระจายใน 5 นาที แต่ **ไม่เกินความยาว interval เอง**
- แบบเวลาที่ตั้งไว้ (เช่น 08:00) ขยับได้แค่ **ภายในนาทีเดียวกัน** (≤45 วินาที)
  เวลาที่เจ้าหน้าที่ตั้งคือเวลาที่ตั้งใจ ห้ามเลื่อนไป 08:04
- **"ซิงก์เดี๋ยวนี้" ไม่หน่วงเลย** คนกดรออยู่หน้าจอ ไม่ใช่ส่วนหนึ่งของฝูง
- `nextSyncAt` ใน `status.json` คือเวลาที่จะรันจริง (รวม offset แล้ว) ไม่ใช่เวลาตามตารางเปล่า

## 5. Validation (ฝั่ง Central)

แถวจะถูก reject รายแถว (ไม่ล้มทั้ง batch) เมื่อ:
`drug_code` ว่าง · `visit_no` ไม่ใช่จำนวนเต็มบวก · `usage_date` ผิดรูปแบบ/เป็นอนาคต ·
`quantity` ไม่ใช่ตัวเลข หรือ < 0 หรือ > 1,000,000

เหตุผลถูกเก็บใน `sync_rejects` และนับใน `sync_batches.records_rejected`
ทั้ง batch จะล้มก็ต่อเมื่อ pcucode ไม่ตรงกับสถานบริการ (กันข้อมูลข้ามสถานบริการ)

## 6. Retry / backoff

`withRetry()` — exponential backoff + jitter, 5 ครั้ง, เริ่ม 2 วินาที
หยุดทันทีเมื่อเป็น 4xx ถาวร; ยืดต่อเมื่อเป็นปัญหาเครือข่าย

**429 / 503 ที่มี `Retry-After`** — ศูนย์กลางบอกเวลาที่ควรกลับมา agent ต้องเชื่อ
ไม่ใช่ backoff ของตัวเอง (`parseRetryAfter()` รับทั้งวินาทีและ HTTP-date จำกัดที่ 300 วินาที)
ถ้าทุกเครื่องคำนวณ backoff เอง จะกลับมาพร้อมกันอีกรอบซึ่งคือปัญหาเดิม

## 7. ขนาด chunk (วัดจริง 2026-09-06)

| ค่า | ที่ไหน | เหตุผล |
|---|---|---|
| `UPLOAD_CHUNK_SIZE = 500` | `src/lib/services/sync.ts` | ขนาด request ที่ agent ส่ง |
| `UPSERT_CHUNK = 500` | เดียวกัน | 1 chunk = 1 statement (เดิม 200) |
| `MAX_PENDING_CHUNKS = 12` | `agent/src/sync.ts` | เพดานคิว ≈ 6,000 แถวบนดิสก์ |

วัดกับ TiDB Cloud จริง (4,650 แถว, 10 request): `UPSERT_CHUNK` 500 = **~565 ms/request**
เทียบกับ 200 = **~663 ms** ส่วนต่างคือจำนวน round trip ไม่ใช่ปริมาณงาน
500 แถวของ `drug_usage` ≈ 150KB อยู่ในขอบเขต packet/transaction ของ TiDB สบาย ๆ

> **ระวังตอนวัดใหม่:** request แรกหลังเปิด server ช้ากว่าปกติหลายเท่า (เคยวัดได้ p95 19.7 วินาที
> แล้วเข้าใจผิดว่า TiDB เป็นคอขวด) ต้องรันซ้ำอย่างน้อย 3 รอบแล้วทิ้งรอบแรก
> เครื่องมือคือ `agent/measure-central.mts` (ยิงเข้า Central จริง) กับ `agent/bench.mts` (mock Central)
