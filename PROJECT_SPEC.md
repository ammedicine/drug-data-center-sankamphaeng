# Build: JHCIS Central Drug Usage Platform

## Central Web + Hospital Health Center Agents + TiDB Cloud + Vercel

สร้างระบบ Web Application สำหรับรวบรวมและวิเคราะห์ข้อมูลปริมาณการใช้ยาจาก JHCISDB ของโรงพยาบาลส่งเสริมสุขภาพตำบล (รพ.สต.) หลายแห่งที่อยู่คนละวง LAN และไม่สามารถเชื่อมต่อฐานข้อมูล JHCISDB เข้าหากันโดยตรง

ระบบต้องใช้สถาปัตยกรรม:

JHCISDB ของแต่ละ รพ.สต.
↓
Local Agent
↓ HTTPS
Central API
↓
TiDB Cloud
↓
Central Web
↓
ผู้ใช้ / Admin / รายงาน

---

# 1. Technology Stack

ใช้เทคโนโลยีที่เหมาะสมกับระบบเดิมของ repository

## Central Web

* Next.js
* TypeScript
* App Router
* Tailwind CSS
* ใช้ existing UI component system ถ้ามี
* Responsive
* Production-ready

## Database

ใช้ TiDB Cloud เป็น Central Database

ใช้ ORM ที่เหมาะสมกับ project เดิม เช่น Drizzle ORM

Database ต้องออกแบบให้รองรับ:

* หลาย รพ.สต.
* หลายผู้ใช้
* หลาย Agent
* ข้อมูลจากหลาย JHCISDB
* data isolation ตาม facility
* audit log
* synchronization history
* reporting

## Hosting

Central Web:

Vercel

Database:

TiDB Cloud

Source control:

GitHub

---

# 2. Core Architecture

ห้ามให้ Browser เชื่อมต่อ JHCISDB โดยตรง

ห้ามเปิด port JHCISDB ออก Internet

ห้ามทำ database connection จาก Central Server กลับเข้า LAN ของ รพ.สต.

ให้ใช้ Agent เป็นตัวกลาง

ตัวอย่าง:

R.P.S.T. A

JHCISDB
→ Local Agent
→ HTTPS
→ Central API
→ TiDB

R.P.S.T. B

JHCISDB
→ Local Agent
→ HTTPS
→ Central API
→ TiDB

R.P.S.T. C

JHCISDB
→ Local Agent
→ HTTPS
→ Central API
→ TiDB

แต่ละ รพ.สต. ต้องสามารถทำงานได้โดยไม่ต้องเปิด inbound port จาก Internet

Agent เป็น outbound-only connection

---

# 3. Agent

สร้าง Agent สำหรับติดตั้งในเครื่องที่สามารถเข้าถึง JHCISDB ของแต่ละ รพ.สต.

Agent ต้อง:

* connect JHCISDB
* อ่านข้อมูลตาม query ที่กำหนด
* ตรวจสอบข้อมูล
* แปลงข้อมูลเป็น canonical format
* ส่งข้อมูล HTTPS ไป Central API
* retry เมื่อ Internet หลุด
* queue ข้อมูลที่ยังส่งไม่สำเร็จ
* resume ได้
* log การทำงาน
* report error
* heartbeat ไป Central Server
* รับ configuration ที่ได้รับอนุญาตจาก Central
* ไม่เก็บ credential ของ Central แบบ plaintext

Agent ต้องทำงานแบบ Windows Service หรือ background service ที่เหมาะสมกับ Windows

ต้องมี:

Agent ID
Facility ID
Installation ID
Version
Status
Last heartbeat
Last successful sync
Last error

---

# 4. Agent Security

ห้ามใช้ API key เดียวกันทุก รพ.สต.

แต่ละ Agent ต้องมี credential เฉพาะตัว

ออกแบบระบบ authentication เช่น:

Agent ID
+
Secret / token
+
request signature

ใช้ HTTPS เท่านั้น

พิจารณาใช้ HMAC signing สำหรับ request สำคัญ

อย่างน้อย request ที่ส่งข้อมูลต้องสามารถตรวจสอบ:

* Agent identity
* Facility identity
* timestamp
* nonce/request ID
* signature

ป้องกัน:

