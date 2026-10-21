# DEPLOYMENT — Vercel + TiDB Cloud

## 1. TiDB Cloud

1. สร้าง cluster แล้วสร้าง database เช่น `sankamphaeng_drug`
2. สร้าง user เฉพาะแอป (สิทธิ์ SELECT/INSERT/UPDATE/DELETE บน database นั้น)
3. คัดลอก connection string (ต้องเป็น TLS)

```
DATABASE_URL=mysql://user:pass@gateway01.<region>.prod.aws.tidbcloud.com:4000/sankamphaeng_drug?ssl={"minVersion":"TLSv1.2"}
```

4. รัน migration จากเครื่อง dev:

```bash
npm run db:generate     # เมื่อแก้ schema
npm run db:migrate
```

5. สร้างผู้ดูแลคนแรก:

```bash
SEED_ADMIN_EMAIL=admin@example.org SEED_ADMIN_PASSWORD='<strong-password>' npm run db:seed
```

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| ตัวแปร | ใช้ทำอะไร |
|---|---|
| `DATABASE_URL` | TiDB Cloud |
| `AUTH_SECRET` | เซ็น session JWT (>= 32 ตัวอักษร) |
| `AGENT_SIGNING_SECRET` | เข้ารหัส secret ของ Agent ที่เก็บใน DB |
| `AGENT_ENROLLMENT_SECRET` | สำรองไว้สำหรับ token รูปแบบอื่นในอนาคต |
| `API_BASE_URL` | ใช้ในเอกสาร/ตัวติดตั้ง Agent |
| `AGENT_SIGNATURE_MAX_SKEW_SECONDS` | ค่าเริ่มต้น 300 |
| `DATABASE_POOL_SIZE` | ค่าเริ่มต้น 5 (serverless ควรน้อย) |

สร้างไฟล์ค่าพร้อมวางลง Vercel ได้ด้วย:

```bash
npm run env:vercel     # เขียน .env.vercel (gitignored) จากค่าที่ใช้งานอยู่จริง
```

แล้วนำเนื้อหาไปวางที่ Vercel → Settings → Environment Variables (เลือกทั้ง Production และ Preview)
แม่แบบที่ commit ไว้คือ `.env.vercel.example`

**ข้อควรระวัง:** `AGENT_SIGNING_SECRET` ต้องเป็นค่าเดียวกับที่ใช้ตอน Agent ลงทะเบียน
ถ้าเปลี่ยน Agent ทุกเครื่องจะส่งข้อมูลไม่ได้และต้อง enroll ใหม่ ส่วน `AUTH_SECRET` เปลี่ยนได้
(ผลคือทุกคนต้องเข้าสู่ระบบใหม่)

สร้างค่าสุ่มเอง: `openssl rand -base64 48`

**ห้าม** ใส่ค่าจริงลง `.env.example` หรือ commit `.env`

## 3. Deploy

```bash
npm run lint && npm run typecheck && npm test && npm run build
git push        # Vercel build อัตโนมัติ
```

หมายเหตุสำหรับ Vercel:

- ทุกหน้าและทุก API เป็น `dynamic = "force-dynamic"` (ข้อมูลขึ้นกับ session)
- API ของ Agent ใช้ `runtime = "nodejs"` เพราะต้องใช้ `node:crypto` และ mysql2
- `/api/agent/sync/upload` ตั้ง `maxDuration = 60`
- **ห้ามใช้ filesystem ของ Vercel เก็บข้อมูลถาวร** — คิวอยู่ที่ Agent เท่านั้น

## 4. หลัง deploy — checklist

- [ ] เข้า `/login` ด้วยบัญชี seed ได้
- [ ] สร้าง Facility ที่ `/admin/facilities` (pcucode ต้องตรงกับ JHCIS ของแห่งนั้น)
- [ ] สร้าง Agent ที่ `/admin/agents` แล้วคัดลอก enrollment token
- [ ] ที่เครื่อง รพ.สต.: `doctor` → `enroll` → `sync --mode INITIAL`
- [ ] ตรวจ `/admin/monitoring` ว่า Agent ขึ้น ONLINE และ batch เป็น COMPLETED
- [ ] ตรวจ `/reports/drug-usage` ว่ามีข้อมูล
- [ ] ทดสอบ facility isolation: ผู้ใช้ รพ.สต. A ใส่ `?facility=<B>` ต้องได้ 403

## 5. Global Sync Start Date rollout (code implemented; rollout not performed)

