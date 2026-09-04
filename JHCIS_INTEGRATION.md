# JHCISDB Integration — Drug Dispensing / Drug Usage

เพิ่มระบบเชื่อมต่อ JHCISDB ของแต่ละ รพ.สต. เพื่อดึงข้อมูลการจ่ายยาให้ผู้รับบริการ และนำมาประมวลผลเป็นรายงาน "ปริมาณการจ่ายยา"

ระบบต้องรองรับ JHCISDB หลายเวอร์ชัน โดยสถานบริการแต่ละแห่งอาจใช้ JHCIS ตั้งแต่ V5.1 ขึ้นไปจนถึงเวอร์ชันใหม่กว่า

IMPORTANT:

อย่าสมมติโครงสร้าง table/column อื่นที่ยังไม่ได้ยืนยัน

ให้ตรวจสอบ schema ของ JHCISDB จาก database จริงก่อน

---

# 1. JHCISDB Connection

ใน Local Development สามารถทดลองเชื่อมต่อ JHCISDB ที่ localhost ได้

ตัวอย่าง configuration:

Host:
localhost

Port:
3333

Database:
JHCISDB

Username:
root

Password:
******** (ค่า dev เก็บใน agent/.env เท่านั้น ไม่ commit ตามข้อกำหนดด้านล่าง)

Database engine:
MySQL

IMPORTANT:

credential ชุดนี้ใช้สำหรับ Local Development/Test เท่านั้น

ห้าม:

* hardcode ใน source code
* commit ลง Git
* ใส่ใน GitHub
* ใส่ใน frontend
* expose ผ่าน API
* แสดง password ใน UI

ให้เก็บผ่าน environment variables

ตัวอย่าง:

JHCIS_DB_HOST=localhost
JHCIS_DB_PORT=3333
JHCIS_DB_DATABASE=JHCISDB
JHCIS_DB_USER=root
JHCIS_DB_PASSWORD=...

สร้าง `.env.example` โดยไม่ใส่ password จริง

---

# 2. Agent ต้องเป็นผู้เชื่อมต่อ JHCISDB

Central Server / Vercel ห้ามเชื่อมต่อ JHCISDB โดยตรง

Architecture:

JHCISDB
↓
Local Agent
↓
JHCIS Adapter
↓
Data Extraction
↓
Validation / Normalization
↓
HTTPS
↓
Central API
↓
TiDB Cloud
↓
Web Dashboard

ดังนั้น connection configuration ของ JHCISDB ต้องอยู่ที่ Agent

---

# 3. JHCISDB Version Compatibility

เนื่องจากแต่ละสถานบริการอาจใช้:

JHCIS V5.1
และ version ใหม่กว่า

ห้าม assume ว่าทุก version มี schema เหมือนกัน 100%

สร้าง JHCIS adapter layer

ตัวอย่างแนวคิด:

JHCISAdapter
├── Connection
├── SchemaInspector
├── DrugRepository
├── VisitRepository
├── VisitDrugRepository
└── UsageExtractor

ก่อนเริ่ม extraction ให้ Agent สามารถตรวจสอบ:

* MySQL version
* JHCIS version ถ้าสามารถอ่านได้
* available tables
* available columns
* schema compatibility

แล้วรายงานกลับ Central ว่า:

JHCIS Version
Database connection status
Schema compatibility
Supported features

---

# 4. Drug Master

ข้อมูลรายการยาอยู่ที่:

cdrug

column สำคัญ:

drugcode
drugname
drugtype
drugflag

ความหมาย:

drugtype = 01
ยาแผนปัจจุบัน

drugtype = 10
ยาสมุนไพร

drugtype = 05
วัคซีน

drugflag = 1
เปิดใช้งาน

drugflag = 2
ปิดใช้งาน

ต้องสร้าง JHCIS Drug Repository สำหรับอ่านข้อมูลนี้

ข้อมูลกลางที่ควรส่งมายัง Central อย่างน้อย:

facility_id
drugcode
drugname
drugtype
drugflag
source_version
synced_at

---

# 5. Visit / Patient Service

การจ่ายยาอ้างอิงผู้รับบริการผ่าน:

visitno

โดย `visitno` เป็น reference สำคัญที่เชื่อมโยงรายการจ่ายยากับ visit/service

อย่าเก็บข้อมูลผู้ป่วยที่ไม่จำเป็น

สำหรับรายงานปริมาณการจ่ายยา เป้าหมายหลักคือ:

Visit
→ VisitDrug
→ Drug

---

# 6. VisitDrug

ข้อมูลการจ่ายยาอยู่ใน:

visitdrug

โดยอ้างอิง:

visitno

และมีรายการรหัสยาที่ถูกสั่งจ่ายตาม type

