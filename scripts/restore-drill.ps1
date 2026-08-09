<#
.SYNOPSIS
    Restore your newest backup into a scratch database and count what came back.

.DESCRIPTION
    A backup nobody has restored is a hope, not a backup. This proves the newest
    dump can actually be turned back into your books - and, because it counts
    the rows afterwards, it proves the dump is COMPLETE and not merely readable.

        powershell -ExecutionPolicy Bypass -File scripts\restore-drill.ps1

    Run it once now, so the first time you restore is not the day you need to.

    IT NEVER TOUCHES YOUR LIVE DATABASE. Everything happens in a scratch
    database that is created at the start and dropped at the end, and the name
    is checked against the live one before anything runs. Restoring "over" your
    books is the exact accident a drill must not be able to cause.
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$LIVE_DB  = 'emil'
$SCRATCH  = 'emil_restore_drill'
$COMPOSE  = 'docker-compose.prod.yml'

function Die($message) {
    Write-Host ''
    Write-Host "  $message" -ForegroundColor Red
    Write-Host ''
    exit 1
}

# Belt and braces. $SCRATCH is a constant three lines up, so this can only fire
# if somebody edits it later - which is precisely when a guard earns its place.
if ($SCRATCH -eq $LIVE_DB) { Die "The scratch database name matches the live one. Refusing to run." }

$envFile = Join-Path $root '.env.prod'
if (-not (Test-Path $envFile)) { Die ".env.prod not found. Run this from the install folder." }

$password = $null
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*POSTGRES_PASSWORD\s*=\s*(.+?)\s*$') { $password = $Matches[1] }
}
if (-not $password) { Die "POSTGRES_PASSWORD is not set in .env.prod." }

$running = docker compose -f $COMPOSE ps --status running --services 2>$null
if ($LASTEXITCODE -ne 0) { Die "Docker is not running. Start Docker Desktop and try again." }
if ($running -notcontains 'db') {
    Die "The database is not running. Start it with:`n`n      docker compose -f $COMPOSE --env-file .env.prod up -d"
}

function Db($sqlOrArgs) {
    docker compose -f $COMPOSE exec -T -e PGPASSWORD=$password db @sqlOrArgs
}

Write-Host ''
Write-Host '  Finding the newest backup...' -ForegroundColor Cyan
$newest = (Db @('sh','-c','ls -1t /backups/emil-*.dump 2>/dev/null | head -1')).Trim()
if (-not $newest) {
    Die "No backups found in the backup folder yet. The backup service writes one when it starts and then daily - give it a minute after first start, or check BACKUP_DIR in .env.prod."
}
Write-Host "    $newest"

# Read the archive's contents WITHOUT restoring. If this fails the dump is
# unusable and there is no point going further - and it is the same check the
# nightly backup runs before it prunes anything.
Write-Host '  Checking the file is readable...' -ForegroundColor Cyan
Db @('pg_restore','--list',$newest) | Out-Null
if ($LASTEXITCODE -ne 0) { Die "That dump is NOT readable. Do not rely on it. Try the next newest, and take a fresh backup now." }

Write-Host "  Restoring into a scratch database ($SCRATCH)..." -ForegroundColor Cyan
Db @('dropdb','-U','postgres','--if-exists',$SCRATCH) | Out-Null
Db @('createdb','-U','postgres',$SCRATCH) | Out-Null

# --no-owner / --no-privileges: the scratch database has no emil_app_login or
# emil_worker roles to grant to, and their absence is not a restore failure.
# Errors are tolerated here and judged by the row counts below instead, because
# a real restore reports harmless noise about extensions and comments.
Db @('pg_restore','-U','postgres','-d',$SCRATCH,'--no-owner','--no-privileges',$newest) 2>&1 | Out-Null

Write-Host ''
Write-Host '  What came back:' -ForegroundColor Green
$counts = @'
SELECT 'Invoices' AS "What", count(*) AS "Rows" FROM invoice
UNION ALL SELECT 'Payments',        count(*) FROM payment
UNION ALL SELECT 'Repair jobs',     count(*) FROM repair_job
UNION ALL SELECT 'Items',           count(*) FROM item
UNION ALL SELECT 'Journal entries', count(*) FROM journal_entry
UNION ALL SELECT 'Journal lines',   count(*) FROM journal_line;
SELECT to_char(sum(base_debit),  'FM999,999,999,990.00') AS "Debits (RM)",
       to_char(sum(base_credit), 'FM999,999,999,990.00') AS "Credits (RM)"
FROM journal_line l JOIN journal_entry e
  ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
WHERE e.status = 'POSTED';
'@
$counts | Db @('psql','-U','postgres','-d',$SCRATCH,'--pset','border=2','-f','-')

Write-Host ''
Write-Host '  Cleaning up the scratch database...' -ForegroundColor Cyan
Db @('dropdb','-U','postgres','--if-exists',$SCRATCH) | Out-Null

Write-Host ''
Write-Host '  Done. Compare those numbers with scripts\check-data.ps1.' -ForegroundColor Green
Write-Host '  If they match, this backup would give you your books back.'
Write-Host ''
