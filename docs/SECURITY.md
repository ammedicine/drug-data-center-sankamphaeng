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
| ยกระดับสิทธิ์ตัวเอง | FACILITY_ADMIN สร้าง SUPER_ADMIN/ADMIN ไม่ได้ และสร้างผู้ใช้นอกสถานบริการตัวเองไม่ได้ |
| สมัครสมาชิกเองแล้วเห็นข้อมูลทันที | บัญชีที่สมัครเองถูกสร้างเป็น inactive ต้องรออนุมัติ (`approved_at`) |
| ADMIN แก้ข้อมูลระบบ | `canManageSystem()` เป็น SUPER_ADMIN เท่านั้น ปุ่มถูกซ่อน **และ** server action ปฏิเสธ |
| ดูข้อมูลนอกหมวดยาที่ได้รับสิทธิ์ | `resolveDrugTypeScope()` ตัดหมวดที่ไม่ได้รับอนุญาตออกเสมอ |
| ข้อมูลผู้ป่วยรั่วขึ้น cloud | ไม่ดึง/ไม่ส่ง/ไม่เก็บ ชื่อ เลขบัตร ที่อยู่ เบอร์โทร — เก็บเพียง `visit_no` เป็น reference |
| JHCIS ถูกแก้ไขโดยไม่ตั้งใจ | ชั้น connection ปฏิเสธทุก statement ที่ไม่ใช่ SELECT/SHOW/DESCRIBE/EXPLAIN |

## 1.5 มาตรการที่เพิ่มก่อนขึ้น production

