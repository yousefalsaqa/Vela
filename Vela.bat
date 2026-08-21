@echo off
REM Double-click this to talk to her in a browser.
REM
REM Starting her twice is the obvious way to get this wrong, so serve.ts checks
REM first: if she is already up it just opens the hub against the running
REM process and exits. That makes double-clicking twice harmless.

cd /d "%~dp0"

set VELA_OPEN=on

REM No voice or microphone here. The browser is the face; speech belongs to the
REM terminal client, which has the Kokoro worker and the mic.
set VELA_VOICE=off
set VELA_LISTEN=off

title Vela

call npm run serve

REM Only reached if she stopped or refused to start. Hold the window open so
REM the reason is readable instead of vanishing with it.
echo.
echo   She stopped. The reason is above.
pause
