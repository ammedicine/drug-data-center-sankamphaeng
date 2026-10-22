# AGENT — ติดตั้งและใช้งาน Local Agent

Agent คือโปรแกรมที่ติดตั้งบนเครื่องในวง LAN ของ รพ.สต. ที่เข้าถึง JHCISDB ได้
ทำงานแบบ **outbound เท่านั้น** และ **อ่านอย่างเดียว** ต่อ JHCISDB

## 1. ข้อกำหนด

- Windows (หรือระบบใดก็ได้ที่รัน Node.js ได้), Node.js 18.17 ขึ้นไป
- เข้าถึง MySQL ของ JHCIS ได้ (บัญชีที่มีสิทธิ์ SELECT เท่านั้น — แนะนำให้สร้างบัญชีอ่านอย่างเดียว)
- ออกอินเทอร์เน็ตทาง HTTPS ได้ (ไม่ต้องเปิด port เข้า)

## 2. ติดตั้ง

```bash
cd agent
npm install
copy .env.example .env      # แล้วแก้ค่า
npm run build               # ได้ dist/ สำหรับใช้งานจริง
```

`.env` (ห้าม commit):

```
JHCIS_DB_HOST=localhost
JHCIS_DB_PORT=3333
JHCIS_DB_DATABASE=jhcisdb
JHCIS_DB_USER=readonly_user
JHCIS_DB_PASSWORD=********
CENTRAL_API_URL=https://<central>
AGENT_DATA_DIR=C:\ProgramData\sdc-agent\data
```

## 3. ขั้นตอนการเปิดใช้งาน (ตาม PROJECT_SPEC §23)

1. ผู้ดูแลส่วนกลางสร้าง Facility (ระบุ pcucode ให้ตรงกับ JHCIS ของแห่งนั้น)
2. สร้าง Agent ในหน้า `/admin/agents` → ระบบออก **enrollment token ครั้งเดียว หมดอายุ 60 นาที**
3. ติดตั้ง Agent บนเครื่อง รพ.สต.
4. ตรวจการเชื่อมต่อก่อน: `npm run doctor`
5. ลงทะเบียน: `node dist/agent/src/cli.js enroll --token ENR-xxxx`
6. Agent ได้ credential เฉพาะตัว เก็บไว้ที่ `agent.config.json` (สิทธิ์ 0600)
7. ทดสอบซิงก์ครั้งแรก: `... sync --mode INITIAL`
8. ตั้งให้ทำงานต่อเนื่อง: `... run`

## 3.5 โปรแกรมหน้าจอ (แนะนำสำหรับ รพ.สต.)

เจ้าหน้าที่ไม่ต้องใช้บรรทัดคำสั่ง ติดตั้งจากตัวติดตั้ง (ดู `agent/installer/README.md`) แล้ว:

- แท็บ **สถานะการทำงาน** - สถานะ JHCIS/ศูนย์กลาง, หลอดความคืบหน้า, ปุ่มซิงก์เดี๋ยวนี้ /
  ตรวจการเชื่อมต่อ / ส่งข้อมูลที่ค้างอีกครั้ง
- แท็บ **ตั้งค่า** - ตารางซิงก์ (ทุก N นาที หรือเวลาที่กำหนด เช่น 08:00, 16:30),
  เปิดพร้อม Windows, ย่อลงถาดระบบ, การเชื่อมต่อ JHCIS, ลงทะเบียนด้วย enrollment token
- แท็บ **บันทึกการทำงาน** - อ่าน log ล่าสุดโดยไม่ต้องเปิดไฟล์เอง
- ไอคอนถาดระบบ: เปิดหน้าต่าง / ซิงก์เดี๋ยวนี้ / ออกจากโปรแกรม

โปรแกรมหน้าจอเป็นเพียงตัวสั่งงาน ตรรกะการดึงข้อมูลยังเป็นตัว agent เดิมทั้งหมด
ทดสอบโดยไม่เปิดหน้าต่างได้ด้วย `gui\.venv\Scripts\python.exe gui\smoke_test.py`

