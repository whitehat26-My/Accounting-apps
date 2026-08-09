<#
.SYNOPSIS
    Show what is actually saved in your books.

.DESCRIPTION
    Answers the question a screen cannot: whether what you did was WRITTEN
    DOWN, or only displayed. Counts what is stored, shows whether the history
    is being kept, and checks the books balance.

    Run it after using the system for a while:

        powershell -ExecutionPolicy Bypass -File scripts\check-data.ps1

    It READS ONLY. The SQL runs inside a READ ONLY transaction, so PostgreSQL
    itself refuses any write from it — a tool meant to reassure you about your
    data must not be able to be the thing that damages it.

    Nothing to install: it runs psql inside the database container that is
    already on this machine.
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Die($message) {
    Write-Host ''
    Write-Host "  $message" -ForegroundColor Red
    Write-Host ''
    exit 1
}

# The password lives in .env.prod, which is the only copy — read it rather than
# asking, so this is one command and not a scavenger hunt.
$envFile = Join-Path $root '.env.prod'
if (-not (Test-Path $envFile)) {
    Die ".env.prod not found. Run this from the folder the system was installed into."
}

$password = $null
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*POSTGRES_PASSWORD\s*=\s*(.+?)\s*$') { $password = $Matches[1] }
}
if (-not $password) { Die "POSTGRES_PASSWORD is not set in .env.prod." }

# Is the database actually up? A connection error three screens down is a worse
# way to learn "you forgot to start it" than one sentence here.
$running = docker compose -f docker-compose.prod.yml ps --status running --services 2>$null
if ($LASTEXITCODE -ne 0) {
    Die "Docker is not running. Start Docker Desktop, wait for the whale icon to settle, then try again."
}
if ($running -notcontains 'db') {
    Die "The database is not running. Start it with:`n`n      docker compose -f docker-compose.prod.yml --env-file .env.prod up -d"
}

Write-Host ''
Write-Host '  Reading your books...' -ForegroundColor Cyan

# -T: no TTY allocation, so the output comes back to PowerShell rather than
# being swallowed by an interactive session that does not exist here.
Get-Content (Join-Path $PSScriptRoot 'check-data.sql') -Raw | `
    docker compose -f docker-compose.prod.yml exec -T `
        -e PGPASSWORD=$password db `
        psql -U postgres -d emil -f -

if ($LASTEXITCODE -ne 0) {
    Die "The check did not finish. The output above says why."
}
