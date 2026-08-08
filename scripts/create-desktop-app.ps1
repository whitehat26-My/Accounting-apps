<#
    Put a real app icon on the shop PC.

        cd C:\shahgtech
        powershell -ExecutionPolicy Bypass -File scripts\create-desktop-app.ps1

    Afterwards there is a "Shah G Tech" icon on the desktop and in the Start
    menu. Double-click it and the books open in their OWN WINDOW - no browser,
    no tabs, no address bar. It is the same system that is already running on
    this PC; this only gives it a front door that looks like every other
    program on the machine.

    This is a convenience. The same result comes from opening Edge, going to
    http://localhost:8080, and choosing "Install this site as an app" from the
    ... menu - and that route also registers it in Windows' Installed Apps and
    uses your logo as the icon. Either is fine. Use whichever you like.

    Nothing here touches the running system, the database, or .env.prod. It
    only creates shortcuts, so it is safe to run as often as you want.
#>

$ErrorActionPreference = 'Stop'

function Say  ($m) { Write-Host $m }
function Good ($m) { Write-Host "  OK    $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  NOTE  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host ''; Write-Host "  STOP  $m" -ForegroundColor Red; Write-Host ''; exit 1 }

Say ''
Say '  Making a desktop app icon for the shop system'
Say ''

# ---------------------------------------------------------------------------
# The address is localhost, not the LAN number.
#
# On THIS PC the system is reached at localhost - which is also the only
# address the browser treats as trusted, so the "install as an app" machinery
# and the secure browser features both work here and would not over the LAN
# number. The phones use the LAN number; this PC uses localhost.
# ---------------------------------------------------------------------------
$port = 8080
if (Test-Path '.env.prod') {
    $hit = Select-String -Path '.env.prod' -Pattern '^WEB_PORT=(\d+)' | Select-Object -First 1
    if ($hit) { $port = $hit.Matches[0].Groups[1].Value }
}
$url = "http://localhost:$port"

# ---------------------------------------------------------------------------
# The window is a chromeless browser window: `--app=URL` opens the page with
# no tabs and no address bar, its own taskbar button, its own icon. Edge is on
# every Windows 10 and 11; Chrome is used if it is there and Edge somehow is
# not. Both understand the same flag.
# ---------------------------------------------------------------------------
$browsers = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
    Die 'No Microsoft Edge or Google Chrome found. Edge ships with Windows - if it is missing, open the books at http://localhost:8080 in whatever browser you have.'
}

# ---------------------------------------------------------------------------
# The icon. Turn the shop's logo into a .ico if it is there; if anything about
# that fails, fall through to the browser's own icon rather than stopping - a
# working shortcut with a plain icon beats no shortcut.
# ---------------------------------------------------------------------------
$iconPath = $browser
$mark = 'apps\web\public\brand\mark.png'
if (Test-Path $mark) {
    try {
        Add-Type -AssemblyName System.Drawing
        $ico = Join-Path $env:LOCALAPPDATA 'shahgtech-app.ico'
        $png = [System.Drawing.Bitmap]::FromFile((Resolve-Path $mark))
        $handle = $png.GetHicon()
        $icon = [System.Drawing.Icon]::FromHandle($handle)
        $stream = [System.IO.File]::Create($ico)
        try { $icon.Save($stream) } finally { $stream.Close() }
        $icon.Dispose(); $png.Dispose()
        $iconPath = $ico
        Good 'Used your logo as the icon'
    } catch {
        Warn 'Could not turn the logo into an icon; using the browser icon instead.'
    }
}

# ---------------------------------------------------------------------------
# Write the shortcut to the Desktop and the Start menu.
# ---------------------------------------------------------------------------
$name = 'Shah G Tech'
if (Test-Path '.env.prod') {
    $hit = Select-String -Path '.env.prod' -Pattern '^NEXT_PUBLIC_APP_NAME=(.+)$' | Select-Object -First 1
    # The part before a dash - the shop's name, not the whole tagline.
    if ($hit) { $name = ($hit.Matches[0].Groups[1].Value -split '\s+[-\u2013\u2014]\s+')[0].Trim() }
}

$shell = New-Object -ComObject WScript.Shell
$targets = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($dir in $targets) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "$name.lnk"))
    $lnk.TargetPath = $browser
    $lnk.Arguments = "--app=$url"
    $lnk.IconLocation = $iconPath
    $lnk.Description = "$name - shop system"
    $lnk.Save()
}

Say ''
Good "Created '$name' on the desktop and in the Start menu."
Say ''
Say "  Double-click it. It opens $url in its own window - no browser around it."
Say '  The background engine (Docker) must be running for it to open, which it'
Say '  already is, and which it will be after every restart if you ticked'
Say "  'Start Docker Desktop when you log in' during setup."
Say ''
