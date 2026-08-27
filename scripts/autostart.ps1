# Make her start with Windows, hidden, and stay reachable at one address.
#
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove
#
# A scheduled task rather than a Startup shortcut, because Startup runs the
# .bat and that means a console window sitting in the taskbar all day. This
# runs her with no window at all: the only way you meet her is the hub.
#
# She is started at logon with a short delay, so the machine finishes booting
# before a node process and a model session compete with it.

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$name = "Vela"
$repo = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    "Removed the $name task. She no longer starts with Windows."
  } else {
    "There was no $name task to remove."
  }
  return
}

# wscript with a one-line vbs is the standard way to get a genuinely hidden
# process on Windows: -WindowStyle Hidden on powershell.exe still flashes a
# console, and cmd /c always shows one.
$launcher = Join-Path $repo "scripts\vela-hidden.vbs"
$runner = Join-Path $repo "scripts\vela-service.cmd"

@"
@echo off
cd /d "%~dp0.."
REM Unprimed base.en cannot produce the name: it decodes "Hello" or drops it
REM entirely, so the wake word never sees it. A prior of the name alone is the
REM narrowest fix; the gate in listen.ts still judges what comes back.
set VELA_WAKE_VOCABULARY=Vela
REM A notch looser than the defaults (0.5 / -1.0). Her name is one short word
REM with no sentence around it to lend it context, so a real one scores worse
REM than ordinary speech does. Small on purpose: this is the only thing
REM standing between an open microphone and whisper inventing her name.
set VELA_SILENCE=0.55
set VELA_LOGPROB=-1.15
REM No wake model. hey_jarvis is the wrong word, and her own, at a threshold
REM clean enough to trust, answered 2 of 5 clean recordings of the phrase. A
REM model loaded at all switches the transcript path off, and the transcript
REM path is the one that works.
set VELA_WAKE_DETECT=0
REM So the address is "Hey Vela" rather than "Vela". The bare name is what
REM base.en writes out of room tone, and each of those is a turn he did not ask
REM for; a word in front of it is the whole difference.
set VELA_WAKE_LEAD=1
call npm run serve >> "%~dp0..\data\service.log" 2>&1
"@ | Set-Content -Path $runner -Encoding ascii

@"
CreateObject("Wscript.Shell").Run """$runner""", 0, False
"@ | Set-Content -Path $launcher -Encoding ascii

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument """$launcher""" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT30S"
# Battery is where a logon task usually dies quietly; she is meant to be on.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Description "Vela, running from logon." -Force | Out-Null

"Registered the $name task. She starts hidden about 30s after you log in."
"Start her now with:  Start-ScheduledTask -TaskName $name"