ต้องตรวจสอบ schema จริงของ `visitdrug` ก่อน implementation

ห้ามเดาชื่อ column ปริมาณยา

ให้ Agent inspect:

SHOW COLUMNS FROM visitdrug;

หรือ information_schema

แล้วค้นหา column ที่เกี่ยวข้องกับ:

* drugcode
* visitno
* quantity
* unit
* dosage
* usage
* date/time
* status

จาก schema จริง

---

# 7. IMPORTANT — ห้ามเดา Column ปริมาณ

เราทราบแน่นอนว่า:

cdrug.drugcode
cdrug.drugname
cdrug.drugtype
cdrug.drugflag

และ:

visitdrug
อ้างอิง visitno

แต่ชื่อ column ที่เก็บ "จำนวนที่จ่าย" ใน visitdrug ยังต้องตรวจสอบจาก JHCISDB จริง

ดังนั้น:

ให้ Agent เชื่อมต่อ localhost JHCISDB

ตรวจสอบ schema จริง

จากนั้นสร้าง mapping

เช่น:

JHCIS column
→ Canonical field

ตัวอย่าง:

visitno
→ visit_no

drugcode
→ drug_code

quantity column จริง
→ quantity

unit column จริง
→ unit

ห้ามสร้าง column สมมติ

---

# 8. First Local Connection Test

ให้สร้าง command สำหรับทดสอบ connection

ตัวอย่าง:

agent doctor

หรือ:

agent test-jhcis

ต้องแสดง:

## JHCIS Connection

Host: localhost
Port: 3333
Database: JHCISDB
Status: CONNECTED

Database:
MySQL version: ...

JHCIS:
Version: ...

Schema:
cdrug: FOUND
visitdrug: FOUND

Drug:
drugcode: FOUND
drugname: FOUND
drugtype: FOUND
drugflag: FOUND

VisitDrug:
visitno: FOUND
drugcode: FOUND
quantity: FOUND/NOT FOUND

ถ้า column ใดไม่พบ:

ต้องบอกชื่อ column ที่ต้องการตรวจสอบ

ห้าม silently fail

---

# 9. Schema Discovery

สร้าง SchemaInspector

สามารถตรวจสอบ:

information_schema.tables

information_schema.columns

และสามารถตรวจ:

SHOW TABLES

SHOW COLUMNS FROM cdrug

SHOW COLUMNS FROM visitdrug

ต้องสร้าง compatibility report

ตัวอย่าง:

{
"database": "JHCISDB",
"mysql_version": "...",
"jhcis_version": "...",
"tables": {
"cdrug": true,
"visitdrug": true
},
"drug_schema": {
"drugcode": true,
"drugname": true,
"drugtype": true,
"drugflag": true
}
}

---

# 10. Drug Dispensing Extraction

เป้าหมายหลัก:

ดึงข้อมูล "ปริมาณการจ่ายยา"

Logical relationship:

visit
↓ visitno
visitdrug
↓ drugcode
cdrug

ดังนั้น canonical record ควรมีอย่างน้อย:

facility_id
visit_no
drug_code
drug_name
drug_type
drug_flag
quantity
unit
dispensed_at
source
source_version

เฉพาะ field ที่สามารถยืนยันจาก schema จริงเท่านั้น

---

# 11. Date Filtering

Agent ต้องสามารถดึงข้อมูลตามช่วงเวลา

เช่น:

FROM:
2026-09-01

TO:
2026-09-04

ห้ามดึงข้อมูลทั้งฐานทุกครั้ง

ต้องรองรับ:

Initial Sync

Incremental Sync

Manual Date Range Sync

---

# 12. Incremental Sync

หลัง sync สำเร็จ Agent ต้องรู้ว่าดึงถึงจุดไหนแล้ว

เช่น:

last_dispensed_at

หรือ key/sequence ที่เหมาะสมกับ schema จริง

ถ้า JHCIS ไม่มี reliable timestamp:

ให้สร้าง strategy ที่ปลอดภัย เช่น date window + deterministic unique key

ต้องไม่ทำให้ข้อมูลซ้ำเมื่อ sync รอบถัดไป

---

# 13. Duplicate Protection

ข้อมูลเดียวกันอาจถูกส่งซ้ำเนื่องจาก:

* retry
* network failure
* Agent restart
* timeout
* manual sync

Central ต้องสามารถตรวจ duplicate

สร้าง deterministic record key จากข้อมูลที่มีจริง เช่น:

facility_id
+
visit_no
+
drug_code
+
dispensing record identifier

อย่าใช้ random UUID เป็นตัวป้องกัน duplicate เพียงอย่างเดียว

---

# 14. Drug Type

รายงานต้องสามารถแยก:

ยาแผนปัจจุบัน
drugtype = 01

ยาสมุนไพร
drugtype = 10