## 4. คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `doctor` | ตรวจการเชื่อมต่อ + schema จริง + mapping + ตัวอย่างข้อมูล (ไม่แสดงข้อมูลผู้ป่วย) |
| `enroll --token <TOKEN> [--url <CENTRAL>]` | แลก token เป็น credential |
| `sync [--mode INITIAL\|INCREMENTAL\|MANUAL_RANGE] [--from] [--to] [--dry-run]` | ซิงก์หนึ่งรอบ |
| `retry` | ส่ง chunk ที่ค้าง/ล้มเหลวใหม่ |
| `run` | heartbeat ทุก **30 วินาที** + ซิงก์ตามรอบที่ Central กำหนด |
| `status` | สรุปสถานะในเครื่อง (watermark, คิวค้าง) |
| `settings [--interval N] [--times 08:00,16:30] [--auto true\|false]` | ดู/ตั้งตารางซิงก์ในเครื่อง |
| `verify [--from] [--to] [--check-only]` | เทียบจำนวนแถวรายเดือนกับศูนย์กลาง แล้วซ่อมส่วนที่ขาด |

ตัวอย่างผลลัพธ์ `doctor` จาก JHCIS V5.1 จริง:

```
MySQL version: 5.6.45      pcucode: 05957
cdrug: FOUND   visitdrug: FOUND   visit: FOUND
จำนวนจ่าย  -> visitdrug.unit
หน่วยนับ   -> cdrug.unitsell
วันที่จ่าย -> visit.visitdate
```

## 5. ติดตั้งเป็น Windows Service

ใช้ตัวห่อ service ตัวใดก็ได้ (NSSM, WinSW, Task Scheduler แบบ at-startup) ชี้ไปที่:

```
node C:\sdc-agent\dist\agent\src\cli.js run
```

ตั้ง working directory ให้เป็นโฟลเดอร์ที่มี `.env` และ `agent.config.json`
Service ต้องรันด้วยบัญชีที่อ่าน `agent.config.json` ได้เท่านั้น

## 6. ไฟล์ที่ Agent สร้าง

```
agent.config.json          credential + ค่าที่ Central อนุมัติ  ← ห้ามแชร์/commit
data/state.json            watermark + ลำดับ batch
data/queue/pending|failed  คิวออฟไลน์
data/queue/receipts        หลักฐาน chunk ที่ Central รับแล้วระหว่าง batch recovery
data/queue/normal-sync-recovery.json  normal batch identity/phase ที่ยังไม่ปิด
data/logs/agent-YYYY-MM-DD.log
```

Log ผ่านตัวกรอง redact — คำที่เข้าข่าย password/secret/token/signature จะถูกแทนที่เสมอ
และไม่มีการ log ชื่อ/เลขบัตร/ที่อยู่/เบอร์โทรของผู้รับบริการ

## 7. เมื่อ JHCIS เป็นเวอร์ชันอื่น

`SchemaInspector` ตรวจ schema จริงทุกครั้งก่อนดึงข้อมูล และเลือกคอลัมน์จากรายการผู้สมัคร
(จำนวนจ่าย: `unit` → `qty` → `quantity` → `amount` …) ถ้าหาไม่พบ Agent จะ **หยุดและรายงาน**
ว่าต้องตรวจคอลัมน์ใด ไม่เดา ไม่ fail เงียบ ผลการตรวจถูกส่งขึ้น Central ให้ผู้ดูแลเห็นในหน้า Agent

## 8. Global Sync Start Date และ durable recovery

Agent v1.1.17 ประกาศ capability `remoteSyncStartDate` รับ desired policy จาก
heartbeat บันทึก effective `syncStartDate` กับ applied revision แบบ temp+rename แล้วจึงรายงาน
acknowledgement กลับ Central revision นี้แยกจาก pause `controlRevision`

