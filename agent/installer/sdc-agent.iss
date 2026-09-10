; ตัวติดตั้ง Drug data center อำเภอสันกำแพง (โปรแกรมเชื่อมข้อมูล JHCIS)
; ประกอบไฟล์ที่ build.ps1 เตรียมไว้ใน ..\build

; ชื่อที่ผู้ใช้เห็น (รายการโปรแกรม, Start menu, ทางลัด Startup, หน้าจอ)
; เปลี่ยนได้โดยไม่กระทบการอัปเกรด เพราะ Windows รู้จักโปรแกรมนี้จาก AppId
; ไม่ใช่จากชื่อ ส่วน AppNameEn ยังเป็นชื่อโฟลเดอร์ติดตั้งเดิม ห้ามเปลี่ยน
#define AppName "Drug data center อำเภอสันกำแพง"
#define AppNameEn "SDC Agent"
; build.ps1 ส่งเวอร์ชันจาก git tag เข้ามาด้วย /DAppVersion=... ค่าด้านล่างใช้เมื่อ build มือ
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppPublisher "สำนักงานสาธารณสุขอำเภอสันกำแพง"
#define AppExe "SDCAgent.exe"
#define BuildDir "..\build"

[Setup]
AppId={{8E2C1F4A-6D33-4B77-9E51-2C6A7B0D9A11}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppNameEn}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=SDCAgent-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; ต้องใช้สิทธิ์ผู้ดูแลเพราะติดตั้งลง Program Files และสร้างโฟลเดอร์ข้อมูลส่วนกลาง
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExe}
VersionInfoVersion={#AppVersion}
; --- การอัปเกรดทับเวอร์ชันเดิม (อ่าน [Code] ท้ายไฟล์ประกอบ) ---
; AppId เดิม -> Windows รู้ว่าเป็นโปรแกรมตัวเดียวกัน ไม่ขึ้นรายการซ้ำใน Programs and Features
; ห้ามเปลี่ยน AppId เด็ดขาด ไม่งั้นเวอร์ชันเก่าจะค้างอยู่คู่กับเวอร์ชันใหม่
SetupMutex=SDCAgentSetupMutex
; ไม่ประกาศ AppMutex โดยเจตนา
;
; AppMutex ทำให้ Inno ตรวจ mutex **ก่อน** โค้ดใน [Code] จะได้ทำงาน แล้วขึ้นกล่อง
; "Setup has detected that ... is currently running. Please close all instances"
; รอคนกด — StopRunningAgent ใน PrepareToInstall จึงไม่มีโอกาสได้ปิดให้เลย
;
; เส้นทางอัปเดตอัตโนมัติที่รันเป็น SYSTEM ไม่มีคนอยู่หน้าเครื่อง กล่องนี้กล่องเดียว
; ทำให้การอัปเกรดทั้งอำเภอค้าง (v1.1.7 เจอมาแล้วสองครั้ง ต้องให้เจ้าของกดเอง)
;
; ตัวติดตั้งจึงปิด Agent ของตัวเองด้วย stop-owned-agent.ps1 ซึ่งเลือกเป้าหมาย
; จาก "เจ้าของจริง" (path ใต้ {app} + worker.lock ที่ dataDir ตรงกัน) ไม่ใช่จากชื่อ process
CloseApplications=no
RestartApplications=no

[Languages]
Name: "thai"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startupicon"; Description: "เปิดโปรแกรมอัตโนมัติเมื่อเริ่มเครื่อง (แนะนำ)"; GroupDescription: "ตัวเลือกการติดตั้ง"
Name: "desktopicon"; Description: "สร้างไอคอนบนหน้าจอ"; GroupDescription: "ตัวเลือกการติดตั้ง"; Flags: unchecked

[Files]
; หน้าจอ + ตัว agent + Node runtime แบบพกพา (เครื่องปลายทางไม่ต้องติดตั้งอะไรเพิ่ม)
Source: "{#BuildDir}\gui\SDCAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\app\agent.js";     DestDir: "{app}\app"; Flags: ignoreversion
Source: "{#BuildDir}\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\.env.example";              DestDir: "{app}"; DestName: ".env"; Flags: onlyifdoesntexist
Source: "..\..\docs\AGENT.md";          DestDir: "{app}"; DestName: "คู่มือการใช้งาน.md"; Flags: ignoreversion skipifsourcedoesntexist
; สคริปต์ปิด Agent ของการติดตั้งนี้ — dontcopy: ใช้ตอนติดตั้งเท่านั้น ไม่ต้องวางลงเครื่อง
; เก็บเป็นไฟล์จริงเพื่ออ่าน/ทดสอบได้ ไม่ต้องฝัง PowerShell ไว้ในสตริง Pascal
Source: "stop-owned-agent.ps1";         DestDir: "{app}"; Flags: dontcopy

[Dirs]
; ข้อมูลใช้งาน (คิว/บันทึก/credential) อยู่นอก Program Files เพื่อให้เขียนได้โดยไม่ต้องเป็นผู้ดูแล
Name: "{commonappdata}\SDCAgent"; Permissions: users-modify
Name: "{commonappdata}\SDCAgent\logs"; Permissions: users-modify
Name: "{commonappdata}\SDCAgent\queue"; Permissions: users-modify
; โฟลเดอร์ไฟล์อัปเดต **ห้าม** ให้ผู้ใช้ทั่วไปเขียน
;
; ตัวอัปเดตทำงานด้วยสิทธิ์ผู้ดูแล ถ้าผู้ใช้ทั่วไปเขียนโฟลเดอร์นี้ได้ จะสลับไฟล์ติดตั้ง
; หลังตรวจ SHA-256 แต่ก่อนสั่งรันได้ กลายเป็นช่องยกระดับสิทธิ์ในเครื่อง
; ไม่ใส่ users-modify = ใช้สิทธิ์ที่ ProgramData กำหนด (ผู้ดูแล/SYSTEM เขียนได้เท่านั้น)
Name: "{commonappdata}\SDCAgent\updates"

; ทางลัดของเวอร์ชันก่อนหน้าที่ใช้ชื่อเดิม
;
; การอัปเกรดของ Inno เป็นการ "ติดตั้งทับ" ไม่ได้ถอนของเก่าออกก่อน (ในบันทึกจะเห็น
; "Will append to existing uninstall log") ทางลัดชื่อเดิมจึงค้างอยู่คู่กับชื่อใหม่
; -> เครื่องที่อัปเกรดจะมี 2 ทางลัดใน Startup ต้องลบชื่อเดิมทิ้งก่อนสร้างของใหม่
; ห้ามลบทีหลัง เพราะ [InstallDelete] ทำงานก่อน [Icons] เสมอ
[InstallDelete]
Type: files; Name: "{commonstartup}\โปรแกรมเชื่อมข้อมูล JHCIS.lnk"
Type: files; Name: "{autodesktop}\โปรแกรมเชื่อมข้อมูล JHCIS.lnk"
Type: filesandordirs; Name: "{commonprograms}\โปรแกรมเชื่อมข้อมูล JHCIS"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\ถอนการติดตั้ง"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
; --tray: เริ่มพร้อม Windows แบบย่อลงถาดระบบ ไม่รบกวนหน้าจอเจ้าหน้าที่
; {commonstartup} ไม่ใช่ {userstartup} เพราะตัวติดตั้งรันด้วยสิทธิ์ผู้ดูแล ถ้าใช้
; per-user ทางลัดจะไปอยู่ใน Startup ของบัญชีผู้ดูแลที่กดติดตั้ง ไม่ใช่ของเจ้าหน้าที่
; ที่ใช้เครื่องจริง แล้วโปรแกรมจะไม่เปิดเองเลยตอนเจ้าหน้าที่ล็อกอิน
Name: "{commonstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--tray"; Tasks: startupicon

[Registry]
; ให้ทั้งหน้าจอและตัว agent ใช้โฟลเดอร์ข้อมูลเดียวกัน
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
  ValueType: string; ValueName: "AGENT_DATA_DIR"; ValueData: "{commonappdata}\SDCAgent"; \
  Flags: preservestringtype

[Run]
; งานตามเวลาสองตัวที่ต้องใช้สิทธิ์ผู้ดูแล — คำสั่งตายตัวทั้งคู่ ไม่รับ argument จากภายนอก
;
; หน้าจอที่เจ้าหน้าที่เปิดอยู่ไม่มีสิทธิ์ตั้งเวลาเครื่องหรือเขียน Program Files
; งานสองตัวนี้จึงมี **ตารางเวลาของตัวเอง** ไม่ต้องรอให้หน้าจอสั่ง เครื่องที่เวลาเพี้ยน
; จะถูกแก้ภายในหนึ่งชั่วโมงแม้ไม่มีใครแตะเครื่อง (ปุ่มบนหน้าจอเป็นแค่ตัวเร่ง)
; /RU SYSTEM /RL HIGHEST = สิทธิ์สูงสุด · /F = เขียนทับของเดิมตอนอัปเกรด
; **ห้าม** เปลี่ยนให้รับ path/argument จากภายนอก มิฉะนั้นกลายเป็นช่องยกระดับสิทธิ์
Filename: "{app}\{#AppExe}"; Description: "เปิดโปรแกรมทันที"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"

[Code]
// ---------------------------------------------------------------------------
// การติดตั้งทับเวอร์ชันเก่า
//
// หลักการ (ใช้ซ้ำได้กับทุกเวอร์ชันถัดไป):
//   1. ปิดโปรแกรมที่กำลังทำงาน - ทั้งหน้าจอใน tray และ node.exe ที่มันสั่งทำงานอยู่
//      ถ้าไม่ปิดก่อน ไฟล์จะถูกล็อก แล้วตัวติดตั้งจะเขียนทับไม่ได้ หรือได้ไบนารี
//      ปนกันระหว่างสองเวอร์ชัน
//   2. ลบ scheduled task เก่า (ถ้ามี) - รุ่นที่เคยตั้งผ่าน Task Scheduler จะได้ไม่
//      ค้างเรียกไฟล์ที่ถูกแทนที่ไปแล้ว
//   3. ถอนเวอร์ชันเก่าออกแบบเงียบ ๆ ก่อนวางไฟล์ใหม่
//   4. ห้ามแตะ %ProgramData%\SDCAgent - คิวที่ยังส่งไม่สำเร็จและ credential
//      อยู่ในนั้น การอัปเกรดต้องไม่ทำให้ข้อมูลหายหรือต้องลงทะเบียน agent ใหม่
// ---------------------------------------------------------------------------

// คำสั่งถอนการติดตั้งของเวอร์ชันที่ติดตั้งอยู่ (ว่าง = ยังไม่เคยติดตั้ง)
function PreviousUninstaller(): String;
var
  key: String;
  value: String;
begin
  Result := '';
  key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#SetupSetting("AppId")}_is1';
  if RegQueryStringValue(HKLM, key, 'UninstallString', value) then
    Result := RemoveQuotes(value)
  else if RegQueryStringValue(HKCU, key, 'UninstallString', value) then
    Result := RemoveQuotes(value);
end;

procedure StopRunningAgent();
var
  code: Integer;
  script: String;
begin
  // ปิด Agent ของการติดตั้งนี้เอง โดยไม่ต้องให้คนกดอะไร
  //
  // เดิมใช้ taskkill /F /T /IM SDCAgent.exe ซึ่งเลือกเป้าหมายจาก**ชื่อ process**
  // และยังต้องพึ่ง AppMutex/Restart Manager มาช่วยอีกชั้น ผลคือ:
  //   1. Inno ขึ้นกล่อง "please close all instances" ก่อนโค้ดนี้จะได้ทำงาน
  //   2. ตัวทำงานที่กำพร้า (หน้าจอตายแล้วแต่ node.exe ยังถือ runtime\node.exe อยู่)
  //      ไม่ถูกปิด เพราะ /T ไล่ได้แค่ลูกของหน้าจอที่ยังมีชีวิต
  //
  // ตอนนี้ใช้สคริปต์ที่พิสูจน์ความเป็นเจ้าของก่อน (path ใต้ {app} และ worker.lock
  // ที่ dataDir ตรงกัน) ขอปิดอย่างสุภาพก่อน รอแบบมีขอบเขต แล้วจึงบังคับปิด
  // เฉพาะ PID ที่เป็นของเรา — process Node ของโปรแกรมอื่นในเครื่องต้องรอดทุกตัว
  ExtractTemporaryFile('stop-owned-agent.ps1');
  script := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
            ExpandConstant('{tmp}\stop-owned-agent.ps1') + '" -Root "' +
            ExpandConstant('{app}') + '" -DataDir "' +
            ExpandConstant('{commonappdata}\SDCAgent') + '" -TimeoutSec 20';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), script,
       '', SW_HIDE, ewWaitUntilTerminated, code);

  // งานตามเวลาเดิม (ถ้ามี) — ชื่อคงที่ ไม่รับค่าจากภายนอก
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN "{#AppNameEn}" /F',
       '', SW_HIDE, ewWaitUntilTerminated, code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  uninstaller: String;
  code: Integer;