| มาตรการ | รายละเอียด |
|---|---|
| Security headers | CSP (`script-src 'self'` ใน production), HSTS 2 ปี, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Robots-Tag: noindex`, COOP/CORP |
| API ไม่ถูก cache | `/api/*` ตอบ `Cache-Control: no-store` เสมอ |
| กันสุ่มรหัสผ่าน | จำกัดการเข้าสู่ระบบ 8 ครั้ง/5 นาที **แยกนับทั้งรายบัญชีและราย IP** เกินแล้วบล็อก 10 นาที และบันทึก audit ทุกครั้ง |
| กันสมัครสมาชิกถล่ม | 5 ครั้ง/ชั่วโมง ต่อ IP |
| กันดูดข้อมูล | ส่งออก CSV 30 ครั้ง/10 นาที ต่อบัญชี |
| เพิกถอน session ทันที | ทุกครั้งที่โหลดหน้า ระบบเทียบ `session_epoch` ในโทเคนกับในฐานข้อมูล — ปิดใช้งานผู้ใช้/ตั้งรหัสผ่านใหม่/เปลี่ยนบทบาท มีผลภายในไม่กี่วินาที ไม่ต้องรอโทเคนหมดอายุ |
| บทบาทมาจากฐานข้อมูล | `requireUser()` ใช้ role/facility จากฐานข้อมูล ไม่ใช่จากโทเคน — โทเคนที่ออกก่อนถูกลดสิทธิ์จึงใช้สิทธิ์เดิมไม่ได้ |
| อนุมัติสมาชิกใหม่ | เฉพาะ SUPER_ADMIN (ผู้สมัครเป็นคนกรอกรหัสสถานบริการเอง จึงต้องมีคนกลางตรวจ) |
| ลบผู้ใช้ | ต้องพิมพ์ user id ยืนยัน · ห้ามลบ SUPER_ADMIN คนสุดท้าย · ห้ามลบ/แก้บัญชีตัวเอง · บันทึก audit พร้อมข้อมูลผู้ถูกลบ |

> ข้อจำกัดที่ต้องรู้: ตัวจำกัดอัตราเก็บสถานะใน memory ของแต่ละ instance บน Vercel
> จึงกันการยิงถล่มจากที่เดียวได้ระดับหนึ่ง แต่ไม่ใช่ระดับ cluster — ถ้าเปิดสู่อินเทอร์เน็ตวงกว้าง
> ควรย้ายไปใช้ Vercel KV / Upstash ส่วน audit log เป็นหลักฐานถาวรที่เชื่อถือได้

## 2. Checklist (PROJECT_SPEC §31)

- [x] HTTPS — Vercel บังคับ, Agent เรียกผ่าน HTTPS เท่านั้น
- [x] RBAC — SUPER_ADMIN / ADMIN (อ่านอย่างเดียวทุกสถานบริการ) / FACILITY_ADMIN / USER (`src/lib/auth/rbac.ts`)
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
- Rate limit ระดับ cluster (เช่น Upstash/Vercel KV) แทน in-process
- 2FA สำหรับบัญชี SUPER_ADMIN
- Log shipping + alert เมื่อ Agent ออฟไลน์เกินเกณฑ์

## ผลตรวจรอบ 2026-09-05 (เว็บ + Agent Tray)

| # | ปัญหา | ความรุนแรง | สถานะ |
|---|---|---|---|
| 1 | CSP `script-src 'self'` ไม่มี nonce -> Next inject inline script ไม่ได้ หน้าเว็บว่างเปล่าบน production | สูง (ใช้งานไม่ได้) | แก้แล้ว - ย้าย CSP ไป middleware ใช้ nonce ต่อ request + `strict-dynamic` |
| 2 | `agent.config.json` (secret HMAC ของสถานบริการ) ถูกเขียนที่ `C:\ProgramData\` ซึ่ง `Users` อ่านได้ | **วิกฤต** | แก้แล้ว - ย้ายเข้า `%AGENT_DATA_DIR%` + `icacls` ตัดสิทธิ์เหลือ SYSTEM/Administrators/เจ้าของ (ของเดิมย้ายอัตโนมัติตอนเปิดครั้งแรก) |
| 3 | `mode: 0o600` ไม่มีผลบน Windows แต่โค้ดเขียนคอมเมนต์ว่า installer จัดการ ACL ให้ (ซึ่งไม่ได้ทำ) | สูง | แก้แล้ว - เรียก `icacls` จริงใน `restrictToOwner()` |
| 4 | `DATABASE_URL` ที่มี `?ssl=` สามารถ override TLS ของโค้ดได้ | กลาง | แก้แล้ว - บังคับ `minVersion TLSv1.2` + `rejectUnauthorized: true` เสมอ และปฏิเสธ URL ที่สั่งปิด verification (ยืนยัน TiDB ต่อจริงด้วย TLSv1.3) |

### ความเสี่ยงที่เหลืออยู่ (ยอมรับไว้ พร้อมเหตุผล)

- **ตัวติดตั้งยังไม่ได้เซ็น Authenticode** -> ปลอม `SDCAgent.exe` แล้วหลอกให้ติดตั้งได้
  ป้องกันได้ทางเดียวคือซื้อ code-signing certificate มาเซ็น (ยังไม่มี) ระหว่างนี้ให้แจกตัวติดตั้ง
  ผ่านช่องทางเดียวที่ควบคุมได้ และเทียบ SHA-256 ก่อนติดตั้ง
- **`.env` ที่มีรหัสผ่าน JHCIS อ่านได้โดยผู้ใช้ที่ล็อกอินเครื่องนั้น** - เลี่ยงไม่ได้ เพราะ agent
  รันด้วยสิทธิ์ผู้ใช้คนนั้น จึงต้องอ่านไฟล์ได้ **ตัวลดความเสี่ยงคือใช้ MySQL account ที่เป็น
  read-only เท่านั้น** (เป็นกฎอยู่แล้วใน §4 ของ CLAUDE.md)
- **โฟลเดอร์คิว (`queue/`) เขียนได้โดยผู้ใช้ทั่วไป** -> ผู้ที่เข้าถึงเครื่องได้อาจใส่แถวปลอมให้ agent
  เซ็นส่งขึ้นศูนย์กลาง ขอบเขตความเสียหายจำกัดอยู่แค่สถานบริการตัวเอง เพราะ Central ตรวจ
  `pcucode` ของทุก batch เทียบกับ facility ที่ผูกกับ agent และคนที่เข้าถึงเครื่องนั้นก็คีย์ข้อมูล
  ปลอมใน JHCIS ได้อยู่แล้ว การปิดสิทธิ์เขียนจะทำให้เจ้าหน้าที่ทั่วไปรัน agent ไม่ได้
- **rate limit เก็บใน memory** ของแต่ละ instance ไม่ใช่ทั้งคลัสเตอร์ (ระบุไว้แล้วใน
  `rate-limit.ts`) ถ้าเปิดสู่อินเทอร์เน็ตจริงจังควรย้ายไป Vercel KV / Upstash
