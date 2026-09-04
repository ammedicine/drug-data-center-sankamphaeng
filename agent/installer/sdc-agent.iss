; ตัวติดตั้งโปรแกรมเชื่อมข้อมูล JHCIS - ศูนย์ข้อมูลการใช้ยา อำเภอสันกำแพง
; ประกอบไฟล์ที่ build.ps1 เตรียมไว้ใน ..\build

#define AppName "โปรแกรมเชื่อมข้อมูล JHCIS"
#define AppNameEn "SDC Agent"
#define AppVersion "1.0.0"
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

[Dirs]
; ข้อมูลใช้งาน (คิว/บันทึก/credential) อยู่นอก Program Files เพื่อให้เขียนได้โดยไม่ต้องเป็นผู้ดูแล
Name: "{commonappdata}\SDCAgent"; Permissions: users-modify
Name: "{commonappdata}\SDCAgent\logs"; Permissions: users-modify
Name: "{commonappdata}\SDCAgent\queue"; Permissions: users-modify

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\ถอนการติดตั้ง"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
; --tray: เริ่มพร้อม Windows แบบย่อลงถาดระบบ ไม่รบกวนหน้าจอเจ้าหน้าที่
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--tray"; Tasks: startupicon

[Registry]
; ให้ทั้งหน้าจอและตัว agent ใช้โฟลเดอร์ข้อมูลเดียวกัน
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
  ValueType: string; ValueName: "AGENT_DATA_DIR"; ValueData: "{commonappdata}\SDCAgent"; \
  Flags: preservestringtype

[Run]
Filename: "{app}\{#AppExe}"; Description: "เปิดโปรแกรมทันที"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"

[Code]
// เตือนก่อนถอนการติดตั้งว่าข้อมูลที่ยังส่งไม่สำเร็จจะค้างอยู่
function InitializeUninstall(): Boolean;
begin
  Result := MsgBox('ต้องการถอนการติดตั้งโปรแกรมเชื่อมข้อมูล JHCIS หรือไม่?' + #13#10 +
                   'ข้อมูลการซิงก์ที่ยังส่งไม่สำเร็จจะยังอยู่ในเครื่อง',
                   mbConfirmation, MB_YESNO) = IDYES;
end;