* replay attack
* token reuse
* การปลอม Agent
* การส่งข้อมูลข้าม facility

Server ต้องไม่เชื่อ `facility_id` ที่ client ส่งมาอย่างเดียว

Facility ต้องถูก derive/validate จาก authenticated Agent

---

# 5. Facility Isolation

นี่เป็น requirement สำคัญที่สุด

แต่ละ รพ.สต. ต้องเห็นเฉพาะข้อมูลของตัวเอง

ตัวอย่าง:

Facility A

สามารถเห็น:

* ข้อมูลยา Facility A
* การใช้ยา Facility A
* รายงาน Facility A
* sync history Facility A

ห้ามเห็น Facility B

ผู้ใช้ทั่วไปของ Facility A ไม่สามารถแก้ URL เช่น:

/facility/A

เป็น

/facility/B

เพื่อดูข้อมูล B ได้

Authorization ต้องตรวจสอบจาก server-side session / role / facility scope

ห้ามพึ่งเฉพาะ UI hide/show

---

# 6. User Roles

สร้างระบบ Role-Based Access Control

อย่างน้อย:

## SUPER_ADMIN

เห็นทุก facility

สามารถ:

* เพิ่ม รพ.สต.
* แก้ข้อมูล facility
* สร้าง/ถอน Agent
* ดู Agent status
* ดู sync history
* ดูข้อมูลทุก facility
* ดูรายงานรวม
* จัดการผู้ใช้
* จัดการ permissions
* audit log

## FACILITY_ADMIN

เห็นเฉพาะ รพ.สต. ของตัวเอง

สามารถ:

* ดู dashboard
* ดูข้อมูลการใช้ยา
* ดูรายงาน
* ดู sync status
* จัดการผู้ใช้ภายใน facility ตามสิทธิ์
* ดู Agent ของตัวเอง

แต่ห้าม:

* ดู facility อื่น
* เปลี่ยน facility ตัวเอง
* สร้าง super admin

## USER

เห็นข้อมูล facility ของตัวเองตามสิทธิ์ที่กำหนด

เช่น:

* Dashboard
* Drug usage
* Reports

ไม่มีสิทธิ์จัดการระบบ

---

# 7. Facility Management

สร้างหน้าสำหรับ Super Admin:

/admin/facilities

แสดง:

* Facility code
* Facility name
* จังหวัด
* อำเภอ
* ตำบล
* Agent status
* Last heartbeat
* Last sync
* Data status
* Active users

สามารถ:

* เพิ่ม facility
* แก้ facility
* disable facility
* regenerate agent credential
* revoke agent
* ดู sync history

---

# 8. Agent Management

สร้าง:

/admin/agents

แสดง:

* Agent name
* Facility
* Version
* Online/Offline
* Last heartbeat
* Last sync
* Last error
* Installed date

Status:

ONLINE
OFFLINE
SYNCING
ERROR
DISABLED

เพิ่มรายละเอียด Agent:

* sync count
* failed count
* last successful sync
* last error
* error history

---

# 9. JHCIS Data

อย่าดึงทุก table จาก JHCISDB แบบไม่มีแผน

สร้าง data extraction layer

กำหนด query/schema ที่ชัดเจน

ระบบเป้าหมายหลักคือ:

"รายงานปริมาณการใช้ยา"

ต้องรองรับข้อมูลอย่างน้อย:

* Drug code
* Drug name
* Date
* Quantity
* Unit
* Patient/service reference ตามข้อมูลที่จำเป็น
* Facility
* Source
* Sync batch

ต้องออกแบบให้รองรับการเพิ่ม query ในอนาคต

เช่น:

* stock
* dispensing
* receiving
* adjustment
* drug master
* patient service
* diagnosis
* prescription

แต่รอบแรกเน้น Drug Usage

---

# 10. Data Pipeline

ใช้แนวคิด:

Extract
→ Validate
→ Normalize
→ Batch
→ Upload
→ Verify
→ Commit

Agent ต้องสร้าง Sync Batch ID ทุกครั้ง

ตัวอย่าง:

SYNC-20260904-000001

แต่ละ batch ต้องมี:

* batch_id
* agent_id
* facility_id
* started_at
* completed_at
* records_read
* records_sent
* records_accepted
* records_rejected
* status
* error_message

