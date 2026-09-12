# Registers the Agent's update task from its XML definition, and lets the
# signed-in person start it.
#
# Why XML: `schtasks /Create /SC HOURLY` leaves every other setting at its
# default, and two of those defaults are why a v1.1.8 machine sat for a day
# without installing v1.1.9 - a trigger that fell while the PC was off was
# simply lost, and a notebook on battery never started. The XML written by
# `agent update-task-xml` states StartWhenAvailable, the battery flags, a boot
# trigger and the PT30M cadence explicitly, and a test asserts each one.
#
# Why a security descriptor: the tray runs as a standard user and cannot
# start a SYSTEM task. When the centre hands down an update command, the
# worker writes it to disk and asks Task Scheduler to run this task now; with
# read+execute granted to Users that request succeeds and the install begins
# within seconds instead of at the next half-hour slot. The action stays
# fixed - nothing a user can do changes *what* the task runs.
#
#   -TaskName  fixed; SDCAgentAutoUpdate
#   -XmlPath   the definition written by the Agent during install
#
# Exit 0 on success. Exit 1 with a message otherwise; the installer logs it.

[CmdletBinding()]
param(
  [string] $TaskName = 'SDCAgentAutoUpdate',
  [Parameter(Mandatory = $true)][string] $XmlPath
)

$ErrorActionPreference = 'Continue'
function Say([string] $m) { Write-Output "[register-update-task] $m" }

if (-not (Test-Path $XmlPath)) { Say "definition not found: $XmlPath"; exit 1 }

# /F replaces a task of the same name written by any earlier installer, so an
# upgrade over 1.1.7, 1.1.8 or 1.1.9 ends with exactly one task and never two.
& schtasks.exe /Create /TN $TaskName /XML $XmlPath /F | Out-Null
if ($LASTEXITCODE -ne 0) { Say "schtasks /Create failed with exit $LASTEXITCODE"; exit 1 }
Say "task registered from XML"

# Grant Users read+execute on the task object. SYSTEM and Administrators keep
# full control. GR = generic read, GX = generic execute; nothing that would let
# a user change the definition.
try {
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  $folder = $svc.GetFolder('\')
  $task = $folder.GetTask($TaskName)
  $sddl = 'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)'
  $task.SetSecurityDescriptor($sddl, 0)
  Say "security descriptor set: Users may run it"
} catch {
  # Not fatal: the schedule still works; only "run now" from the tray will not.
  Say "could not set security descriptor: $($_.Exception.Message)"
}

# Read back and print what was registered, so the install log holds proof.
$xml = [xml](& schtasks.exe /Query /TN $TaskName /XML)
$trigger = $xml.Task.Triggers.TimeTrigger
Say ("Interval=" + $trigger.Repetition.Interval + " StartBoundary=" + $trigger.StartBoundary +
     " StartWhenAvailable=" + $xml.Task.Settings.StartWhenAvailable +
     " DisallowStartIfOnBatteries=" + $xml.Task.Settings.DisallowStartIfOnBatteries +
     " RunAs=" + $xml.Task.Principals.Principal.UserId)
exit 0