begin
  Result := '';
  StopRunningAgent();

  uninstaller := PreviousUninstaller();
  if uninstaller <> '' then
  begin
    if not Exec(uninstaller, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART',
                '', SW_HIDE, ewWaitUntilTerminated, code) then
      Result := 'ถอนการติดตั้งเวอร์ชันเดิมไม่สำเร็จ กรุณาถอนออกเองจาก Settings > Apps แล้วติดตั้งใหม่';
    // เผื่อ tray ถูกเปิดขึ้นมาใหม่ระหว่างถอนการติดตั้ง
    StopRunningAgent();
  end;
end;

// เตือนก่อนถอนการติดตั้งว่าข้อมูลที่ยังส่งไม่สำเร็จจะค้างอยู่
// ลบงานตามเวลาที่ตัวติดตั้งสร้างไว้ ตอนถอนการติดตั้ง
// (ตอนอัปเกรดไม่ต้องลบ เพราะ [Run] ใช้ /F เขียนทับให้อยู่แล้ว)
procedure RunTool(exe, args, what: String);
var
  ok: Integer;
begin
  ok := 0;
  if not Exec(ExpandConstant(exe), args, '', SW_HIDE, ewWaitUntilTerminated, ok) then
    Log('!! ' + what + ': เรียกใช้ไม่ได้')
  else if ok <> 0 then
    Log('!! ' + what + ': exit ' + IntToStr(ok))
  else
    Log('ok ' + what);
