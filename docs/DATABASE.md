# DATABASE — Central Database (TiDB Cloud)

Schema ทั้งหมดอยู่ในไฟล์เดียว: `src/lib/db/schema.ts`
Migration: `npm run db:generate` → ไฟล์ใน `drizzle/` → `npm run db:migrate`

## ตาราง

| ตาราง | หน้าที่ | คีย์สำคัญ |
|---|---|---|
| `users` | ผู้ใช้ + role + facility ที่ผูก | `users_email_uq` |
| `facilities` | รพ.สต. | `facilities_code_uq`, `facilities_pcucode_uq` |
| `facility_users` | สิทธิ์เพิ่มเติมข้ามสถานบริการ | PK (facility_id, user_id) |
| `agents` | Agent ของแต่ละสถานบริการ + สถานะ + watermark | `agents_facility_idx` |
| `agent_credentials` | keyId + secret (เข้ารหัส AES-256-GCM) | `agent_credentials_key_uq` |
| `agent_enrollment_tokens` | token ครั้งเดียว มีวันหมดอายุ (เก็บเป็น hash) | `..._hash_uq` |
| `agent_request_nonces` | กัน replay | PK nonce |
| `sync_batches` | ประวัติทุกรอบ sync | `sync_batches_ref_uq (agent_id, batch_ref)` |
| `sync_upload_receipts` | ผลประมวลผล upload chunk แบบ exactly-once | `sync_upload_receipts_identity_uq (agent_id, batch_id, chunk_ref)` |
| `sync_rejects` | เฉพาะแถวที่ถูกปฏิเสธ พร้อมเหตุผล | `sync_rejects_batch_idx` |
| `drugs` | drug master ต่อสถานบริการ | `drugs_facility_code_uq` |
| `drug_usage` | ข้อมูลการจ่ายยา (ตารางใหญ่) | `drug_usage_record_key_uq` |
| `audit_logs` | เหตุการณ์สำคัญ | 3 index ตาม facility/actor/action |
| `system_settings` | ค่าตั้งระบบ | PK setting_key |

ทุกตารางมี `created_at` / `updated_at` (ยกเว้นตารางที่เป็น log ล้วน)

## drug_usage — หัวใจของระบบ

```
record_key    char(64)  UNIQUE  = sha256(facility_id|pcucode|visit_no|drug_code)
facility_id   varchar(30)
drug_code     varchar(24)
drug_name_snapshot varchar(255)   -- ชื่อยา ณ เวลาที่ sync (กันชื่อยาเปลี่ยนย้อนหลัง)
drug_type     varchar(2)
visit_no      bigint               -- reference ของ JHCIS เท่านั้น ไม่ใช่ตัวระบุผู้ป่วย
usage_date    date
quantity      decimal(14,2)        -- มาจาก visitdrug.unit
unit          varchar(15)          -- มาจาก cdrug.unitsell
sync_batch_id / agent_id / source_pcucode / source_version
```

Index ที่ออกแบบให้ตรงกับ query ของรายงาน:

| index | รองรับ query |
|---|---|
| `drug_usage_report_idx (facility_id, usage_date, drug_code)` | รายงานตามช่วงวันที่ / trend |
| `drug_usage_drug_idx (facility_id, drug_code, usage_date)` | หน้ารายละเอียดยา |
| `drug_usage_type_idx (facility_id, drug_type, usage_date)` | filter ตามประเภทยา |
| `drug_usage_batch_idx (sync_batch_id)` | ตรวจสอบรายรอบ sync |
| `drug_usage_agent_idx (agent_id, usage_date)` | monitoring |

`facility_id` เป็นคอลัมน์แรกของทุก index ที่ใช้กับรายงาน — การกรองตามสถานบริการจึงไม่เคย full scan

## ทำไมไม่ใช้ FOREIGN KEY

TiDB เพิ่งรองรับ FK และมีต้นทุนตรวจสอบต่อการ INSERT ... ON DUPLICATE KEY UPDATE
จำนวนมาก ระบบนี้เขียน drug_usage ทีละหลายร้อยแถวต่อ statement และคาดว่าจะโตถึงหลักล้านแถว
จึงเลือกรักษา referential integrity ที่ชั้น service แทน:

