# ศูนย์ข้อมูลการใช้ยา อำเภอสันกำแพง

ระบบรวบรวมและวิเคราะห์ปริมาณการจ่ายยาจาก JHCISDB ของ รพ.สต. หลายแห่งที่อยู่คนละวง LAN

```
JHCISDB (read-only) → Local Agent → HTTPS+HMAC → Central API (Vercel) → TiDB Cloud → Web
```

## เริ่มต้น

```bash
npm install
cp .env.example .env          # ใส่ DATABASE_URL, AUTH_SECRET, AGENT_SIGNING_SECRET
npm run db:migrate
SEED_ADMIN_EMAIL=admin@example.org SEED_ADMIN_PASSWORD='...' npm run db:seed
npm run dev
```

Agent (ที่เครื่องของ รพ.สต.):

```bash
cd agent && npm install
cp .env.example .env          # ใส่ค่า JHCIS ของแห่งนั้น
npm run doctor                # ตรวจ schema จริงก่อนเสมอ
npx tsx src/cli.ts enroll --token ENR-xxxx
npx tsx src/cli.ts sync --mode INITIAL
```

## เอกสาร

| ไฟล์ | เนื้อหา |
|---|---|
| [CLAUDE.md](CLAUDE.md) | บันทึกการทำงาน + schema JHCIS จริงที่ตรวจแล้ว + สถานะแต่ละ phase |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | ภาพรวมระบบและเหตุผลการออกแบบ |
| [docs/API.md](docs/API.md) | Central API + วิธีลงลายเซ็น HMAC |
| [docs/DATABASE.md](docs/DATABASE.md) | ตารางกลาง + index |
| [docs/SYNC.md](docs/SYNC.md) | pipeline, idempotency, offline queue |
| [docs/AGENT.md](docs/AGENT.md) | ติดตั้งและใช้งาน Agent |
| [docs/SECURITY.md](docs/SECURITY.md) | threat model + security checklist |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel + TiDB Cloud |

requirement ต้นทาง: [PROJECT_SPEC.md](PROJECT_SPEC.md), [JHCIS_INTEGRATION.md](JHCIS_INTEGRATION.md), [AGENTS.md](AGENTS.md)

## คำสั่ง

```bash
npm run dev | build | start
npm run lint | typecheck | test
npm run db:generate | db:migrate | db:seed
```