วัคซีน
drugtype = 05

และต้องสามารถแสดง:

ทั้งหมด

หรือ filter ตามประเภท

---

# 15. Drug Active Status

cdrug.drugflag:

1 = เปิดใช้งาน

2 = ปิดใช้งาน

ต้องเก็บสถานะนี้ไว้

แต่ IMPORTANT:

อย่าตัดข้อมูลการจ่ายยาเก่าทิ้งเพียงเพราะปัจจุบัน drugflag = 2

ตัวอย่าง:

ยาถูกปิดใช้งานในปี 2026

แต่มีการจ่ายในปี 2025

ข้อมูลการจ่ายยาในปี 2025 ต้องยังอยู่ในรายงาน

---

# 16. Historical Drug Name

ระวังกรณี:

drugcode เดิม
แต่ drugname เปลี่ยนในภายหลัง

ระบบต้องพิจารณาเก็บ snapshot ของชื่อยาที่ใช้ในขณะที่ sync

เพื่อให้ historical report ไม่เปลี่ยนผิดความหมายเมื่อ master data เปลี่ยน

---

# 17. Central Database

สร้าง canonical model แยกจาก JHCIS schema

ห้ามเอา JHCIS table มา mirror ทั้งหมดโดยไม่จำเป็น

ตัวอย่าง:

drugs

drug_usage

facilities

agents

sync_batches

schema_versions

drug_usage ต้องสามารถ query:

facility
drug
date
drug_type

ได้อย่างรวดเร็ว

---

# 18. Drug Usage Report

สร้างหน้า:

/reports/drug-usage

Filter:

* วันที่เริ่มต้น
* วันที่สิ้นสุด
* ประเภทยา
* ยา
* Facility (เฉพาะ Admin)

แสดง:

ลำดับ
รหัสยา
ชื่อยา
ประเภท
จำนวนจ่าย
หน่วย
ช่วงเวลา

---

# 19. Summary

ด้านบนแสดง:

จำนวนรายการจ่าย
จำนวนยาที่มีการจ่าย
ปริมาณรวม
จำนวนประเภทของยา

เช่น:

รายการจ่ายยา
12,453 รายการ

จำนวนรายการยา
387 รายการ

ปริมาณรวม
85,421 หน่วย

---

# 20. Drug Detail

เมื่อกดรายการยา:

แสดง:

ชื่อยา
รหัสยา
ประเภท
สถานะ

Usage trend

ตาราง:

วันที่
จำนวนจ่าย
หน่วย

ถ้า User เป็น Admin:

สามารถดูแยก Facility ได้

---

# 21. Facility Isolation

สำคัญมาก

User ของ รพ.สต. A:

สามารถ query:

facility_id = A

เท่านั้น

ห้ามรับ facility_id จาก frontend แล้วเชื่อทันที

Server ต้อง derive facility scope จาก authenticated user

Super Admin สามารถเลือก facility ได้

---

# 22. Agent Sync

ทุก sync ต้องสร้าง:

sync_batch

เก็บ:

batch_id
agent_id
facility_id
started_at
completed_at
records_read
records_uploaded
records_accepted
records_rejected
status
error

---

# 23. Data Validation

ก่อน upload:

ตรวจ:

drugcode ไม่ว่าง
visitno ไม่ว่าง
quantity ต้องเป็น numeric ถ้า field จริงเป็น numeric
quantity ต้องไม่เป็นค่าผิดปกติ
วันที่ต้อง valid
drugtype ต้องอยู่ในค่าที่รองรับ ถ้ามีการกำหนด
facility ต้องตรงกับ Agent

ข้อมูลผิดต้องถูกแยกเป็น rejected records

ไม่ควรทำให้ทั้ง batch ล้มเพราะ record เดียวผิด ถ้าไม่จำเป็น

---

# 24. Local Agent Logs

Agent ต้อง log:

Connection
Schema detection
Extraction
Validation
Upload
Retry
Error

แต่ห้าม log:

password
access token
ข้อมูลส่วนบุคคลที่ไม่จำเป็น

---

# 25. Security

JHCIS credentials ต้องอยู่ local ที่ Agent เท่านั้น

Central Server ไม่จำเป็นต้องรู้ JHCIS password

ห้ามส่ง JHCIS password ไป Central API

Central รู้เพียง:

Agent
Facility
JHCIS version
Connection status
Sync status

---

# 26. Development Test

สามารถใช้ Localhost JHCISDB ที่:

localhost:3333

เพื่อทดสอบ Agent ได้

ให้สร้าง development command ที่สามารถ:

1. connect
2. inspect schema
3. detect JHCIS version
4. inspect cdrug
5. inspect visitdrug
6. identify actual quantity column
7. execute test query
8. display sample records

