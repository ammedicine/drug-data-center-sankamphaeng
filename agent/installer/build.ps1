<#
.SYNOPSIS
  สร้างตัวติดตั้ง Windows ของโปรแกรมเชื่อมข้อมูล JHCIS (Agent)

.DESCRIPTION
  รวม 4 ขั้นตอน: bundle agent (esbuild) -> เตรียม Node runtime แบบพกพา ->
  build หน้าจอเป็น .exe (PyInstaller) -> ประกอบเป็นตัวติดตั้ง (Inno Setup)

  รันจากโฟลเดอร์ agent:  .\installer\build.ps1
  ระบุเวอร์ชันเองได้:     .\installer\build.ps1 -Version 1.0.2
  ถ้าไม่ระบุ จะอ่านจาก git tag ล่าสุด (git describe --tags)

.NOTES
  กติกาการออกเวอร์ชันใหม่ - ทำแบบเดียวกันทุกครั้ง
  ---------------------------------------------------------------------------
  1. เวอร์ชันมาจาก git tag เสมอ (`git tag v1.0.2 && git push --tags`)
     ไฟล์ที่ได้ชื่อ SDCAgent-Setup-<version>.exe ซึ่งเว็บใช้ pattern นี้ค้นหา
     ใน GitHub Release ถ้าเปลี่ยนรูปแบบชื่อ ต้องแก้ INSTALLER_PATTERN ใน
     src/lib/services/agent-release.ts ให้ตรงกัน
  2. **ห้ามเปลี่ยน AppId ใน sdc-agent.iss** เพราะ Windows ใช้ค่านี้ระบุว่าเป็น
     โปรแกรมตัวเดียวกัน ถ้าเปลี่ยน เวอร์ชันเก่าจะค้างอยู่คู่กับเวอร์ชันใหม่
     และมี agent สองตัวแย่งกันซิงก์
  3. ตัวติดตั้งจัดการอัปเกรดเองแล้ว (ดู [Code] ใน sdc-agent.iss):
     ปิด tray + node.exe ที่ทำงานอยู่ -> ลบ scheduled task เก่า ->
     ถอนเวอร์ชันเดิมแบบเงียบ -> ติดตั้งตัวใหม่ -> เปิดคืน
  4. **ห้ามลบ %ProgramData%\SDCAgent** ตอนอัปเกรด - ในนั้นมีคิวที่ยังส่งไม่สำเร็จ
     กับ credential ถ้าลบ ข้อมูลหายและต้องลงทะเบียน agent ใหม่ทุกเครื่อง
  5. อัปโหลดไฟล์ที่ได้ขึ้น GitHub Release ของ tag นั้น (`gh release create`)
     repo เป็น private เว็บจึงดึงไฟล์ผ่าน /download/agent ด้วย GITHUB_TOKEN
     ฝั่ง server - ผู้ใช้เห็นแค่ไฟล์ ไม่เห็นโค้ด
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$NodeVersion = "20.18.1",
  [switch]$SkipInstaller,
  [switch]$SkipRuntime
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $PSScriptRoot
$BuildDir = Join-Path $AgentRoot "build"
$OutputDir = Join-Path $PSScriptRoot "output"

function Step($message) { Write-Host "`n=== $message ===" -ForegroundColor Cyan }
function Info($message) { Write-Host "    $message" -ForegroundColor DarkGray }

# Windows PowerShell turns anything a native program writes to stderr into a
# terminating error while ErrorActionPreference is Stop - and PyInstaller,
# esbuild and ISCC all report progress on stderr. Exit codes are the honest
# signal, so native calls run through this and are judged on $LASTEXITCODE.
function Invoke-Native {
  param([scriptblock]$Command, [string]$What)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Command } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "$What ล้มเหลว (exit $LASTEXITCODE)" }
}

Set-Location $AgentRoot
New-Item -ItemType Directory -Force -Path $BuildDir, $OutputDir | Out-Null

# เวอร์ชันมาจาก git tag เพื่อให้ไฟล์ที่แจก ตรงกับ commit ที่ build มันขึ้นมาเสมอ
if (-not $Version) {
  # แท็กล่าสุดเท่านั้น ไม่เอา -dirty หรือจำนวน commit ต่อท้าย เพราะเวอร์ชันต้องเป็น
  # เลขล้วนทั้งในชื่อไฟล์และใน VersionInfo ของ Windows
  $tag = (git describe --tags --abbrev=0 2>$null)
  if ($LASTEXITCODE -eq 0 -and $tag) { $Version = ($tag -replace '^v', '') }
  if (-not $Version -or $Version -notmatch '^\d+\.\d+') {
    Write-Warning "ไม่พบ git tag ที่เป็นเลขเวอร์ชัน - ใช้ 0.0.0-dev แทน (อย่านำไปแจกจริง)"
    $Version = "0.0.0-dev"
  } else {
    # เตือนถ้าไฟล์ที่กำลัง build ไม่ตรงกับ tag นั้นเป๊ะ ๆ - ตัวติดตั้งจะบอกเวอร์ชัน
    # หนึ่ง แต่ข้างในเป็นโค้ดอีกแบบ ซึ่งตามรอยย้อนหลังไม่ได้
    if ((git status --porcelain 2>$null)) {
      Write-Warning "working tree มีไฟล์ที่ยังไม่ commit - ตัวติดตั้งจะไม่ตรงกับ tag $tag"
    } elseif ((git rev-parse HEAD 2>$null) -ne (git rev-list -n 1 $tag 2>$null)) {
      Write-Warning "HEAD ไม่ได้อยู่ที่ tag $tag - ตัวติดตั้งจะไม่ตรงกับเวอร์ชันที่ระบุ"
    }
  }
}
Info "เวอร์ชันที่จะ build: $Version"

