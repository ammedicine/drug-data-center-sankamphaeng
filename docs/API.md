# API — Central API สำหรับ Agent

Base URL: `https://<central>/api/agent`
ทุก endpoint ยกเว้น `/enroll` ต้องลงลายเซ็น HMAC

## 1. การลงลายเซ็น

Header ที่ต้องส่งทุกครั้ง:

| Header | ค่า |
|---|---|
| `X-Agent-Key` | keyId ที่ได้ตอน enroll |
| `X-Agent-Timestamp` | unix seconds (เพี้ยนได้ไม่เกิน `AGENT_SIGNATURE_MAX_SKEW_SECONDS`, ค่าเริ่มต้น 300) |
| `X-Agent-Nonce` | สุ่ม 16–64 ตัวอักษร ใช้ได้ครั้งเดียว |
| `X-Agent-Signature` | HMAC-SHA256 (hex) |
| `X-Agent-Version` | เวอร์ชัน Agent |

ข้อความที่นำมาลงลายเซ็น (`buildSigningString`):

```
METHOD \n path \n timestamp \n nonce \n sha256(body)
```

`signature = HMAC_SHA256(secret, signingString)`

การลงลายเซ็นผูกกับ **method + path + เวลา + nonce + เนื้อหา** ครบทั้งห้าอย่าง
จึงกันทั้ง replay, การแก้ payload และการยิงข้าม endpoint

Server ปฏิเสธเมื่อ: header ไม่ครบ (401), เวลาเพี้ยนเกินกำหนด (401), ลายเซ็นผิด (401),
nonce ซ้ำ (409 `REPLAY_DETECTED`), agent ถูกถอนสิทธิ์ (403), เกิน rate limit (429)

**สำคัญ:** `facility_id` ที่ client ส่งมาไม่ถูกใช้เลย — facility มาจาก credential ที่ผ่านการยืนยันแล้ว
และ `pcucode` ที่ Agent รายงานต้องตรงกับ `facilities.jhcis_pcucode` มิฉะนั้น 403 `PCUCODE_MISMATCH`

## 2. Endpoints

### POST /api/agent/enroll  (ไม่ลงลายเซ็น — ใช้ token ครั้งเดียว)

```json
{ "token": "ENR-...", "hostname": "PC-RPST-01", "installationId": "...",
  "agentVersion": "1.0.0", "pcucode": "05957" }
```

ตอบกลับ (แสดง secret ครั้งเดียวเท่านั้น):

```json
{ "agentId": "...", "keyId": "AK...", "secret": "...",
  "facility": { "id": "...", "code": "RPST-01", "name": "...", "pcucode": "05957" },
  "syncIntervalMinutes": 60, "reprocessDays": 7 }
```

Error: `INVALID_TOKEN` 401 · `TOKEN_USED` 409 · `TOKEN_EXPIRED` 410 · `PCUCODE_MISMATCH` 403

### POST /api/agent/heartbeat

ส่งสถานะ + schema report (ไม่มี credential ของ JHCIS ไม่มีข้อมูลผู้ป่วย)

```json
{ "agentVersion": "1.0.0", "hostname": "...", "installationId": "...",
  "status": "ONLINE", "jhcisConnected": true, "pcucode": "05957",
  "mysqlVersion": "5.6.45", "jhcisVersion": null,
  "schemaReport": { ... }, "pendingBatches": 0 }
```

ตอบ `{ ok, serverTime, config }` — `config` คือค่าที่ Central อนุมัติให้ Agent ใช้

### GET /api/agent/config

ตอบ `AgentConfigResponse`: facility, `expectedPcucode`, `syncIntervalMinutes`,
`reprocessDays`, `lastSyncedVisitDate` (watermark), `uploadChunkSize`, `disabled`,
`syncRequested` — เป็น true เมื่อผู้ดูแลกด "สั่งซิงก์เดี๋ยวนี้" บนเว็บ Agent จะเห็นค่านี้จาก
heartbeat รอบถัดไป (**ปกติภายใน 30 วินาที** ตาม `HEARTBEAT_INTERVAL_SECONDS`) แล้วเริ่มซิงก์ทันที
— Central เรียกเข้า LAN ของ รพ.สต. ไม่ได้ จึงต้องเป็น pull เท่านั้น
ถ้าเครื่องหลับ ปิด หรือเน็ตหลุด ไม่มีการรับประกัน 30 วินาที คำสั่งจะค้างรอจนกว่า agent จะกลับมา

### POST /api/agent/sync/start

```json
{ "batchRef": "SYNC-20260904-000001", "mode": "INCREMENTAL",
  "rangeFrom": "2026-08-01", "rangeTo": "2026-09-04",
  "pcucode": "05957", "recordsRead": 1234 }
```

ตอบ `{ batchId, resumed, uploadChunkSize }` — เรียกซ้ำด้วย `batchRef` เดิมได้ (`resumed: true`)

### POST /api/agent/sync/upload

```json
{ "batchRef": "SYNC-20260904-000001", "chunkRef": "SYNC-20260904-000001:000001",
  "payloadSha256": "<64 lowercase hex>", "pcucode": "05957", "sourceVersion": "5.6.45",
  "drugs": [ { "drugCode": "P76", "drugName": "DICLOXACILLIN", "drugType": "01", ... } ],
  "records": [ { "visitNo": 132449, "drugCode": "P76", "drugName": "...",
                 "drugType": "01", "quantity": 20, "unit": "009",
                 "clinic": null, "usageDate": "2026-08-07" } ] }
```

