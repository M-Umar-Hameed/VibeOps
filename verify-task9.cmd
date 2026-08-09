@echo off
set TEMP_HOME=%TEMP%\vibeops-test-home-%RANDOM%
mkdir "%TEMP_HOME%"
set VIBEOPS_HOME=%TEMP_HOME%
set USERPROFILE=%TEMP_HOME%
set HOME=%TEMP_HOME%
set VIBEOPS_MIGRATIONS_DIR=drizzle
call npm run backup
dir "%TEMP_HOME%\.vibeops\backups"
for %%I in ("%TEMP_HOME%\.vibeops\backups\export-*.json") do call npm run restore -- "%%I"
rmdir /s /q "%TEMP_HOME%"