end;

// สร้างงานตามเวลาสองตัวที่ต้องใช้สิทธิ์ผู้ดูแล + ล็อกสิทธิ์โฟลเดอร์อัปเดต
//
// เขียนใน [Code] ไม่ใช่ [Run] เพราะ /TR ต้องมีเครื่องหมายคำพูดซ้อนอยู่ข้างใน
// (path มีช่องว่าง) ซึ่งใน [Run] ต้อง escape จนอ่านไม่ออกและ Inno ตีความผิด
// สตริงเดี่ยวของ Pascal เก็บเครื่องหมายคำพูดกับ backslash ตามตัวอักษร อ่านออกกว่า
//
// **คำสั่งตายตัวทั้งคู่ ไม่รับ argument จากภายนอก** ถ้าเปลี่ยนให้รับ path
// จากที่อื่นเมื่อไร จะกลายเป็นช่องยกระดับสิทธิ์ในเครื่องทันที
procedure CreateScheduledTasks();
var
  app, node, script, updates: String;
begin
  app := ExpandConstant('{app}');
  node := '\"' + app + '\runtime\node.exe\"';
  script := '\"' + app + '\app\agent.js\"';

  RunTool('{sys}\schtasks.exe',
    '/Create /F /TN "SDCAgentTimeSync" /RU SYSTEM /RL HIGHEST /SC HOURLY /MO 1 /TR "'
      + node + ' ' + script + ' time-sync"',
    'สร้างงาน SDCAgentTimeSync');

  RunTool('{sys}\schtasks.exe',
    '/Create /F /TN "SDCAgentAutoUpdate" /RU SYSTEM /RL HIGHEST /SC HOURLY /MO 4 /TR "'
      + node + ' ' + script + ' auto-update"',
    'สร้างงาน SDCAgentAutoUpdate');

  // โฟลเดอร์อัปเดตต้องไม่ให้ผู้ใช้ทั่วไปเขียน
  //
  // [Dirs] สร้างโฟลเดอร์ให้ แต่มัน **สืบทอด** สิทธิ์ users-modify มาจาก SDCAgent
  // ข้างบน (ตรวจของจริงแล้วเจอ BUILTIN\Users : Modify) ถ้าปล่อยไว้ ผู้ใช้ทั่วไป
  // จะสลับไฟล์ติดตั้งหลังตรวจ SHA-256 แต่ก่อนที่ตัวอัปเดตสิทธิ์ผู้ดูแลจะสั่งรันได้
  // = ช่องยกระดับสิทธิ์ในเครื่อง
  // /inheritance:r ตัดการสืบทอด แล้วให้เฉพาะ Administrators (S-1-5-32-544)
  // และ SYSTEM (S-1-5-18) — ใช้ SID เพราะชื่อกลุ่มเปลี่ยนตามภาษาของ Windows
  updates := ExpandConstant('{commonappdata}\SDCAgent\updates');
  RunTool('{sys}\icacls.exe',
    '"' + updates + '" /inheritance:r /grant *S-1-5-32-544:(OI)(CI)F /grant *S-1-5-18:(OI)(CI)F',
    'ล็อกสิทธิ์โฟลเดอร์อัปเดต');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    CreateScheduledTasks();
end;

procedure RemoveScheduledTasks();
var
  code: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN "SDCAgentTimeSync" /F',
       '', SW_HIDE, ewWaitUntilTerminated, code);
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN "SDCAgentAutoUpdate" /F',
       '', SW_HIDE, ewWaitUntilTerminated, code);
end;

function InitializeUninstall(): Boolean;
begin
  Result := MsgBox('ต้องการถอนการติดตั้ง Drug data center อำเภอสันกำแพง หรือไม่?' + #13#10 +
                   'ข้อมูลการซิงก์ที่ยังส่งไม่สำเร็จจะยังอยู่ในเครื่อง',
                   mbConfirmation, MB_YESNO) = IDYES;
  // ปิดโปรแกรมก่อนลบไฟล์ ไม่งั้นไฟล์ที่ถูกล็อกจะค้างอยู่จนกว่าจะรีสตาร์ตเครื่อง
  // (การถอนแบบเงียบตอนอัปเกรดก็เข้าทางนี้เหมือนกัน)
  if Result then
  begin
    StopRunningAgent();
    RemoveScheduledTasks();
  end;
end;
