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

## 4. คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `doctor` | ตรวจการเชื่อมต่อ + schema จริง + mapping + ตัวอย่างข้อมูล (ไม่แสดงข้อมูลผู้ป่วย) |
| `enroll --token <TOKEN> [--url <CENTRAL>]` | แลก token เป็น credential |
| `sync [--mode INITIAL\|INCREMENTAL\|MANUAL_RANGE] [--from] [--to] [--dry-run]` | ซิงก์หนึ่งรอบ |
| `retry` | ส่ง chunk ที่ค้าง/ล้มเหลวใหม่ |
| `run` | heartbeat ทุก 5 นาที + ซิงก์ตามรอบที่ Central กำหนด |
| `status` | สรุปสถานะในเครื่อง (watermark, คิวค้าง) |

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
data/logs/agent-YYYY-MM-DD.log
```

Log ผ่านตัวกรอง redact — คำที่เข้าข่าย password/secret/token/signature จะถูกแทนที่เสมอ
และไม่มีการ log ชื่อ/เลขบัตร/ที่อยู่/เบอร์โทรของผู้รับบริการ

## 7. เมื่อ JHCIS เป็นเวอร์ชันอื่น

`SchemaInspector` ตรวจ schema จริงทุกครั้งก่อนดึงข้อมูล และเลือกคอลัมน์จากรายการผู้สมัคร
(จำนวนจ่าย: `unit` → `qty` → `quantity` → `amount` …) ถ้าหาไม่พบ Agent จะ **หยุดและรายงาน**
ว่าต้องตรวจคอลัมน์ใด ไม่เดา ไม่ fail เงียบ ผลการตรวจถูกส่งขึ้น Central ให้ผู้ดูแลเห็นในหน้า Agent
