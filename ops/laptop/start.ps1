# Start karobakbak on this laptop, and say whether it actually came up.
#
#   powershell -ExecutionPolicy Bypass -File ops\laptop\start.ps1
#
# Or double-click the desktop shortcut LAPTOP-HOSTING.md step 9 creates.
#
# You rarely need this. Every service has `restart: unless-stopped`, so once the
# stack has been started it comes back by itself whenever Docker Desktop does.
# This is for the first start, after `laptop:down`, and after a rebuild.
#
# It reports rather than trusts: a stack where every container is "running"
# while `migrate` sits at exit 1 has no schema, and `docker ps` will not show it.

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo

if (-not (Test-Path '.env.laptop')) {
    Write-Host 'No .env.laptop in the repository root. Copy .env.laptop.example and fill it in first (LAPTOP-HOSTING.md step 5).' -ForegroundColor Red
    exit 1
}

# Docker Desktop, started if it is not running, then waited for. The engine
# answers several seconds after the window appears.
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $desktop)) {
        Write-Host "Docker Desktop is not running and was not found at $desktop" -ForegroundColor Red
        exit 1
    }
    Write-Host 'Starting Docker Desktop...'
    Start-Process $desktop
    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 3
        docker info *> $null
    } until ($LASTEXITCODE -eq 0 -or (Get-Date) -gt $deadline)
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Docker Desktop did not become ready within three minutes.' -ForegroundColor Red
        exit 1
    }
}

Write-Host 'Building and starting the live stack (project karobakbak-live)...'
npm run laptop:up
if ($LASTEXITCODE -ne 0) {
    Write-Host 'laptop:up failed - read the error above. A "required variable" message names the line missing from .env.laptop.' -ForegroundColor Red
    exit 1
}

$compose = @('--env-file', '.env.laptop', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', '-f', 'docker-compose.laptop.yml')

# migrate is a one-shot. Running, or exited 0, is fine; anything else is not.
$deadline = (Get-Date).AddMinutes(2)
do {
    Start-Sleep -Seconds 2
    $state = docker compose @compose ps -a migrate --format '{{.State}} {{.ExitCode}}'
} until ($state -notmatch '^(created|running)' -or (Get-Date) -gt $deadline)
if ($state -notmatch '^exited 0') {
    Write-Host "migrate did not finish cleanly: $state" -ForegroundColor Red
    Write-Host 'Read it with: docker compose --env-file .env.laptop -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.laptop.yml logs migrate'
    exit 1
}

# Asked of the public origin, through Cloudflare and the tunnel, because that
# is the path a visitor takes. A healthy container behind a dead tunnel is an
# outage.
$ready = $false
$deadline = (Get-Date).AddMinutes(2)
do {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-WebRequest -Uri 'https://karobakbak.com/ready' -UseBasicParsing -TimeoutSec 10
        $ready = $r.StatusCode -eq 200
    } catch { $ready = $false }
} until ($ready -or (Get-Date) -gt $deadline)

docker compose @compose ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

if ($ready) {
    Write-Host ''
    Write-Host 'karobakbak is live: https://karobakbak.com/ready answered 200 through the tunnel.' -ForegroundColor Green
    Write-Host 'Grafana: http://localhost:3010'
} else {
    Write-Host ''
    Write-Host 'The stack is up but https://karobakbak.com/ready did not answer 200 within two minutes.' -ForegroundColor Yellow
    Write-Host 'Check the tunnel first: npm run laptop:logs (cloudflared lines), then the tunnel status in the Cloudflare dashboard.'
    exit 1
}
