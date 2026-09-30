# Dentiva Pro — clean-machine installation check (Windows CI).
#
# One script, one transcript: it builds the real installer, installs it silently
# on a machine that has never seen the application, checks everything a clinic
# would notice (executable, shortcuts, uninstall entry), runs the installed
# application's own self-check against both the default data folder and a
# relocated one, then uninstalls and proves the clinic's records survived.
#
# Two things are written for the pipeline:
#   * every line goes to the transcript, which the workflow captures;
#   * on success an evidence summary is printed as a `::notice::` annotation, and
#     on failure a compact `=== FAILURE ===` block is, so the reason is readable
#     without opening the raw log (which is dominated by bundler output).
#
# Usage:  pwsh -File tools/ci/windows-check.ps1 [-SkipBuild]

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$releaseDir = Join-Path $repoRoot 'release'
$resultsDir = Join-Path $repoRoot 'test-results'
$buildLog = Join-Path $resultsDir 'windows-build.log'
$transcriptFile = Join-Path $resultsDir 'windows-check-transcript.txt'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Dentiva Pro'
$appExe = Join-Path $installDir 'Dentiva Pro.exe'
$uninstaller = Join-Path $installDir 'Uninstall Dentiva Pro.exe'
$startMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Dentiva Pro.lnk'
$desktopShortcut = Join-Path $env:USERPROFILE 'Desktop\Dentiva Pro.lnk'
$defaultDataDir = Join-Path $env:APPDATA 'Dentiva Pro'
$relocatedDataDir = Join-Path $env:RUNNER_TEMP 'dentiva-relocated-data'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

$transcript = [System.Collections.Generic.List[string]]::new()
$evidence = [System.Collections.Generic.List[string]]::new()

function Write-Log {
    param([string]$Line = '')
    $transcript.Add($Line)
    Write-Host $Line
}

function Write-Evidence {
    param([string]$Line)
    $evidence.Add($Line)
    Write-Log $Line
}

function Assert-Truthy {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
    Write-Log "  ok: $Message"
}

# The Uninstall key itself may be absent on a machine that has never installed a
# per-user application, which is exactly the machine this script runs on.
function Get-UninstallEntry {
    if (-not (Test-Path $uninstallRoot)) { return $null }
    Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object { $_.DisplayName -like 'Dentiva Pro*' } |
        Select-Object -First 1
}

function Invoke-SelfCheck {
    param([string]$Label, [string]$DataDir)

    $reportFile = Join-Path $env:RUNNER_TEMP "self-check-$Label.json"
    if ($DataDir) { $env:DENTIVA_DATA_DIR = $DataDir } else { Remove-Item Env:\DENTIVA_DATA_DIR -ErrorAction SilentlyContinue }

    & $appExe --self-check > $reportFile 2>&1
    $exitCode = $LASTEXITCODE
    $raw = Get-Content $reportFile -Raw
    Write-Log $raw
    if (-not $raw) { throw "The $Label self-check printed nothing." }

    $json = $raw | ConvertFrom-Json
    Assert-Truthy ($exitCode -eq 0) "the $Label self-check exited 0 (got $exitCode)"
    Assert-Truthy ($json.ok -eq $true) "the $Label self-check reports ok"
    Assert-Truthy ($json.packaged -eq $true) "the $Label self-check reports a packaged build"
    Assert-Truthy ($json.databaseOk -eq $true) "the $Label self-check opened the database"
    Assert-Truthy ($json.integrityOk -eq $true) "the $Label self-check passed the integrity check"
    Assert-Truthy ($json.foreignKeyViolations -eq 0) "the $Label self-check found no foreign-key violations"

    Write-Evidence "self-check ($Label): state=$($json.state) licence=$($json.licenceActivated) schema=$($json.schemaVersion) database=$($json.databaseFile)"
    return $json
}

function Show-LogTail {
    param([string]$Path, [int]$Lines = 30)
    if (-not (Test-Path $Path)) { return }
    Write-Log "  --- $Path (last $Lines lines) ---"
    foreach ($line in (Get-Content $Path | Select-Object -Last $Lines)) { Write-Log "  $line" }
}

