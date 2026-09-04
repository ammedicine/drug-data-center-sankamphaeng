# SECURITY

## 1. Threat model ที่ระบบนี้ป้องกัน

| ภัยคุกคาม | มาตรการ |
|---|---|
| ผู้ใช้ รพ.สต. A อ่านข้อมูล รพ.สต. B | `resolveFacilityScope()` ตัดสินทุก query ฝั่ง server, ไม่พึ่ง UI (มี unit test) |
| Agent ปลอม | credential เฉพาะตัว + HMAC ต่อ request |
| Agent A ส่งข้อมูลในนาม B | facility มาจาก credential เท่านั้น + ตรวจ `pcucode` ซ้ำอีกชั้น |
| Replay request เดิม | timestamp window 5 นาที + nonce ใช้ครั้งเดียว (`agent_request_nonces`) |
| แก้ payload ระหว่างทาง | ลายเซ็นครอบ `sha256(body)` |
| Token ติดตั้งรั่ว | token ใช้ครั้งเดียว หมดอายุ 60 นาที เก็บเป็น hash และถูกเผาก่อนออก credential |
| DB dump รั่ว → ปลอม Agent | secret เก็บแบบเข้ารหัส AES-256-GCM ด้วย `AGENT_SIGNING_SECRET` ที่อยู่นอก DB |
| ยกระดับสิทธิ์ตัวเอง | FACILITY_ADMIN สร้าง SUPER_ADMIN ไม่ได้ และสร้างผู้ใช้นอกสถานบริการตัวเองไม่ได้ |
| ข้อมูลผู้ป่วยรั่วขึ้น cloud | ไม่ดึง/ไม่ส่ง/ไม่เก็บ ชื่อ เลขบัตร ที่อยู่ เบอร์โทร — เก็บเพียง `visit_no` เป็น reference |
| JHCIS ถูกแก้ไขโดยไม่ตั้งใจ | ชั้น connection ปฏิเสธทุก statement ที่ไม่ใช่ SELECT/SHOW/DESCRIBE/EXPLAIN |

## 2. Checklist (PROJECT_SPEC §31)

- [x] HTTPS — Vercel บังคับ, Agent เรียกผ่าน HTTPS เท่านั้น
- [x] RBAC — SUPER_ADMIN / FACILITY_ADMIN / USER (`src/lib/auth/rbac.ts`)
- [x] Facility isolation — server-side ทุกเส้นทาง + มี test
- [x] Server-side authorization — ทุกหน้าเรียก `requireUser()/requireSuperAdmin()`; middleware เป็นแค่ชั้นเสริม
- [x] Agent authentication — keyId + secret เฉพาะตัว
- [x] HMAC request signing — method+path+ts+nonce+body hash
- [x] Replay protection — nonce table + timestamp skew
- [x] Rate limiting — token bucket ต่อ credential/IP ที่ชั้น API
- [x] Input validation — zod ทุก endpoint + validate รายแถวก่อนเขียน
- [x] SQL injection — Drizzle parameterized ทั้งหมด; ฝั่ง Agent ใช้ placeholder
      (ชื่อคอลัมน์ที่ประกอบเป็น SQL มาจาก allow-list ของ SchemaInspector ไม่ใช่ input ผู้ใช้)
- [x] XSS — React escape โดยปริยาย ไม่มี `dangerouslySetInnerHTML`
- [x] CSRF — session cookie เป็น `SameSite=Lax` + ใช้ Server Actions ที่ผูก origin
- [x] Secure cookies — httpOnly, secure ใน production, `SameSite=Lax`, อายุ 8 ชั่วโมง
- [x] Secret management — ทุก secret มาจาก env; `.env` อยู่ใน `.gitignore`
- [x] Audit logs — login/logout/สร้าง-ปิดผู้ใช้/facility/agent/sync/export
- [x] No secrets in Git — `.env`, `agent.config.json`, `agent/data/` ถูก ignore
- [x] ไม่อัปโหลดข้อมูลผู้ป่วยเกินจำเป็น

## 3. ข้อมูลที่ **ไม่** ถูกส่งขึ้น Central

จาก `visit` ใช้เพียง `pcucode, visitno, visitdate`
ไม่ดึง `pid`, `symptoms`, `weight/height/pressure`, `rightno`, `doctor*`, ที่อยู่, เบอร์โทร
JHCIS password ไม่เคยออกจากเครื่อง Agent — Central รู้เพียง version, สถานะการเชื่อมต่อ และ schema report

## 4. การจัดการ credential

| ของ | เก็บที่ไหน | รูปแบบ |
|---|---|---|
| รหัสผ่านผู้ใช้ | `users.password_hash` | bcrypt cost 12 |
| secret ของ Agent | `agent_credentials.secret_enc` | AES-256-GCM (กุญแจจาก env) |
| enrollment token | `agent_enrollment_tokens.token_hash` | sha256, ใช้ครั้งเดียว |
| secret ฝั่ง Agent | `agent.config.json` | ไฟล์สิทธิ์ 0600 บนเครื่อง รพ.สต. |
| JHCIS password | `agent/.env` | ไม่ออกจากเครื่อง ไม่ log ไม่ส่ง API |

การถอนสิทธิ์: `/admin/agents` → "ถอนสิทธิ์" ปิด credential ทุกใบและตั้ง agent เป็น DISABLED ทันที
การออก token ใหม่จะยกเลิก token เดิมที่ยังไม่ถูกใช้ และเมื่อ enroll สำเร็จ credential เดิมถูกปิดทั้งหมด

## 5. สิ่งที่ยังควรทำเพิ่มก่อนขึ้น production เต็มรูปแบบ

- บังคับเปลี่ยนรหัสผ่านครั้งแรก + นโยบายหมดอายุรหัสผ่าน
- ตรวจ `sessionEpoch` กับฐานข้อมูลทุก request (ตอนนี้ตรวจตอน login และตอนปิดผู้ใช้)
- Rate limit ระดับ cluster (เช่น Upstash/Vercel KV) แทน in-process
- Log shipping + alert เมื่อ Agent ออฟไลน์เกินเกณฑ์
