# Restart her: stop the running service and everything it started, then start
# her the way logon does.
#
#   npm run restart
#
# The service is a tree: tsx, the service under it, and under that the whisper,
# Kokoro, voiceprint, wake word and window workers and the microphone's ffmpeg.
# Killing the top of the tree with /T takes every one of them with it, so a
# restart never leaves a worker holding the microphone or a GPU's memory.

$ErrorActionPreference = "Stop"

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'tsx.*cli\.mjs.*serve\.ts' }
foreach ($p in $running) { taskkill /PID $p.ProcessId /T /F | Out-Null }
if ($running) { "Stopped her ($(@($running).Count) service)." } else { "She wasn't running." }

# The microphone and the port are let go of a moment after the processes go.
Start-Sleep -Milliseconds 800

if (Get-ScheduledTask -TaskName "Vela" -ErrorAction SilentlyContinue) {
  Start-ScheduledTask -TaskName "Vela"
  "Starting her. She's listening in about 15 seconds; data\service.log says when."
} else {
  "There is no Vela task to start her from. Register it once with:"
  "  powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1"
}