---

# 11. Idempotency

สำคัญมาก

ถ้า Agent ส่งข้อมูลเดิมซ้ำเนื่องจาก:

* network timeout
* retry
* application restart

Central Server ต้องไม่สร้างข้อมูลซ้ำ

ออกแบบ:

sync_batch_id
+
record unique key
+
idempotency key

ให้สามารถ retry ได้อย่างปลอดภัย

---

# 12. Incremental Sync

ไม่ควรส่งข้อมูล JHCIS ทั้งฐานทุกครั้ง

ใช้ incremental sync

Agent ต้องจำ:

last_sync_position

เช่น:

last service date
last updated timestamp
หรือ sequence/reference ที่เหมาะสมกับ JHCISDB

ครั้งต่อไปดึงเฉพาะข้อมูลใหม่

ต้องรองรับ:

Initial Sync
Incremental Sync
Manual Full Sync
Retry Failed Sync

---

# 13. Sync Schedule

ค่าเริ่มต้น:

Automatic sync

สามารถกำหนด:

* ทุก 15 นาที
* ทุก 30 นาที
* ทุก 1 ชั่วโมง
* วันละครั้ง

แต่ต้องออกแบบ scheduler ให้ configurable

ผู้ใช้สามารถกด:

"Sync Now"

ได้

แต่ต้องมี permission

---

# 14. Offline Queue

ถ้า Internet ของ รพ.สต. หลุด:

Agent ต้องไม่เสียข้อมูล

ข้อมูลที่อ่านมาแล้วต้องถูกเก็บใน local queue/database

สถานะ:

PENDING
UPLOADING
SUCCESS
FAILED

เมื่อ Internet กลับมา:

Agent ส่งต่ออัตโนมัติ

---

# 15. Central API

ออกแบบ API แยกชัดเจน

ตัวอย่าง:

POST /api/agent/heartbeat

POST /api/agent/sync/start

POST /api/agent/sync/upload

POST /api/agent/sync/complete

GET /api/agent/config

POST /api/agent/sync/retry

แต่ให้ปรับตาม architecture ของ project

ทุก endpoint ต้อง:

* authentication
* authorization
* validation
* rate limiting ตามความเหมาะสม
* logging
* error handling

---

# 16. Database Design

ออกแบบ schema อย่างน้อย:

users

roles

facilities

facility_users

agents

agent_credentials

sync_batches

sync_records

drug_master

drug_usage

audit_logs

system_settings

ต้องมี:

created_at
updated_at

และ foreign key / indexes ที่เหมาะสม

ทุก table ที่เกี่ยวข้องกับ facility ต้องสามารถ filter ด้วย facility_id ได้อย่างมีประสิทธิภาพ

---

# 17. Reporting

สร้างระบบรายงานปริมาณการใช้ยา

ผู้ใช้เลือก:

* ช่วงวันที่
* ยา
* กลุ่มยา
* facility
* หน่วยบริการ

สำหรับ User:

แสดงเฉพาะ facility ตัวเอง

สำหรับ Super Admin:

สามารถเลือก:

* facility เดียว
* หลาย facility
* ทุก facility

รายงานอย่างน้อย:

## รายงานปริมาณการใช้ยา

Drug
Quantity
Unit
Period
Facility

## Top Used Drugs

เรียงยาที่มีปริมาณใช้สูงสุด

## Usage Trend

กราฟการใช้ยารายวัน/รายเดือน

## Facility Comparison

เฉพาะ Super Admin

เปรียบเทียบปริมาณการใช้ระหว่าง facility

---

# 18. Dashboard

สร้าง Dashboard แยกตาม Role

## Facility Dashboard

แสดง:

* จำนวนรายการยา
* ปริมาณการใช้ช่วงเวลาปัจจุบัน
* Top used drugs
* Usage trend
* Last sync
* Agent status
* Pending sync
* Sync errors

## Super Admin Dashboard

แสดง:

* จำนวน รพ.สต.
* Online agents
* Offline agents
* Last sync
* Sync failures
* Total drug usage
* Top used drugs
* Usage by facility
* Usage trend

---

# 19. UI/UX

ใช้ Design System แบบ:

Modern Healthcare Enterprise SaaS

ต้องดู professional