โค้ด Phase B–E พร้อมสำหรับลำดับ deploy แบบ Central-first ด้านล่าง แต่ยังไม่ได้ apply migration
0012–0014 ใน production, publish Agent รุ่นใหม่, activate policy หรือเริ่ม rollout:

1. backup Central DB แล้ว apply เฉพาะ additive migration ที่ตรวจแล้ว
2. deploy Central ที่เข้าใจ policy/heartbeat ใหม่ แต่ยังไม่มี policy row และยังไม่ enforce
3. ยืนยันว่า Agent `v1.1.16` ยัง sync แบบ legacy โดยไม่ต้อง remote acknowledgement
4. build รุ่นใหม่เป็น `v1.1.18` โดยไม่แก้ tag/release `v1.1.16` ที่เผยแพร่แล้ว (`v1.1.17`
   เป็น local/unpublished Dev build และไม่มี tag/release จึงห้ามนำเลขเดิมกลับมาใช้กับ recovery build)
5. pause และอัปเกรด canary หนึ่งเครื่อง ตรวจว่า identity, credential, enrollment, settings,
   queue/quarantine และ updater state ไม่เปลี่ยน
6. สร้าง desired policy รอ canary persist/apply และรายงาน revision ตรงกัน
7. ก่อน activate ต้อง desired-paused, ไม่มี active Central batch และผ่าน owner review
8. resume canary หนึ่งเครื่อง ตรวจ scheduled sync + reconciliation ก่อนขยาย rollout

ไม่จำเป็นต้องรอ Agent ออฟไลน์ทุกเครื่อง แต่ override ต้องเป็นคำสั่ง explicit ของ `SUPER_ADMIN`
พร้อมเหตุผลและ audit เครื่องนั้นต้องคง centrally paused จนกว่าอัปเกรด รับ policy และ applied แล้ว

forward rollout ไม่ต้องรอ `idempotentUploadChunk` ส่วน historical backfill ต้องปิด UI ไว้จน Agent
มีทั้ง `remoteSyncStartDate` และ `idempotentUploadChunk` และผ่าน receipt/reconciliation gate

ก่อนเปิดใช้ Phase E ให้ apply additive migration `0014_global_sync_backfill`, deploy Central ก่อน,
จากนั้นอัปเกรด canary Agent และยืนยันว่า nullable telemetry รายงานจริง (`NULL` ไม่ใช่ healthy zero)
การ backfill ต้องเริ่มจากคำขอ `SUPER_ADMIN` ทีละ Agent เท่านั้น ไม่มี auto backfill/auto resume;
runbook contract อยู่ใน [GLOBAL_SYNC_BACKFILL.md](GLOBAL_SYNC_BACKFILL.md)

Rollback ห้ามลด revision, ลบข้อมูล หรือแก้ release เดิม: pause fleet, สร้าง revision ใหม่ที่คืนวันก่อนหน้า,
รอ acknowledgement, activate แล้ว resume canary อย่างมีลำดับ Purge ไม่ใช่ขั้นตอน rollback ของ policy

### Production canary checklist (ยังไม่ execute)

- [ ] apply Central migrations 0012–0014 ก่อน และ deploy Central ก่อน Agent
- [ ] pause Agent เป้าหมายทั้งหมด แล้วเลือก canary เพียงหนึ่ง Agent
- [ ] upgrade canary เป็น v1.1.18 โดยยืนยัน Agent identity, credential, enrollment, facility,
  settings, watermark, queue/quarantine, updater/pause state และ installer/scheduled-task identity เดิม
- [ ] จำลอง response loss/restart บน canary แล้วตรวจว่า normal recovery ใช้ batchRef เดิม, ส่ง pending
  queue ต่อ, complete/reconcile สำเร็จ และเลื่อน watermark เพียงครั้งเดียว
- [ ] ยืนยัน heartbeat, capability `remoteSyncStartDate` และ `idempotentUploadChunk`
- [ ] ยืนยัน `remoteSyncStartDate` เป็น `APPLIED` ตรง revision และ queue/quarantine telemetry ไม่ใช่
  healthy zero เมื่อไม่มีข้อมูล
- [ ] ทดสอบ forward policy ก่อน; historical backfill ทำหลัง explicit owner/SUPER_ADMIN approval เท่านั้น
- [ ] monitor reconciliation, errors และ TiDB RU จากระบบภายนอก
- [ ] ผ่าน readiness gate ก่อนดำเนินการกับ Agent ถัดไป; ห้าม auto-resume หรือ fleet-wide backfill
