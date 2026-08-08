<#
    First-time install on a shop PC. Run it from the folder this file is in:

        cd C:\shahgtech
        powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

    It does what STEP 3 to STEP 5 of the setup guide do by hand: writes the
    secrets file, asks the two questions the app cannot answer for itself, and
    starts everything. The guide is still worth reading — this only removes the
    typing, not the understanding.

    SAFE TO RUN TWICE. It never overwrites an existing .env.prod, because that
    file holds the only copy of the database passwords: replacing it would leave
    a running database nobody can log into, including you. If it exists, the
    script uses it as-is and says so.

    Linux or macOS: no script, because there is nothing to smooth over — the
    same three commands work directly, and `docs/DEPLOY.md` lists them.
#>

$ErrorActionPreference = 'Stop'

function Say  ($m) { Write-Host $m }
function Good ($m) { Write-Host "  OK    $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  NOTE  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host ''; Write-Host "  STOP  $m" -ForegroundColor Red; Write-Host ''; exit 1 }

Say ''
Say '================================================================'
Say '  Installing the shop system'
Say '================================================================'
Say ''

# ---------------------------------------------------------------------------
# 1. The things that must already be true.
# ---------------------------------------------------------------------------
if (-not (Test-Path 'docker-compose.prod.yml')) {
    Die @'
This is not the app folder.

Open PowerShell, change into the folder you cloned the project into, and run
the script again from there. For example:

    cd C:\shahgtech
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
'@
}

try { docker version --format '{{.Server.Version}}' | Out-Null }
catch {
    Die @'
Docker is not running.

Open Docker Desktop and wait until it says "Engine running" at the bottom
left, then run this script again. If Docker Desktop is not installed, install
it first - Step 1 of the setup guide.
'@
}
Good 'Docker is running'

# ---------------------------------------------------------------------------
# 2. The secrets file. Written once, never rewritten.
# ---------------------------------------------------------------------------
$envFile = '.env.prod'

if (Test-Path $envFile) {
    Warn "$envFile already exists - keeping it, and using the values already in it."
    Warn 'Nothing in this script will change your passwords.'
    $keepExisting = $true
} else {
    $keepExisting = $false

    # A password nobody will ever type, so length matters and memorability does
    # not. Cryptographic, not `Get-Random`, which is seeded well enough for
    # shuffling a playlist and not for the key to somebody's books.
    #
    # RNGCryptoServiceProvider rather than the tidier RandomNumberGenerator.Fill:
    # Windows ships PowerShell 5.1 on .NET Framework, where Fill does not exist.
    # A shop PC has 5.1 unless somebody deliberately installed 7, so the older
    # call is the one that runs everywhere this script will actually be run.
    function New-Secret {
        $bytes = New-Object 'byte[]' 30
        $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        # `+/=` are punctuation that docker compose and .env parsing both have
        # opinions about. Dropping them costs a little entropy per character and
        # buys a value that cannot break the file it lives in.
        return ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x')
    }

    Say ''
    Say '  Two questions, then it runs on its own.'
    Say ''

    # -----------------------------------------------------------------------
    # The address staff phones will use. Offered, not assumed: a PC can have
    # several addresses (WiFi, cable, Docker's own virtual ones) and only the
    # person standing in the shop knows which network the phones are on.
    # -----------------------------------------------------------------------
    $candidates = @(
        Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object {
                $_.IPAddress -notlike '127.*' -and
                $_.IPAddress -notlike '169.254.*' -and
                $_.InterfaceAlias -notlike '*WSL*' -and
                $_.InterfaceAlias -notlike '*Loopback*' -and
                $_.InterfaceAlias -notlike '*Docker*'
            } |
            Select-Object -ExpandProperty IPAddress
    )

    $suggested = if ($candidates.Count -gt 0) { $candidates[0] } else { '' }

    Say '  1. This PC''s address on the shop network.'
    Say '     Staff phones will use it, and it is printed as a QR code on every'
    Say '     receipt and warranty card - so it must be the one they can reach.'
    if ($candidates.Count -gt 1) {
        Say "     Addresses found on this PC: $($candidates -join ', ')"
    }
    Say ''
    $addr = Read-Host "     Address [$suggested]"
    if ([string]::IsNullOrWhiteSpace($addr)) { $addr = $suggested }
    if ([string]::IsNullOrWhiteSpace($addr)) {
        Die 'No address given, and none could be detected. Run ipconfig, note the IPv4 Address, and run this again.'
    }

    # -----------------------------------------------------------------------
    # The name on the sign-in page. Not the tenant's name - that comes from
    # their own record after they sign in - but this installation's.
    # -----------------------------------------------------------------------
    Say ''
    Say '  2. Your business name, as it should appear on the sign-in screen.'
    $shop = Read-Host '     Name [Emil Books]'
    if ([string]::IsNullOrWhiteSpace($shop)) { $shop = 'Emil Books' }

    $port = 8080
    $baseUrl = "http://${addr}:${port}"

    @"
# Written by scripts\install-windows.ps1. Keep this file, and keep it private:
# it is the key to your books. Copy it somewhere that is NOT this PC - a
# password manager, or printed in the safe. If the PC dies and you have the
# backups but not this file, restoring is far harder.

POSTGRES_PASSWORD=$(New-Secret)
EMIL_APP_PASSWORD=$(New-Secret)
EMIL_WORKER_PASSWORD=$(New-Secret)
JWT_SECRET=$(New-Secret)

WEB_PORT=$port

# Printed as a QR code on every document. Change it and rebuild if this PC's
# address ever changes - paper already handed over keeps the old address.
PUBLIC_BASE_URL=$baseUrl

# The name on the sign-in page and the browser tab.
NEXT_PUBLIC_APP_NAME=$shop
"@ | Set-Content -Path $envFile -Encoding UTF8

    Good "Wrote $envFile with four fresh passwords"
    Good "Address: $baseUrl"
    Good "Name:    $shop"
}

# ---------------------------------------------------------------------------
# 3. Build and start. `--build` is not optional: the name and the logo are
#    compiled into the pages, so a plain `up -d` would quietly keep the old
#    ones and the operator would have no way of knowing why.
# ---------------------------------------------------------------------------
Say ''
Say '  Building and starting. First time takes 10-20 minutes - it is'
Say '  downloading PostgreSQL and building three programs. Leave it be.'
Say ''

docker compose -f docker-compose.prod.yml --env-file $envFile up -d --build
if ($LASTEXITCODE -ne 0) {
    Die 'The build failed. The output above says why - send it to whoever set this up.'
}

# ---------------------------------------------------------------------------
# 4. Wait for it to actually answer, rather than declaring success at the
#    moment the containers were created. `up -d` returns as soon as they start,
#    which is well before the database has finished migrating.
# ---------------------------------------------------------------------------
#
# Read back from the file rather than from the variables above, because on a
# re-run those variables were never set — the existing .env.prod is the only
# source of truth for what this installation is actually using.
#
function Read-Setting ($name, $fallback) {
    $hit = Select-String -Path $envFile -Pattern "^$name=(.+)$" | Select-Object -First 1
    if ($hit) { return $hit.Matches[0].Groups[1].Value.Trim() }
    return $fallback
}

$webPort = Read-Setting 'WEB_PORT' '8080'
$url = "http://127.0.0.1:$webPort/login"

Say ''
Say '  Waiting for it to come up...'
$ready = $false
foreach ($i in 1..90) {
    try {
        if ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        # Still starting. Migrations run before the API listens, so the first
        # thirty seconds of refusals are expected rather than a problem.
    }
    Start-Sleep -Seconds 2
}

Say ''
if (-not $ready) {
    Warn 'It has not answered yet. That is not necessarily wrong on a slow PC.'
    Warn 'Check what the parts are doing with:'
    Say  ''
    Say  '    docker compose -f docker-compose.prod.yml --env-file .env.prod ps'
    Say  '    docker compose -f docker-compose.prod.yml --env-file .env.prod logs api'
    Say  ''
    exit 1
}

$publicUrl = Read-Setting 'PUBLIC_BASE_URL' $url

Good 'It is running.'
Say ''
Say '================================================================'
Say '  Next, in this order'
Say '================================================================'
Say ''
Say "  1. Open $url on this PC and REGISTER YOUR ACCOUNT NOW."
Say '     The first account on an empty system is let through without an'
Say '     invitation code. That window is the one moment somebody else could'
Say '     take it. Do it before anything else.'
Say ''
Say '  2. Let the phones through the firewall. Open PowerShell AS'
Say '     ADMINISTRATOR (right-click PowerShell, "Run as administrator"):'
Say ''
Say ('         New-NetFirewallRule -DisplayName "Shop books" -Direction Inbound ' +
     "-LocalPort $webPort -Protocol TCP -Action Allow")
Say ''
Say "  3. On each phone, on the shop WiFi, open $publicUrl"
Say '     then add it to the home screen. It opens full screen, like an app.'
Say ''
Say '  4. Fix this PC''s address in your router (DHCP reservation), or it will'
Say '     change one day and every phone will stop working at once.'
Say ''
Say '  5. Read part 2 of the setup guide, about backups. An accounting system'
Say '     without backups you have actually restored once is a liability.'
Say ''
if ($keepExisting) {
    Warn 'Used your existing .env.prod. If the sign-in page shows the wrong name,'
    Warn 'edit NEXT_PUBLIC_APP_NAME in that file and run this script again.'
    Say ''
}
