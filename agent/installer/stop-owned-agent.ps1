# Stops the SDC Agent belonging to one installation, and nothing else.
#
# The installer cannot ask a person to close the program. The whole point of
# the SYSTEM auto-update path is that no person is there: it runs from a
# scheduled task at four in the morning, and a dialog saying "please close all
# instances" would stop the entire district's upgrade dead, waiting for a click
# that never comes. v1.1.7 hit exactly that and needed a human twice.
#
# So ownership is established by evidence and the shutdown is graceful first,
# bounded, and forced only as a last resort - and only against processes proven
# to belong to this installation.
#
# What must never happen: taskkill /IM node.exe, or anything else that matches
# by process name. A รพ.สต. PC runs other Node programs - the district office
# has seen Codex, Laragon and a dev toolchain on the same machine - and killing
# those to install a drug-dispensing agent would be indefensible.
#
#   -Root       the installation directory, e.g. C:\Program Files\SDC Agent
#   -DataDir    the agent's data directory, for the worker.lock cross-check
#   -TimeoutSec how long to wait for a graceful exit before forcing
#
# Exit 0: nothing owned is left running. Exit 1: something owned survived.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Root,
  [string] $DataDir = "$env:ProgramData\SDCAgent",
  [int]    $TimeoutSec = 20
)

$ErrorActionPreference = 'Continue'

function Write-Step([string] $Message) { Write-Output "[stop-owned-agent] $Message" }

# The processes this installation owns.
#
# Path is the primary evidence and the only one that is sufficient on its own:
# an executable running from inside the directory being replaced is by
# definition part of this installation. The worker.lock PID is used as
# corroboration and to catch a worker whose tray has already died - the orphan
# case that held runtime\node.exe open during the v1.1.7 upgrade.
function Get-OwnedProcesses {
  $root = $Root.TrimEnd('\')
  $owned = @()

  foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    if (-not $p.ExecutablePath) { continue }
    if ($p.Name -ne 'SDCAgent.exe' -and $p.Name -ne 'node.exe') { continue }
    if ($p.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $owned += [pscustomobject]@{
        ProcessId = $p.ProcessId
        Name      = $p.Name
        Path      = $p.ExecutablePath
        Why       = 'path under installation'
      }
    }
  }

  # A worker named by worker.lock, if it is not already covered by path. The
  # lock records the data directory it belongs to, so a second installation's
  # lock can never select this one's processes.
  $lockPath = Join-Path $DataDir 'worker.lock'
  if (Test-Path $lockPath) {
    try {
      $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
      if ($lock.dataDir -and ($lock.dataDir.TrimEnd('\') -ieq $DataDir.TrimEnd('\')) -and $lock.pid) {
        if (-not ($owned | Where-Object { $_.ProcessId -eq $lock.pid })) {
          $held = Get-CimInstance Win32_Process -Filter "ProcessId=$($lock.pid)" -ErrorAction SilentlyContinue
          # Only if it really is our worker: a recycled PID belonging to
          # something unrelated must not be touched.
          if ($held -and $held.Name -eq 'node.exe' -and $held.CommandLine -and
              $held.CommandLine.ToLower().Contains('agent.js')) {
            $owned += [pscustomobject]@{
              ProcessId = $held.ProcessId
              Name      = $held.Name
              Path      = $held.ExecutablePath
              Why       = 'worker.lock for this dataDir'
            }
          }
        }
      }
    } catch {
      Write-Step "worker.lock could not be read, relying on path ownership: $($_.Exception.Message)"
    }
  }

  return $owned
}

$initial = Get-OwnedProcesses
if (-not $initial -or $initial.Count -eq 0) {
  Write-Step 'nothing owned is running'
  exit 0
}

foreach ($p in $initial) {
  Write-Step "owned: pid=$($p.ProcessId) $($p.Name) [$($p.Why)]"
}

# Ask first. A tray that closes itself gets to release its own mutex, write its
# status file and let its worker shut down through the ordinary path, which is
# how the durable queue stays coherent.
foreach ($p in $initial) {
  try {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
    if ($proc.CloseMainWindow()) { Write-Step "asked pid=$($p.ProcessId) to close" }
  } catch {
    # Already gone, or has no window - the wait below settles it either way.
  }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-OwnedProcesses)) {
    Write-Step 'all owned processes exited gracefully'
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

# Bounded patience spent. Force only what is still there, and only by PID -
# each one re-resolved now, so nothing that started in the meantime is caught
# by a stale list.
foreach ($p in Get-OwnedProcesses) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    Write-Step "stopped pid=$($p.ProcessId) $($p.Name)"
  } catch {
    Write-Step "could not stop pid=$($p.ProcessId): $($_.Exception.Message)"
  }
}

Start-Sleep -Seconds 2
$left = Get-OwnedProcesses
if ($left) {
  foreach ($p in $left) { Write-Step "STILL RUNNING pid=$($p.ProcessId) $($p.Path)" }
  exit 1
}

Write-Step 'no owned Tray or worker remains'
exit 0
