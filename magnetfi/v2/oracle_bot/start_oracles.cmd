@echo off
REM Starts the MagnetFi oracle feed at logon, via a stub in the Windows
REM Startup folder. Added 2026-10-17 after a power cut left an oracle down for
REM 48 hours because nothing restarted it.
REM
REM This launched TWO bots until the banded oracle was retired the same day
REM (ORACLE_LEAN_SPEC.md §6 step 8). It now starts one. The banded oracle app
REM 3644230020 still exists on chain -- the contract has no delete handler, so
REM it and its ~1.5 ALGO MBR are permanent -- but the vault does not read it
REM and nothing posts to it. config.json is kept beside config.lean.json as the
REM record of what it was configured with.
REM
REM TWAP_STATE_PATH stays explicit: if a second bot is ever run again, each one
REM needs its OWN state file. Two bots sharing one corrupts the history.
cd /d "%~dp0"
start "magnetfi-lean" cmd /k "set TWAP_STATE_PATH=%~dp0twap_state.lean.json&& python oracle_bot.py --config config.lean.json"