- ทุกการเขียน `drug_usage` / `sync_batches` เกิดหลัง `authenticateAgent()` เท่านั้น
  ซึ่ง join `agent_credentials → agents → facilities` มาแล้ว จึงการันตีว่า facility/agent มีจริง
- การเขียนจากหน้าเว็บผ่าน server action ที่ตรวจ `canManageFacility()` ก่อนเสมอ

ถ้าภายหลังต้องการ FK จริง ให้เพิ่มเฉพาะตารางที่เขียนไม่บ่อย (users, agents, facilities)

## เรื่องที่ต้องระวัง

- **อย่าลบข้อมูลการจ่ายยาเก่าเพราะ `drugflag = 2`** — ยาถูกปิดใช้งานภายหลังได้
  แต่ประวัติการจ่ายต้องคงอยู่ (JHCIS_INTEGRATION §15)
- **อย่า aggregate ใน Node** — ใช้ SUM/COUNT/GROUP BY ในฐานข้อมูลเสมอ (`src/lib/services/reports.ts`)
- **`agent_request_nonces` โตเร็ว** — มี cleanup แบบสุ่ม 2% ต่อ request ตัดที่ 2 เท่าของ skew window

## Global Sync Start Date storage (Central foundation, migration 0012)

Phase B ใช้โครงสร้างเดิมโดยไม่สร้าง subsystem คู่ขนาน:

- เก็บนโยบายเดียวใน `system_settings.setting_key = 'global_sync_start_date_policy'`
- JSON value มี schema version, desired date/revision, active date/revision, ผู้แก้และเวลา
  รวมถึง backfill plan แบบ optional
- การไม่มี row นี้คือสถานะ legacy ที่ถูกต้อง ไม่ใช่ migration error และไม่ต้อง seed ค่าเริ่มต้น
- update policy ต้อง lock/compare-and-set ใน transaction การบันทึกวันเดิมไม่เพิ่ม revision
  และ revision ห้ามลดลงแม้เป็น rollback

Migration `0012_global_sync_start_date.sql` เพิ่มเพียง nullable acknowledgement fields
`agents.global_sync_start_date_applied_revision` และ `agents.global_sync_start_date_applied_at`
จึงใช้กับ row เดิมได้โดยไม่ backfill และไม่แก้ Agent identity, facility binding, credential,
enrollment, watermark, pause state หรือ update state เดิม ไม่มี policy row ถูก seed

Migration `0014_global_sync_backfill.sql` เพิ่มเฉพาะตาราง lifecycle ของ historical request และ
nullable queue/quarantine telemetry บน `agents` ค่า `NULL` หมายถึง `UNKNOWN` โครงสร้างนี้ไม่แก้
ความหมายของ `pending_batches`, `failed_count` หรือ `sync_requested_*`; ดู contract และ transition
ทั้งหมดใน [GLOBAL_SYNC_BACKFILL.md](GLOBAL_SYNC_BACKFILL.md)

Migration `0013_sync_upload_receipts.sql` เพิ่มตาราง receipt เท่านั้น โดยเก็บ authenticated Agent,
batch, stable chunk reference, payload SHA-256, status, accepted/rejected counts, stable JSON result
และเวลา created/completed ภายใต้ unique key `(agent_id, batch_id, chunk_ref)` การสร้าง/จบ receipt,
fact upsert, reject และ batch counters อยู่ transaction เดียวกัน จึง retry หลัง timeout ได้โดยไม่เพิ่ม
counter/reject ซ้ำ ตารางนี้ไม่แก้ `drug_usage` key, watermark หรือ Global Sync Start Date schema
และไม่ได้เปิด historical backfill

Production apply additive migrations 0012, 0013 และ 0014 ตามลำดับแล้ว การมี schema เหล่านี้ไม่เท่ากับ
การ activate Global Sync Start Date; active revision ปัจจุบันยังเป็น `0` และ historical backfill ไม่มี