ไม่เอา generic CRUD dashboard

เน้น:

* clean
* readable
* information hierarchy
* consistent spacing
* professional table
* professional charts
* clear status
* responsive
* accessible

สร้าง reusable components:

PageHeader
StatCard
DataTable
SearchBar
FilterBar
StatusBadge
EmptyState
LoadingState
ErrorState
ConfirmDialog
DateRangePicker
ChartCard

---

# 20. Data Privacy

ออกแบบให้เก็บเฉพาะข้อมูลที่จำเป็นต่อรายงาน

หลีกเลี่ยงการส่งข้อมูลผู้ป่วยที่ไม่จำเป็นไป Central Server

ถ้ารายงานปริมาณยาไม่จำเป็นต้องใช้:

ชื่อ
ที่อยู่
เลขบัตรประชาชน
เบอร์โทรศัพท์

ห้ามส่งขึ้น Central

ใช้ aggregate หรือ pseudonymous/reference data เท่าที่จำเป็น

---

# 21. Audit Log

บันทึกเหตุการณ์สำคัญ:

* login
* logout
* create user
* disable user
* create facility
* modify facility
* create agent
* revoke agent
* sync
* failed sync
* export
* permission change

เก็บ:

user
action
resource
resource_id
facility_id
timestamp
IP ถ้าจำเป็น
metadata

---

# 22. Error Handling

ต้องออกแบบ error ที่เหมาะกับผู้ใช้

ไม่แสดง stack trace ให้ผู้ใช้ทั่วไป

ตัวอย่าง:

"ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์กลางได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต"

แต่ใน Admin ต้องสามารถดู technical error ที่จำเป็นสำหรับ troubleshooting ได้

---

# 23. Agent Installation

สร้างแนวทางติดตั้ง Agent สำหรับแต่ละ รพ.สต.

Workflow:

1. Super Admin สร้าง Facility
2. Super Admin สร้าง Agent
3. ระบบสร้าง one-time enrollment token
4. Download Agent
5. ติดตั้ง Agent
6. กรอก enrollment token
7. Agent register
8. Server ผูก Agent กับ Facility
9. Agent ได้ credential เฉพาะตัว
10. Agent เริ่ม heartbeat
11. Agent ทดสอบ JHCIS connection
12. Agent เริ่ม sync

One-time enrollment token ต้องหมดอายุ

ไม่ควรใช้ permanent token ในขั้นตอนติดตั้ง

---

# 24. Agent Configuration

Agent config ต้องสามารถกำหนด:

Central API URL
Agent ID
Facility ID
Sync interval
JHCIS connection
Local queue location
Log level

JHCIS credential:

ห้าม commit เข้า Git

ห้าม hardcode

ห้ามแสดงใน UI โดยไม่ mask

---

# 25. Environment Variables

ใช้ `.env`

เช่น:

DATABASE_URL
NEXTAUTH_SECRET / AUTH_SECRET
AGENT_ENROLLMENT_SECRET
AGENT_SIGNING_SECRET
API_BASE_URL

ห้าม commit secret

สร้าง:

.env.example

แทน

---

# 26. Git Workflow

ต้องทำงานใน Git repository

ก่อนแก้:

ตรวจ git status

หลังแก้:

git diff

ตรวจว่าไม่มี:

* secret
* password
* API key
* JHCIS credential
* local database dump
* sensitive data

จากนั้น:

lint
typecheck
test
build

และ commit เป็น logical commits

ตัวอย่าง:

feat: add facility management
feat: add agent authentication
feat: add sync pipeline
feat: add drug usage reports
feat: add RBAC
feat: improve dashboard UI

---

# 27. Vercel

ระบบต้อง deploy บน Vercel ได้

ตรวจสอบ:

* build
* environment variables
* server-side database connection
* API routes
* authentication
* production error handling

ห้ามพึ่ง local filesystem บน Vercel สำหรับข้อมูลถาวร

---

# 28. TiDB Cloud

ออกแบบ query ให้เหมาะกับ production

สร้าง indexes สำหรับ:

facility_id
drug_code
usage_date
sync_batch_id
agent_id

ระวัง query รายงานขนาดใหญ่

ใช้ pagination

ใช้ aggregation ใน database เมื่อเหมาะสม

