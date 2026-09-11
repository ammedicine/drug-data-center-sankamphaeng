# Reads the owned scheduled tasks and says whether they are what v1.1.9 wrote.
#
# Read-only. Queries two task names by their fixed names and prints what
# schtasks holds for them; it changes nothing, creates nothing and touches no
# other task. Run elevated - SYSTEM tasks are not visible to a standard user,
# which is also why this is a script rather than something the tray could do.
#
# Exit 0 when SDCAgentAutoUpdate exists exactly once, runs as SYSTEM at the
# highest level, repeats every 30 minutes, and is anchored inside the first
# half hour of the day (00:00 - 00:29). Exit 1 otherwise, saying which check
# failed.

[CmdletBinding()]
param(
  [string] $TaskName = 'SDCAgentAutoUpdate',
  [string] $ExpectedInterval = 'PT30M'
)

$ErrorActionPreference = 'Continue'
function Say([string] $m) { Write-Output "[verify-update-task] $m" }

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
  Say 'must run elevated: SYSTEM tasks cannot be read by a standard user'
  exit 1
}

# Exactly one task of that name, matched by full path so "SDCAgentAutoUpdate2"
# or a copy in a subfolder would not be counted.
$all = schtasks /Query /FO CSV /NH 2>$null | ConvertFrom-Csv -Header TaskName, NextRun, Status
$found = @($all | Where-Object { $_.TaskName -eq "\$TaskName" })
Say "tasks named $TaskName : $($found.Count)"
if ($found.Count -ne 1) { exit 1 }

[xml] $xml = schtasks /Query /TN $TaskName /XML 2>$null
if (-not $xml) { Say 'could not read task XML'; exit 1 }

$principal = $xml.Task.Principals.Principal
$trigger   = $xml.Task.Triggers.TimeTrigger
$action    = $xml.Task.Actions.Exec

$userId    = $principal.UserId
$runLevel  = $principal.RunLevel
$interval  = $trigger.Repetition.Interval
$start     = $trigger.StartBoundary
$command   = $action.Command
$arguments = $action.Arguments

Say "UserId        : $userId"
Say "RunLevel      : $runLevel"
Say "Interval      : $interval"
Say "StartBoundary : $start"
Say "Command       : $command"
Say "Arguments     : $arguments"

$ok = $true
if ($userId -ne 'S-1-5-18')            { Say 'FAIL: not SYSTEM (S-1-5-18)'; $ok = $false }
if ($runLevel -ne 'HighestAvailable')  { Say 'FAIL: not highest run level';  $ok = $false }
if ($interval -ne $ExpectedInterval)   { Say "FAIL: interval is not $ExpectedInterval"; $ok = $false }
if ($start -notmatch 'T00:[0-2][0-9]:00$') { Say 'FAIL: not anchored inside 00:00-00:29'; $ok = $false }
if ($arguments -notmatch 'auto-update$') { Say 'FAIL: action is not the auto-update command'; $ok = $false }
if ($command -notmatch 'SDC Agent\\runtime\\node\.exe') { Say 'FAIL: command is not the installed runtime'; $ok = $false }

if ($ok) { Say 'PASS: one SYSTEM task, every 30 minutes, anchored in its own minute'; exit 0 }
exit 1
