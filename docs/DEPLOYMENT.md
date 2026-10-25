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

## 5. Global Sync Start Date rollout (Central deployed; policy inactive)

### Current verified production state (2026-10-25)

- Central deploy architecture Phase B–E แล้ว และ production apply additive migrations 0012 → 0013 → 0014 แล้ว
- desired policy revision มีอยู่ แต่ active revision = `0`, active date ไม่มี และ enforcement ยัง inactive
- ไม่มี historical backfill และไม่มี automatic backfill/automatic fleet resume
- `v1.1.16` เป็น published historical release, `v1.1.17` เป็น local/unpublished Dev build,
  `v1.1.18`/`v1.1.19` เผยแพร่แล้ว และ `v1.1.20` เป็น current published patch release
- rollout Phase 1–3 เสร็จแล้ว: 05957 For-dev ใช้ v1.1.20, legacy recovery batch
  `SYNC-20261021-000001` COMPLETED และ queue/failed/quarantine = 0
- Agent production ที่เหลืออาจยังเป็น v1.1.19 และ fleet ยัง centrally paused ระหว่างรอ controlled rollout Phase 4/4

Central-first schema/deployment และ v1.1.18 durable-recovery canary เป็น milestone ที่เสร็จแล้ว ไม่ใช่
ขั้นตอนที่ยังรอทำ Protocol semantics ยังเหมือนเดิม: forward rollout ไม่ต้องรอ
`idempotentUploadChunk`; historical backfill ต้องมีทั้ง `remoteSyncStartDate` และ
`idempotentUploadChunk` ผ่าน receipt/reconciliation gate และเริ่มได้เฉพาะคำขอ `SUPER_ADMIN`
ทีละ Agent ตาม [GLOBAL_SYNC_BACKFILL.md](GLOBAL_SYNC_BACKFILL.md)

Rollback ห้ามลด revision, ลบข้อมูล หรือแก้ release เดิม: pause fleet, สร้าง revision ใหม่ที่คืนวันก่อนหน้า,
รอ acknowledgement, activate แล้ว resume canary อย่างมีลำดับ Purge ไม่ใช่ขั้นตอน rollback ของ policy

### Controlled rollout Phase 4/4 gate (ยังไม่เริ่ม)

- [ ] ยืนยัน backup/schema/health ปัจจุบัน โดยไม่ apply migration ซ้ำและไม่ใช้ `db:push`
- [ ] คง fleet paused และอัปเดต Agent ทีละเครื่องด้วย exact Agent-scoped `SUPER_ADMIN` command เท่านั้น
- [ ] หลังแต่ละเครื่องตรวจ identity, credential, enrollment, facility, settings, watermark,
  queue/failed/quarantine, recovery state, updater/pause state และ installer/scheduled-task identity เดิม
- [ ] ยืนยัน heartbeat/capability/readiness ของ Agent ปัจจุบันก่อนดำเนินการกับเครื่องถัดไป
- [ ] ห้าม activate policy, resume Agent หรือสร้าง historical backfill โดยอัตโนมัติ
- [ ] การ activate policy และ controlled resume ต้องเป็น milestone แยกที่ owner อนุมัติอย่างชัดเจน

### Controlled Agent updates (v1.1.19+)

- การย้ายจาก legacy updater ของ v1.1.18 เป็น v1.1.19 เป็น historical one-time bootstrap ที่เสร็จแล้ว
- การ publish release ทำให้ scheduled task เห็นรุ่นใหม่เป็น `AVAILABLE` เท่านั้น ไม่ใช่ rollout authorization
- การติดตั้งต้องเริ่มจากคำสั่ง `SUPER_ADMIN` ที่ durable ใน `agent_update_commands` สำหรับ Agent เป้าหมาย
  และ Agent ต้องตรวจ exact Agent ID/version/asset/size/SHA-256 กับ published release ก่อน download/install
- คำสั่งเก่า, terminal, คนละ Agent หรือ metadata ไม่ตรงห้ามนำกลับมาใช้ และการ restart ห้ามขยายสิทธิ์
- paused Agent อัปเดตได้เมื่อมีคำสั่ง exact นี้ โดย pause state, identity, credential, enrollment, settings,
  watermark, recovery manifest และ queue/failed/quarantine ต้องไม่เปลี่ยน ห้ามอาศัย GitHub latest เพื่อ rollout
- ก่อน handoff ต้องผ่าน manifest trust-chain, component integrity, environment/readiness และ exclusive lock;
  v1.1.20 คงกติกานี้ทั้งหมดและแก้เฉพาะ PAUSED GUI startup/control-card crash
