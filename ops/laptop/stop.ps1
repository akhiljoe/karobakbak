# Stop karobakbak on this laptop. The site goes offline until the next start.
#
#   powershell -ExecutionPolicy Bypass -File ops\laptop\stop.ps1
#
# Stops and removes the containers and KEEPS the data: the database,
# Prometheus history and the backup volume all stay.
# There is deliberately no `-v` here and no option to add one. Deleting the live
# database is not something a shortcut should be one keystroke away from.
#
# Live conversations end when Redis stops (persistence is off, D12). Anybody
# talking at that moment sees the connection drop.

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))

$answer = Read-Host 'This takes karobakbak.com offline. Type STOP to continue'
if ($answer -ne 'STOP') {
    Write-Host 'Nothing stopped.'
    exit 0
}

npm run laptop:down
if ($LASTEXITCODE -eq 0) {
    Write-Host 'Stopped. Data volumes kept. Start again with ops\laptop\start.ps1.' -ForegroundColor Green
}