ตอบ `{ accepted, rejected, rejects: [{ recordKey, reason }] }`
สูงสุด 500 records ต่อครั้ง · แถวที่ผิดถูกปฏิเสธรายแถว ไม่ทำให้ทั้ง batch ล้ม
Agent ที่รองรับ `idempotentUploadChunk` ส่ง `chunkRef` และ `payloadSha256` เป็นคู่ โดย Central
คำนวณ hash จาก payload ซ้ำเอง ถ้า receipt เดิมเสร็จแล้วและ hash ตรงกันจะคืนผลเดิมโดยไม่ประมวลผล
หรือเพิ่ม counter/reject ซ้ำ; ถ้า `chunkRef` เดิมแต่ hash ต่างกันตอบ `409 CHUNK_PAYLOAD_CONFLICT`.
Concurrent duplicate ถูก serialize แล้วคืน stored result หลัง request แรก commit; ถ้ายังพิสูจน์
completion ของ receipt สถานะ `PROCESSING` ไม่ได้ ให้ตอบ `503 CHUNK_IN_PROGRESS` เพื่อ retry โดย
เก็บ queue เดิม และ database failure จะ rollback fact, reject, counter และ receipt พร้อมกัน

Agent รุ่นเก่าที่ไม่ส่งทั้งสอง field ยังใช้ legacy path เดิมได้: `record_key` ป้องกัน fact row ซ้ำ
แต่ไม่ได้รับประกัน chunk-processing idempotency สำหรับ counter/reject

### POST /api/agent/sync/complete

```json
{ "batchRef": "...", "status": "COMPLETED", "recordsRead": 1234,
  "recordsSent": 1234, "lastVisitDate": "2026-09-04", "errorMessage": null }
```

`COMPLETED` จะเลื่อน watermark `agents.last_synced_visit_date`

## 3. รูปแบบ error

```json
{ "error": { "code": "PCUCODE_MISMATCH", "message": "..." } }
```

## 4. Web API

`GET /api/reports/drug-usage/export?from&to&drugType&q&facility` → CSV (UTF-8 + BOM)
ใช้ session ของผู้ใช้ และผ่าน `resolveFacilityScope()` เหมือนหน้าจอทุกประการ

## 5. Global Sync Start Date protocol (additive Central contract implemented)

`POST /api/agent/heartbeat` รับ field optional เพิ่มเติมโดยไม่เปลี่ยน contract เดิม:

```json
{"appliedGlobalSyncStartDateRevision": 3}
```

ค่าต้องเป็น positive integer หรือ `null` และ Central บันทึกเฉพาะ revision ที่ใหม่กว่า โดยผูกกับ
Agent identity จาก HMAC credential ที่ authenticate แล้ว ไม่รับ Agent/facility identity จาก body
เมื่อมี policy response `config` จะมี field optional:

```json
{
  "globalSyncStartDatePolicy": {
    "schemaVersion": 1,
    "desiredDate": "2025-10-01",
    "desiredRevision": 3,
    "activeDate": null,
    "activeRevision": 0
  }
}
```

ถ้าไม่มี policy row จะ omit `globalSyncStartDatePolicy` และ Agent ทำงานแบบ legacy โดยไม่ต้อง
acknowledge ระบบยังไม่รับ quarantine telemetry

- `syncStartDate` capability/field เดิมไม่ถูกเปลี่ยนความหมาย
- ถ้าไม่มี global policy row Central ต้องไม่บังคับให้ Agent acknowledge และ Agent ต้องทำงานแบบ
  legacy ต่อด้วย local/default `syncStartDate`
- field ใหม่ต้องเป็น optional เพื่อให้ Agent รุ่นเก่าและ Central ที่อยู่ระหว่าง staged rollout ทำงานร่วมกันได้
- policy revision เป็นคนละค่ากับ pause `controlRevision`
- identity ของ acknowledgement มาจาก HMAC credential ที่ผ่านการยืนยันแล้วเท่านั้น

เมื่อมี active floor แล้ว endpoint `sync/start` และ `sync/upload` ตรวจ floor ก่อนเปลี่ยน
batch, counter, reject หรือ usage state ถ้า request/chunk มีข้อมูลต่ำกว่า active floor ให้ปฏิเสธทั้งชุด:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 45
Content-Type: application/json

{"error":{"code":"GLOBAL_SYNC_START_DATE_ENFORCED","message":"..."}}
```

ห้ามตอบ `2xx` พร้อมกรอง record ต่ำกว่า floor เงียบ ๆ และห้ามใช้ `4xx` เพราะ Agent ปัจจุบัน
ถือ `4xx` ถาวรและอาจย้ายคิวไป failed ส่วน `503` + `Retry-After` รักษา retry compatibility

Historical backfill จะใช้ `MANUAL_RANGE`/reconciliation ที่มีอยู่ ไม่สร้าง push API จาก Central
และเปิดได้เมื่อ Agent รายงานทั้ง `remoteSyncStartDate` และ `idempotentUploadChunk` เท่านั้น
forward-date operation ไม่ต้องรอ capability หลัง
