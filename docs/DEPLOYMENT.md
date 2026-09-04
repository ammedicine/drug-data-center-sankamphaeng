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

สร้างค่าสุ่ม: `openssl rand -base64 48`

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