หลีกเลี่ยงการดึงข้อมูลทั้งหมดมา memory แล้วค่อย aggregate ใน Node.js

---

# 29. Scalability

เริ่มต้นอาจมี 5–20 รพ.สต.

แต่ architecture ต้องรองรับอย่างน้อย:

100 facilities
500 agents
หลายล้าน drug usage records

โดยไม่ต้อง rewrite architecture ใหม่

---

# 30. Monitoring

Admin ต้องเห็น:

Agent online/offline
Last heartbeat
Last sync
Sync failure
Pending batches
API errors

ทำหน้า:

/admin/monitoring

---

# 31. Security Checklist

ตรวจ:

[ ] HTTPS
[ ] RBAC
[ ] Facility isolation
[ ] Server-side authorization
[ ] Agent authentication
[ ] HMAC/request signing
[ ] Replay protection
[ ] Rate limiting
[ ] Input validation
[ ] SQL injection protection
[ ] XSS protection
[ ] CSRF protection ตาม architecture
[ ] Secure cookies
[ ] Secret management
[ ] Audit logs
[ ] No secrets in Git
[ ] No patient-sensitive data unnecessarily uploaded

---

# 32. Important Architecture Rule

ห้ามออกแบบระบบแบบ:

Browser → JHCISDB

หรือ:

Central Server → JHCISDB ผ่าน Internet

ให้เป็น:

JHCISDB
↓
Local Agent
↓
HTTPS outbound
↓
Central API
↓
TiDB Cloud
↓
Next.js / Vercel

นี่เป็น architecture หลักของระบบ

---

# 33. Development Strategy

อย่าพยายามเขียนทุกอย่างในครั้งเดียวแบบไม่มี checkpoint

แบ่งเป็น Phase:

PHASE 1
Architecture + database schema

PHASE 2
Authentication + RBAC + Facility isolation

PHASE 3
Agent registration + authentication

PHASE 4
Agent heartbeat

PHASE 5
JHCIS extraction layer

PHASE 6
Sync pipeline + queue + retry + idempotency

PHASE 7
Drug usage database

PHASE 8
Reports

PHASE 9
Admin monitoring

PHASE 10
UI/UX polish

PHASE 11
Security audit

PHASE 12
Production deployment

แต่ละ phase ต้องสามารถตรวจสอบและทดสอบได้

---

# 34. Testing

สร้าง tests สำหรับ:

* authentication
* authorization
* facility isolation
* agent authentication
* duplicate sync
* retry
* failed upload
* partial upload
* offline queue
* incremental sync
* report aggregation
* permission escalation

โดยเฉพาะ test:

User Facility A
ต้องไม่สามารถอ่านข้อมูล Facility B

และ:

Agent A
ต้องไม่สามารถ upload ข้อมูลในชื่อ Facility B

---

# 35. Deliverables

เมื่อทำเสร็จต้องมี:

Central Web
Agent
Database schema
Migrations
API
Authentication
RBAC
Facility management
Agent management
Sync system
Drug usage
Reports
Dashboard
Audit logs
Monitoring
Documentation

สร้างเอกสาร:

ARCHITECTURE.md
AGENT.md
API.md
DATABASE.md
DEPLOYMENT.md
SECURITY.md
SYNC.md

อธิบาย architecture และวิธีติดตั้งจริง

---

# FINAL REQUIREMENT

อย่าเพียงสร้าง UI mockup

ต้องสร้างระบบที่สามารถนำไปพัฒนาต่อเป็น production system ได้จริง

ถ้ามีสิ่งใดใน requirement นี้ที่ขัดกับ architecture หรือข้อจำกัดของ framework ปัจจุบัน:

1. ตรวจสอบ code จริงก่อน
2. เลือกวิธีที่ปลอดภัยและ maintainable
3. อธิบายเหตุผล
4. อย่าแก้แบบ workaround ที่สร้าง technical debt

เริ่มจากตรวจสอบ repository ปัจจุบันก่อน

สรุป architecture ที่พบ

จากนั้นเริ่ม PHASE 1

อย่า rewrite project ทั้งหมดถ้าไม่จำเป็น

รักษา functionality เดิมที่มีอยู่แล้ว
และต่อยอดจาก architecture ปัจจุบัน