- ไม่มี policy จาก Central = ใช้ local/default `syncStartDate` เดิมและซิงก์ตามปกติ ไม่ต้อง ack
- `syncStartDate` เดิมยังเป็นค่าที่ใช้จริงและต้องอ่านได้เมื่อ downgrade; GUI/Tray ไม่ใช่ authority
  เพียงตัวเดียวเมื่อ managed policy เริ่มแล้ว
- เลื่อนไปข้างหน้าต้อง quarantine queue item ต่ำกว่า floor โดยไม่ลบ ไม่ reset watermark และไม่ลบ
  Central history
- เลื่อนย้อนหลังไม่เริ่ม backfill เอง ต้องรอคำสั่ง `MANUAL_RANGE` แบบ explicit และ reconciliation
- historical backfill ต้องมีทั้ง `remoteSyncStartDate` และ `idempotentUploadChunk`; forward move
  ไม่ต้องรอ `idempotentUploadChunk`
- Agent persist exact historical request และ batch ก่อนเริ่ม ใช้ `MANUAL_RANGE` เดิมแต่แยก intent,
  ไม่เลื่อน local/Central watermark และ retry ด้วย identity เดิม
- หลัง completion + reconciliation สำเร็จจึง mark quarantine coverage แบบ additive/idempotent
  แล้วรายงานซ้ำทาง heartbeat จน Central acknowledge; ดู
  [GLOBAL_SYNC_BACKFILL.md](GLOBAL_SYNC_BACKFILL.md)
- `idempotentUploadChunk` บันทึก `chunkRef` และ payload SHA-256 ในไฟล์ pending ก่อน request แรก
  retry/restart ใช้ identity และ payload เดิม; queue รุ่นเก่าที่ไม่มี field นี้ถูกเติมแบบ temp+rename
  เมื่อจะส่ง โดยไม่เปลี่ยน `record_key`, watermark หรือพฤติกรรมอ่าน JHCIS

การอัปเกรดต้องรักษา `agentId`, credential, enrollment, `%ProgramData%\SDCAgent`, settings,
queue/quarantine, pause/control state และ updater state เดิม Agent รุ่นเก่าหรือออฟไลน์ต้องคง
centrally paused จนกว่าอัปเกรด รับ policy และรายงาน applied แล้ว JHCIS ยังเป็น read-only ทุกกรณี

release/tag ที่เผยแพร่แล้วเป็น immutable: `v1.1.17` เป็น local/unpublished Dev build,
`v1.1.18` เผยแพร่แล้ว และ controlled-update patch รุ่นทดสอบถัดไปคือ `v1.1.19`

v1.1.18 เพิ่ม normal-sync recovery manifest ก่อน `sync/start`, durable acknowledged chunk receipts,
same-batch retry/restart/completion และล้าง recovery state หลัง Central completion, reconciliation และ
durable watermark เท่านั้น หลักฐาน legacy queue ต้องตรง exact batch/range/count มิฉะนั้นหยุดแบบ fail closed
กลไกนี้ไม่เปลี่ยน JHCIS query/write behavior, ordinary MANUAL_RANGE หรือ authorized historical backfill

ตั้งแต่ v1.1.19 งาน `SDCAgentAutoUpdate` ตรวจ GitHub latest เพื่อ discovery เท่านั้น การพบ release ใหม่
ทำได้เพียงบันทึก `AVAILABLE`; ห้าม download/install จนกว่าจะมี durable `agent_update_commands` ที่ส่งผ่าน
authenticated heartbeat และตรง exact Agent ID, version, asset name, optional size และ SHA-256 คำสั่ง terminal,
stale, ของ Agent อื่น หรือ metadata ไม่ตรงต้อง fail closed การ pause data sync ไม่ปิดสิทธิ์คำสั่ง update ที่ตรง
กัน และ restart ต้องใช้คำสั่งเดิมโดยไม่ขยายสิทธิ์ `%ProgramData%\SDCAgent` ทั้งหมดรวม queue ต้องคงเดิม