try {
    Write-Log '=== Dentiva Pro — clean-machine installation check ==='
    Write-Log "Runner: $([System.Environment]::OSVersion.VersionString) · PowerShell $($PSVersionTable.PSVersion)"
    Write-Log "Install target: $installDir"

    # -----------------------------------------------------------------------
    # 1. Build the real artifacts
    # -----------------------------------------------------------------------
    if (-not $SkipBuild) {
        Write-Log ''
        Write-Log '--- 1. Building the installer and the portable executable'
        & npm.cmd run dist:all *> $buildLog
        if ($LASTEXITCODE -ne 0) {
            Show-LogTail -Path $buildLog -Lines 40
            throw "npm run dist:all failed with exit code $LASTEXITCODE (full output: $buildLog)."
        }
        Write-Log "  build log: $buildLog ($((Get-Content $buildLog | Measure-Object).Count) lines)"
    }

    $installer = Get-ChildItem $releaseDir -Filter '*Setup.exe' | Select-Object -First 1
    $portable = Get-ChildItem $releaseDir -Filter '*Portable.exe' | Select-Object -First 1
    if (-not $installer) { throw "No installer was produced in $releaseDir." }
    if (-not $portable) { throw "No portable executable was produced in $releaseDir." }

    Write-Evidence "installer: $($installer.Name) ($([math]::Round($installer.Length / 1MB, 2)) MB)"
    Write-Evidence "portable:  $($portable.Name) ($([math]::Round($portable.Length / 1MB, 2)) MB)"

    # -----------------------------------------------------------------------
    # 2. A clean machine: nothing installed, nothing configured
    # -----------------------------------------------------------------------
    Write-Log ''
    Write-Log '--- 2. Silent installation on a clean machine'
    Assert-Truthy (-not (Test-Path $installDir)) "nothing is installed at $installDir before the test"
    Assert-Truthy ($null -eq (Get-UninstallEntry)) 'no Dentiva Pro uninstall entry exists before the test'

    Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait

    # A silent install must not leave a first-run window in the way of the checks.
    Get-Process -Name 'Dentiva Pro' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2

    Assert-Truthy (Test-Path $appExe) 'the application executable was installed'
    Assert-Truthy (Test-Path $uninstaller) 'the uninstaller was installed'

    # -----------------------------------------------------------------------
    # 3. What the user sees
    # -----------------------------------------------------------------------
    Write-Log ''
    Write-Log '--- 3. Shortcuts, uninstall entry and packaging'
    $shell = New-Object -ComObject WScript.Shell

    Assert-Truthy (Test-Path $startMenuShortcut) 'the Start Menu shortcut was created'
    $startMenuTarget = $shell.CreateShortcut($startMenuShortcut).TargetPath
    Assert-Truthy ($startMenuTarget -like '*Dentiva Pro.exe') "the Start Menu shortcut points at the application ($startMenuTarget)"
    Write-Evidence "start menu shortcut -> $startMenuTarget"

    Assert-Truthy (Test-Path $desktopShortcut) 'the desktop shortcut was created'
    $desktopTarget = $shell.CreateShortcut($desktopShortcut).TargetPath
    Assert-Truthy ($desktopTarget -like '*Dentiva Pro.exe') 'the desktop shortcut points at the application'
    Write-Evidence "desktop shortcut  -> $desktopTarget"

    $entry = Get-UninstallEntry
    Assert-Truthy ($null -ne $entry) 'the uninstall entry is registered in HKCU'
    Assert-Truthy ($entry.DisplayVersion -eq '1.0.0') "the uninstall entry reports version 1.0.0 (found $($entry.DisplayVersion))"
    Assert-Truthy ($entry.Publisher -like '*Shohan Khan*') "the uninstall entry names the publisher (found $($entry.Publisher))"
    Write-Evidence "uninstall entry: $($entry.DisplayName) · $($entry.DisplayVersion) · $($entry.Publisher)"

    $licenceFiles = Join-Path $repoRoot 'build\licenses\OPEN-SOURCE-LICENCES.txt'
    Assert-Truthy (Test-Path $licenceFiles) 'the licence bundle was generated for the packaged build'
    $packagedNotices = Join-Path $releaseDir 'win-unpacked\resources\THIRD-PARTY-NOTICES.txt'
    Assert-Truthy (Test-Path $packagedNotices) 'the third-party notices were copied into the packaged resources'

    # -----------------------------------------------------------------------
    # 4. The installed application opens its own database
    # -----------------------------------------------------------------------
    Write-Log ''
    Write-Log '--- 4. The installed application self-check'
    $default = Invoke-SelfCheck -Label 'default' -DataDir ''
    Assert-Truthy ($default.databaseFile -like "*$defaultDataDir*") "the database lives in the clinic data folder ($($default.databaseFile))"

    $relocated = Invoke-SelfCheck -Label 'relocated' -DataDir $relocatedDataDir
    Assert-Truthy ($relocated.databaseFile -like '*dentiva-relocated-data*') 'DENTIVA_DATA_DIR relocates the whole data folder'
    Remove-Item Env:\DENTIVA_DATA_DIR -ErrorAction SilentlyContinue

    # -----------------------------------------------------------------------
    # 5. Uninstall: the application goes, the clinic's records stay
    # -----------------------------------------------------------------------
    Write-Log ''
    Write-Log '--- 5. Uninstall keeps the clinic data'
    $marker = Join-Path $defaultDataDir 'KEEP-ME-AFTER-UNINSTALL.txt'
    $database = Join-Path $defaultDataDir 'data\dentiva.sqlite'
    Set-Content -Path $marker -Value 'clinic records must survive an uninstall' -Encoding utf8
    Assert-Truthy (Test-Path $database) "the clinic database exists at $database"

    Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait

    $deadline = (Get-Date).AddSeconds(90)
    while ((Test-Path $appExe) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
    Assert-Truthy (-not (Test-Path $appExe)) 'the uninstaller removed the application executable'
    Assert-Truthy (-not (Test-Path $uninstaller)) 'the uninstaller removed its own files'
    Assert-Truthy (Test-Path $marker) 'the clinic data folder survived the uninstall'
    Assert-Truthy (Test-Path $database) 'the clinic database survived the uninstall'
    Assert-Truthy ($null -eq (Get-UninstallEntry)) 'the uninstall entry was removed'
    Write-Evidence "data after uninstall: $((Get-ChildItem $defaultDataDir -Recurse -File | Measure-Object).Count) files kept in $defaultDataDir"

    # -----------------------------------------------------------------------
    # 6. Evidence for the job annotation and the test report
    # -----------------------------------------------------------------------
    $summaryText = (@('Dentiva Pro 1.0.0 — Windows installer verified on a clean machine') + $evidence) -join "`n"
    Write-Log ''
    Write-Log '=== Evidence ==='
    Write-Log $summaryText
    Set-Content -Path (Join-Path $resultsDir 'windows-install-evidence.txt') -Value $summaryText -Encoding utf8

    $escaped = ($summaryText -split "`r?`n" | ForEach-Object { $_.Replace('%', '%25') }) -join '%0A'
    Write-Host "::notice title=Dentiva Pro installer evidence::$escaped"

    Write-Log ''
    Write-Log 'PASS: the installer, the shortcuts, the uninstall entry, the self-check and the data-preservation policy all behave as documented.'
} catch {
    $tail = @($transcript | Select-Object -Last 20)
    Write-Log ''
    Write-Log '=== FAILURE ==='
    Write-Log $_.Exception.Message
    Write-Log '--- the last lines before the failure ---'
    foreach ($line in $tail) { Write-Log $line }
    Set-Content -Path $transcriptFile -Value ($transcript -join "`n") -Encoding utf8
    exit 1
}

Set-Content -Path $transcriptFile -Value ($transcript -join "`n") -Encoding utf8