IMPORTANT:

ตอนทดสอบให้แสดงเฉพาะข้อมูลที่จำเป็น

หากพบข้อมูลผู้ป่วย:

อย่า print ชื่อ
เลขบัตรประชาชน
ที่อยู่
เบอร์โทรศัพท์
หรือข้อมูลส่วนบุคคลลง console

แสดงเฉพาะ:

visitno
drugcode
drugname
quantity
date

เท่าที่จำเป็นต่อการทดสอบ

---

# 27. Test Query

หลังตรวจ schema จริงแล้ว ให้สร้าง query สำหรับทดลองดึงข้อมูลการจ่ายยา

ต้อง:

* JOIN จาก visitdrug → cdrug ตาม schema จริง
* ตรวจสอบ quantity column จริง
* จำกัดจำนวน record สำหรับ test
* รองรับ date filter
* ไม่ใช้ SELECT * ใน production extraction
* ระบุ columns ที่ต้องการชัดเจน

ก่อนเขียน production extractor:

ให้ทดลอง query กับ Localhost JHCISDB ก่อน

และตรวจว่าผลลัพธ์:

รหัสยา
ชื่อยา
จำนวนจ่าย
วันที่
visitno

ถูกต้องจริง

---

# 28. Version Adapter

ถ้าพบว่า JHCIS V5.1 และ version ใหม่มี schema ต่างกัน:

อย่าแก้ด้วย hardcoded query เดียว

ให้สร้าง adapter/version capability

ตัวอย่าง:

JHCIS V5 Adapter

JHCIS V6+ Adapter

หรือ capability detection:

supportsDrugUsage
supportsQuantity
supportsDispensedDate
supportsDrugType

เพื่อให้ระบบรองรับสถานบริการที่ใช้ JHCIS คนละ version

---

# 29. Important Rule

สิ่งที่เราทราบแน่นอน:

cdrug

* drugcode
* drugname
* drugtype
* drugflag

visitdrug

* มีความสัมพันธ์กับ visitno
* เก็บรายการยาที่จ่าย

แต่รายละเอียด column อื่นของ visitdrug:

ห้ามเดา

ให้ตรวจจาก JHCISDB จริง

---

# 30. Acceptance Criteria

ถือว่างานส่วนนี้เสร็จเมื่อ:

[ ] Agent connect localhost:3333 ได้
[ ] ตรวจ MySQL version ได้
[ ] ตรวจ JHCIS schema ได้
[ ] พบ cdrug
[ ] พบ visitdrug
[ ] อ่าน cdrug.drugcode ได้
[ ] อ่าน cdrug.drugname ได้
[ ] อ่าน cdrug.drugtype ได้
[ ] อ่าน cdrug.drugflag ได้
[ ] ตรวจ relationship visitno ได้
[ ] ตรวจ column จำนวนจ่ายจาก schema จริงได้
[ ] ดึงตัวอย่างข้อมูลการจ่ายยาได้
[ ] สามารถ filter วันที่ได้
[ ] สามารถแยก drugtype ได้
[ ] สามารถ sync เข้า Central ได้
[ ] มี sync batch
[ ] มี duplicate protection
[ ] retry ได้
[ ] Facility isolation ทำงาน
[ ] ไม่ส่ง JHCIS password ไป Central
[ ] ไม่มี secret ใน Git
[ ] lint ผ่าน
[ ] typecheck ผ่าน
[ ] build ผ่าน

---

# FINAL INSTRUCTION

เริ่มจาก Local JHCISDB ก่อน

อย่าเดา schema

ให้ Agent ตรวจสอบ database จริง

หลังจากตรวจพบ schema แล้ว:

1. แสดง schema ที่ค้นพบ
2. ระบุ column จริงที่ใช้เชื่อม visitdrug กับ cdrug
3. ระบุ column จริงที่เก็บจำนวนจ่ายยา
4. ระบุ column จริงที่เก็บวันที่จ่าย/วันที่บริการ
5. ทดลอง query
6. แสดงตัวอย่างผลลัพธ์ที่ไม่เปิดเผยข้อมูลส่วนบุคคล
7. จากนั้นจึงสร้าง production extractor

หาก schema ของ JHCIS ที่ localhost แตกต่างจากที่ requirement ระบุ ให้ยึด schema จริงเป็นหลัก และสร้าง adapter ให้รองรับความแตกต่างนั้น

อย่าแก้ database JHCISDB ต้นทาง

Agent ต้องเป็น READ-ONLY ต่อ JHCISDB

ห้าม INSERT / UPDATE / DELETE ข้อมูลใน JHCISDB

เป้าหมายคือ:

JHCISDB → อ่านข้อมูล → ประมวลผล → ส่ง Central → TiDB → รายงานปริมาณการจ่ายยา
