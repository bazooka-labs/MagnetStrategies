@echo off
cd /d "%~dp0"
start "magnetfi-banded" cmd /k "set TWAP_STATE_PATH=%~dp0twap_state.json&& python oracle_bot.py --config config.json"
start "magnetfi-lean"   cmd /k "set TWAP_STATE_PATH=%~dp0twap_state.lean.json&& python oracle_bot.py --config config.lean.json"
