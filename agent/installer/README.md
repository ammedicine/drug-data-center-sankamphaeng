# ตัวติดตั้ง Agent สำหรับ รพ.สต.

โฟลเดอร์นี้สร้าง **ตัวติดตั้ง Windows (.exe)** ที่รวมทุกอย่างไว้ให้แล้ว
เจ้าหน้าที่ รพ.สต. ดับเบิลคลิกติดตั้ง แล้วใช้งานผ่านหน้าจอได้ทันที
ไม่ต้องติดตั้ง Node.js หรือ Python ที่เครื่องปลายทาง

## สิ่งที่ตัวติดตั้งวางลงเครื่อง

```
C:\Program Files\SDC Agent\
  SDCAgent.exe        โปรแกรมหน้าจอ (CustomTkinter) + ไอคอนถาดระบบ
  app\agent.js        ตัว agent (bundle จาก TypeScript)
  runtime\node.exe    Node runtime แบบพกพา
  .env                ค่าเชื่อมต่อ JHCIS (แก้ผ่านหน้าจอได้)
%ProgramData%\SDCAgent\    ข้อมูลใช้งาน (คิว, บันทึก, สถานะ, credential)
```

## เครื่องมือที่ต้องมี "ที่เครื่องผู้พัฒนา" เท่านั้น

| เครื่องมือ | ใช้ทำอะไร | ลิงก์ |
|---|---|---|
| Node.js 18+ | bundle ตัว agent | https://nodejs.org |
| Python 3.11-3.13 | build หน้าจอเป็น .exe | https://python.org |
| Inno Setup 6 | ประกอบเป็นตัวติดตั้ง | https://jrsoftware.org/isdl.php |

> เครื่องนี้ตรวจแล้ว: มี Node.js และ Python 3.14 แต่ **ยังไม่ได้ติดตั้ง Inno Setup**
> ถ้าติดตั้งแล้ว ISCC.exe จะอยู่ที่ `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`

## ขั้นตอน build

```powershell
cd agent
.\installer\build.ps1              # ทำครบทุกขั้นตอน
.\installer\build.ps1 -SkipInstaller   # ข้ามขั้นตอน Inno Setup
```

สคริปต์จะทำตามลำดับ:

1. `npm ci` แล้ว bundle `src/cli.ts` เป็น `build/app/agent.js` ด้วย esbuild
2. ดาวน์โหลด Node runtime แบบพกพา (ถ้ายังไม่มีใน `build/runtime`)
3. PyInstaller build `gui/sdc_agent_gui.py` เป็น `SDCAgent.exe`
4. ISCC ประกอบทุกอย่างเป็น `installer/output/SDCAgent-Setup-x.y.z.exe`

## หลังติดตั้งที่ รพ.สต.

1. เปิดโปรแกรม → แท็บ **ตั้งค่า** → กรอกการเชื่อมต่อ JHCIS (ผู้ใช้ที่มีสิทธิ์ SELECT เท่านั้น)
2. กรอก **รหัสลงทะเบียน** ที่ได้จากผู้ดูแลส่วนกลาง แล้วกดลงทะเบียน
3. ตั้งตารางการซิงก์ (ทุก N นาที หรือเวลาที่กำหนด เช่น 08:00, 16:30)
4. เปิด "เปิดโปรแกรมอัตโนมัติเมื่อเริ่มเครื่อง" ไว้ โปรแกรมจะย่อลงถาดระบบและทำงานเอง