# AGENT_VERSION คือเวอร์ชันที่ agent รายงานเข้าศูนย์กลางทุก heartbeat ถ้าไม่ตรงกับ
# ตัวติดตั้ง หน้าเว็บจะบอกเวอร์ชันผิด และตามไม่ได้ว่าเครื่องไหนยังไม่อัปเดต
$configPath = Join-Path $AgentRoot "src\config.ts"
$declared = (Select-String -Path $configPath -Pattern 'AGENT_VERSION = "([^"]+)"').Matches[0].Groups[1].Value
if ($declared -ne $Version) {
  throw "AGENT_VERSION ใน src/config.ts เป็น $declared แต่กำลัง build $Version - แก้ให้ตรงกันก่อน"
}

# 1 ------------------------------------------------------------ bundle agent
Step "1/4 รวมโค้ด agent เป็นไฟล์เดียว (esbuild)"
if (-not (Test-Path (Join-Path $AgentRoot "node_modules"))) {
  Info "ติดตั้ง dependencies..."
  Invoke-Native { npm install --no-audit --no-fund } "npm install"
}
New-Item -ItemType Directory -Force -Path (Join-Path $BuildDir "app") | Out-Null
# mysql2 ships optional native-looking requires that esbuild must not follow;
# bundling everything else keeps the payload to a single file.
Invoke-Native {
  npx --yes esbuild@0.24.0 src/cli.ts `
    --bundle `
    --platform=node `
    --target=node18 `
    --format=cjs `
    --outfile="$BuildDir\app\agent.js" `
    --external:better-sqlite3 `
    --log-level=warning
} "esbuild"
Info "ได้ไฟล์ $BuildDir\app\agent.js"

# 2 ------------------------------------------------------------ node runtime
Step "2/4 เตรียม Node runtime แบบพกพา"
$RuntimeDir = Join-Path $BuildDir "runtime"
$NodeExe = Join-Path $RuntimeDir "node.exe"
if ($SkipRuntime -and -not (Test-Path $NodeExe)) {
  Info "ข้ามตามที่สั่ง แต่ยังไม่มี node.exe - ตัวติดตั้งจะไม่สมบูรณ์"
} elseif (Test-Path $NodeExe) {
  Info "มีอยู่แล้ว: $NodeExe"
} else {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $zipName = "node-v$NodeVersion-win-x64"
  $zipPath = Join-Path $BuildDir "$zipName.zip"
  Info "ดาวน์โหลด Node $NodeVersion ..."
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$zipName.zip" -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $BuildDir -Force
  Copy-Item (Join-Path $BuildDir "$zipName\node.exe") $NodeExe -Force
  Remove-Item (Join-Path $BuildDir $zipName) -Recurse -Force
  Remove-Item $zipPath -Force
  Info "ได้ $NodeExe"
}

# 3 ---------------------------------------------------------------- gui exe
Step "3/4 build หน้าจอเป็น SDCAgent.exe (PyInstaller)"
$Venv = Join-Path $AgentRoot "gui\.venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
  Info "สร้าง virtual environment..."
  Invoke-Native { python -m venv $Venv } "python -m venv"
}
Invoke-Native {
  & $VenvPython -m pip install --quiet --disable-pip-version-check -r (Join-Path $AgentRoot "gui\requirements.txt")
} "pip install"

$customtkinterPath = & $VenvPython -c "import customtkinter, os; print(os.path.dirname(customtkinter.__file__))"
Invoke-Native {
  & $VenvPython -m PyInstaller `
    --noconfirm --clean --windowed --onefile `
    --name SDCAgent `
    --distpath (Join-Path $BuildDir "gui") `
    --workpath (Join-Path $BuildDir "pyinstaller") `
    --specpath (Join-Path $BuildDir "pyinstaller") `
    --add-data "$customtkinterPath;customtkinter" `
    (Join-Path $AgentRoot "gui\sdc_agent_gui.py")
} "PyInstaller"
Info "ได้ $BuildDir\gui\SDCAgent.exe"

# 4 -------------------------------------------------------------- installer
Step "4/4 ประกอบเป็นตัวติดตั้ง (Inno Setup)"
if ($SkipInstaller) {
  Info "ข้ามตามที่สั่ง"
  return
}

$Iscc = @(
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $Iscc) {
  Write-Warning "ไม่พบ ISCC.exe - ติดตั้ง Inno Setup 6 จาก https://jrsoftware.org/isdl.php"
  Write-Warning "ไฟล์ที่ build แล้วอยู่ใน $BuildDir พร้อมประกอบเมื่อติดตั้ง Inno Setup เสร็จ"
  return
}

Invoke-Native {
  & $Iscc "/DAppVersion=$Version" (Join-Path $PSScriptRoot "sdc-agent.iss")
} "Inno Setup"

$setup = Join-Path $OutputDir "SDCAgent-Setup-$Version.exe"
Write-Host "`nเสร็จแล้ว: $setup" -ForegroundColor Green
if (Test-Path $setup) {
  $sha = (Get-FileHash $setup -Algorithm SHA256).Hash
  Info "SHA-256: $sha"
  Info "ขั้นถัดไป - เผยแพร่ให้เว็บดึงไปแจก:"
  Info ('  gh release create v' + $Version + ' ' + $setup + ' --title ' + $Version + ' --notes SHA-256:' + $sha)
}
