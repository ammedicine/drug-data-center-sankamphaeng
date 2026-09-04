<#
.SYNOPSIS
  สร้างตัวติดตั้ง Windows ของโปรแกรมเชื่อมข้อมูล JHCIS (Agent)

.DESCRIPTION
  รวม 4 ขั้นตอน: bundle agent (esbuild) -> เตรียม Node runtime แบบพกพา ->
  build หน้าจอเป็น .exe (PyInstaller) -> ประกอบเป็นตัวติดตั้ง (Inno Setup)

  รันจากโฟลเดอร์ agent:  .\installer\build.ps1
#>
[CmdletBinding()]
param(
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

Set-Location $AgentRoot
New-Item -ItemType Directory -Force -Path $BuildDir, $OutputDir | Out-Null

# 1 ------------------------------------------------------------ bundle agent
Step "1/4 รวมโค้ด agent เป็นไฟล์เดียว (esbuild)"
if (-not (Test-Path (Join-Path $AgentRoot "node_modules"))) {
  Info "ติดตั้ง dependencies..."
  npm install --no-audit --no-fund
}
New-Item -ItemType Directory -Force -Path (Join-Path $BuildDir "app") | Out-Null
# mysql2 ships optional native-looking requires that esbuild must not follow;
# bundling everything else keeps the payload to a single file.
npx --yes esbuild@0.24.0 src/cli.ts `
  --bundle `
  --platform=node `
  --target=node18 `
  --format=cjs `
  --outfile="$BuildDir\app\agent.js" `
  --external:better-sqlite3 `
  --log-level=warning
if ($LASTEXITCODE -ne 0) { throw "esbuild ล้มเหลว" }
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
  python -m venv $Venv
}
& $VenvPython -m pip install --quiet --disable-pip-version-check -r (Join-Path $AgentRoot "gui\requirements.txt")

$customtkinterPath = & $VenvPython -c "import customtkinter, os; print(os.path.dirname(customtkinter.__file__))"
& $VenvPython -m PyInstaller `
  --noconfirm --clean --windowed --onefile `
  --name SDCAgent `
  --distpath (Join-Path $BuildDir "gui") `
  --workpath (Join-Path $BuildDir "pyinstaller") `
  --specpath (Join-Path $BuildDir "pyinstaller") `
  --add-data "$customtkinterPath;customtkinter" `
  (Join-Path $AgentRoot "gui\sdc_agent_gui.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller ล้มเหลว" }
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

& $Iscc (Join-Path $PSScriptRoot "sdc-agent.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup ล้มเหลว" }
Write-Host "`nเสร็จแล้ว: $OutputDir" -ForegroundColor Green
