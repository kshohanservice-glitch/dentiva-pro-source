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

# The application is a GUI-subsystem executable, and PowerShell's call operator does
# not wait for those: `& $appExe --self-check` returns immediately and the check then
# looks for a report that has not been written yet. Start-Process -Wait is the only
# reliable way to run it and read its exit code.
function Invoke-DentivaExecutable {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StdOut,
        [Parameter(Mandatory = $true)][string]$StdErr
    )
    Remove-Item $StdOut, $StdErr -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $appExe -ArgumentList $Arguments -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr
    return $process.ExitCode
}

# `-Condition` is deliberately [object], not [bool]: PowerShell refuses to bind a
# string to a [bool] parameter ("Cannot convert value "System.String" to type
# "System.Boolean""), and one of the checks below asserts that a message *exists*.
# The rule is the PowerShell one — null, $false and the empty string are false,
# anything else is true — and it is spelled out here so no check can be swallowed
# by a conversion error.
function Assert-Truthy {
    param([object]$Condition, [string]$Message)
    $passed = if ($null -eq $Condition) { $false }
    elseif ($Condition -is [bool]) { $Condition }
    else { -not [string]::IsNullOrWhiteSpace([string]$Condition) }
    if (-not $passed) { throw $Message }
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

    # A packaged Windows build is a GUI-subsystem executable, so its standard output
    # is not guaranteed to reach the caller. The report is therefore also written to
    # a file; the stdout capture is read as a fallback and reported as evidence.
    $reportFile = Join-Path $env:RUNNER_TEMP "self-check-$Label.json"
    $stdoutFile = Join-Path $env:RUNNER_TEMP "self-check-$Label.stdout.txt"
    Remove-Item $reportFile, $stdoutFile -ErrorAction SilentlyContinue
    if ($DataDir) { $env:DENTIVA_DATA_DIR = $DataDir } else { Remove-Item Env:\DENTIVA_DATA_DIR -ErrorAction SilentlyContinue }
    # The environment variable is the form the pipeline depends on; the command-line
    # flag is passed as well so both paths are exercised.
    $env:DENTIVA_SELF_CHECK_FILE = $reportFile
    # Ask the application to record what it was started with, so a silent launch is
    # never a mystery.
    $env:DENTIVA_LAUNCH_TRACE = '1'

    $stderrFile = Join-Path $env:RUNNER_TEMP "self-check-$Label.stderr.txt"
    # The path is quoted because Start-Process joins the argument list with spaces and
    # a temporary folder may well contain one.
    $exitCode = Invoke-DentivaExecutable -Arguments @('--self-check', "--self-check-file=`"$reportFile`"") -StdOut $stdoutFile -StdErr $stderrFile
    $onStdout = if ((Test-Path $stdoutFile) -and (Get-Content $stdoutFile -Raw)) { 'yes' } else { 'no' }
    $raw = if (Test-Path $reportFile) { Get-Content $reportFile -Raw } else { '' }
    if (-not $raw -and $onStdout -eq 'yes') { $raw = Get-Content $stdoutFile -Raw }
    # The application always keeps a copy beside its own logs.
    $logCopy = Join-Path (Join-Path $env:APPDATA 'Dentiva Pro') 'logs\self-check.json'
    if (-not $raw -and (Test-Path $logCopy)) { $raw = Get-Content $logCopy -Raw }
    Write-Log "  report on stdout: $onStdout · report file: $(Split-Path $reportFile -Leaf)"
    Write-Log $raw
    if (-not $raw) {
      # Does the self-check branch run at all? A data folder whose parent is a file
      # must make it fail, so an exit code of 0 here means neither the flag nor the
      # environment variable reached the application.
      $probeParent = Join-Path $env:RUNNER_TEMP 'dentiva-probe'
      Set-Content -Path $probeParent -Value 'not a folder' -Encoding utf8
      $env:DENTIVA_DATA_DIR = Join-Path $probeParent 'data'
      $probeStdout = Join-Path $env:RUNNER_TEMP 'probe.stdout.txt'
      $probeStderr = Join-Path $env:RUNNER_TEMP 'probe.stderr.txt'
      $probeExit = Invoke-DentivaExecutable -Arguments @('--self-check') -StdOut $probeStdout -StdErr $probeStderr
      Remove-Item Env:\DENTIVA_DATA_DIR -ErrorAction SilentlyContinue
      Remove-Item $probeParent -ErrorAction SilentlyContinue

      $trace = Join-Path $env:TEMP 'dentiva-launch-trace.txt'
      if (Test-Path $trace) {
        Write-Log '  launch trace:'
        foreach ($line in Get-Content $trace) { Write-Log "    $line" }
      } else {
        Write-Log '  launch trace: not written (the main process did not run this far)'
      }
      if (Test-Path $logCopy) { Write-Log "  logs copy found after all: $logCopy" }

      $traceLine = if (Test-Path $trace) { (Get-Content $trace -Raw).Replace("`r`n", ' | ').Replace("`n", ' | ') } else { 'none' }
      throw ("The $Label self-check left no report (exit code $exitCode; probe with an unusable data folder " +
        "exited $probeExit where 1 means the self-check ran). Requested file written: $(Test-Path $reportFile); " +
        "logs copy written: $(Test-Path $logCopy); stdout: $(if ((Test-Path $stdoutFile) -and (Get-Content $stdoutFile -Raw)) { 'captured' } else { 'empty' }); " +
        "launch trace: $traceLine")
    }

    $json = $raw | ConvertFrom-Json
    Write-Evidence "self-check ($Label): state=$($json.state) licence=$($json.licenceActivated) schema=$($json.schemaVersion) database=$($json.databaseFile) stdout=$onStdout"
    return $json
}

function Assert-SelfCheckReport {
    param([string]$Label, [object]$Json, [int]$ExitCode, [bool]$ExpectedOk)

    if ($ExpectedOk) {
        Assert-Truthy ($ExitCode -eq 0) "the $Label self-check exited 0 (got $ExitCode)"
        Assert-Truthy ($Json.ok -eq $true) "the $Label self-check reports ok"
        Assert-Truthy ($Json.packaged -eq $true) "the $Label self-check reports a packaged build"
        Assert-Truthy ($Json.databaseOk -eq $true) "the $Label self-check opened the database"
        Assert-Truthy ($Json.integrityOk -eq $true) "the $Label self-check passed the integrity check"
        Assert-Truthy ($Json.foreignKeyViolations -eq 0) "the $Label self-check found no foreign-key violations"
    } else {
        Assert-Truthy ($ExitCode -eq 1) "the $Label self-check exited 1 (got $ExitCode)"
        Assert-Truthy ($Json.ok -eq $false) "the $Label self-check reports not-ok"
        Assert-Truthy (-not [string]::IsNullOrWhiteSpace($Json.error)) "the $Label self-check explains the failure ($($Json.error))"
    }
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

    # Exercise the NORMAL GUI entry point. Self-check deliberately bypasses bootstrap
    # and would not catch a premature session.defaultSession access.
    Write-Log '--- 3a. Normal installed GUI startup (no self-check flags)'
    Remove-Item Env:\DENTIVA_SELF_CHECK_FILE, Env:\DENTIVA_DATA_DIR -ErrorAction SilentlyContinue
    $gui = Start-Process -FilePath $appExe -PassThru
    try {
        $deadline = (Get-Date).AddSeconds(90)
        $windowReady = $false
        while ((Get-Date) -lt $deadline) {
            $gui.Refresh()
            if ($gui.HasExited) { throw "Normal GUI exited before opening a window (exit $($gui.ExitCode))." }
            if ($gui.MainWindowHandle -ne 0 -and $gui.MainWindowTitle -like '*Dentiva Pro*') {
                $windowReady = $true
                break
            }
            Start-Sleep -Seconds 2
        }
        Assert-Truthy $windowReady 'normal installed GUI opened a Dentiva Pro window within 90 seconds'
        Start-Sleep -Seconds 5
        $gui.Refresh()
        Assert-Truthy (-not $gui.HasExited) 'normal GUI remains alive after first launch (no app-ready/session crash)'
        Write-Evidence "normal GUI launch: window '$($gui.MainWindowTitle)', process alive after startup"
    } finally {
        if (-not $gui.HasExited) { Stop-Process -Id $gui.Id -Force -ErrorAction SilentlyContinue }
        $gui.WaitForExit(10000) | Out-Null
    }

    # -----------------------------------------------------------------------
    # 4. The installed application opens its own database
    # -----------------------------------------------------------------------
    Write-Log ''
    Write-Log '--- 4. The installed application self-check'
    $default = Invoke-SelfCheck -Label 'default' -DataDir ''
    Assert-SelfCheckReport -Label 'default' -Json $default -ExitCode 0 -ExpectedOk $true
    Assert-Truthy ($default.databaseFile -like "*$defaultDataDir*") "the database lives in the clinic data folder ($($default.databaseFile))"

    $relocated = Invoke-SelfCheck -Label 'relocated' -DataDir $relocatedDataDir
    Assert-SelfCheckReport -Label 'relocated' -Json $relocated -ExitCode 0 -ExpectedOk $true
    Assert-Truthy ($relocated.databaseFile -like '*dentiva-relocated-data*') 'DENTIVA_DATA_DIR relocates the whole data folder'

    # A broken installation must be reported, not crash: an unusable data folder
    # (its parent is a file) has to produce a readable report and exit 1.
    $blockedParent = Join-Path $env:RUNNER_TEMP 'dentiva-blocked'
    Set-Content -Path $blockedParent -Value 'not a folder' -Encoding utf8
    $brokenReport = Join-Path $env:RUNNER_TEMP 'self-check-broken.json'
    $brokenStdout = Join-Path $env:RUNNER_TEMP 'self-check-broken.stdout.txt'
    Remove-Item $brokenReport, $brokenStdout -ErrorAction SilentlyContinue
    $env:DENTIVA_DATA_DIR = Join-Path $blockedParent 'data'
    $env:DENTIVA_SELF_CHECK_FILE = $brokenReport
    $brokenStderr = Join-Path $env:RUNNER_TEMP 'self-check-broken.stderr.txt'
    $brokenExit = Invoke-DentivaExecutable -Arguments @('--self-check') -StdOut $brokenStdout -StdErr $brokenStderr
    $brokenRaw = if (Test-Path $brokenReport) { Get-Content $brokenReport -Raw } elseif (Test-Path $brokenStdout) { Get-Content $brokenStdout -Raw } else { '' }
    if (-not $brokenRaw) { throw "The broken-installation self-check produced no report (exit code $brokenExit)." }
    $broken = $brokenRaw | ConvertFrom-Json
    Assert-SelfCheckReport -Label 'broken instalment' -Json $broken -ExitCode $brokenExit -ExpectedOk $false
    Write-Evidence "self-check (broken data folder) correctly reported ok=false"
    Remove-Item Env:\DENTIVA_DATA_DIR, Env:\DENTIVA_SELF_CHECK_FILE -ErrorAction SilentlyContinue
    Remove-Item $blockedParent -ErrorAction SilentlyContinue

    # -----------------------------------------------------------------------
    # 5. Uninstall: the application goes, the clinic's records stay
    # -----------------------------------------------------------------------
    Write-Log ''
    Write-Log '--- 5. Uninstall keeps the clinic data'
    $marker = Join-Path $defaultDataDir 'KEEP-ME-AFTER-UNINSTALL.txt'
    $database = Join-Path $defaultDataDir 'data\dentiva.sqlite'
    Set-Content -Path $marker -Value 'clinic records must survive an uninstall' -Encoding utf8
    Assert-Truthy (Test-Path $database) "the clinic database exists at $database"

    # Bounded, because a dialog nobody can dismiss would otherwise leave this step
    # running until the job times out hours later, which says nothing to a maintainer.
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
    if (-not $uninstallProcess.WaitForExit(180000)) {
        Stop-Process -Id $uninstallProcess.Id -Force -ErrorAction SilentlyContinue
        throw 'The uninstaller did not finish within three minutes; it may be waiting for a dialog that a silent uninstall must not show.'
    }

    # The uninstaller copies itself into a temporary folder and does the real work from
    # there, so the process above can exit while the files, the shortcuts and the
    # registry entry are still disappearing. Waiting for the result — not for the
    # process — is what a person sees after an uninstall, and it is the only way to
    # check it without failing for being faster than the uninstaller. (This assertion
    # did fail exactly once that way, with everything else already gone.)
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        $remaining = (Test-Path $appExe) -or (Test-Path $uninstaller) -or `
            (Test-Path $startMenuShortcut) -or (Test-Path $desktopShortcut) -or `
            ($null -ne (Get-UninstallEntry))
        if (-not $remaining) { break }
        Start-Sleep -Seconds 3
    }

    Assert-Truthy (-not (Test-Path $appExe)) 'the uninstaller removed the application executable'
    Assert-Truthy (-not (Test-Path $uninstaller)) 'the uninstaller removed its own files'
    Assert-Truthy (-not (Test-Path $startMenuShortcut)) 'the Start Menu shortcut was removed'
    Assert-Truthy (-not (Test-Path $desktopShortcut)) 'the desktop shortcut was removed'
    Assert-Truthy ($null -eq (Get-UninstallEntry)) 'the uninstall entry was removed'
    Assert-Truthy (Test-Path $marker) 'the clinic data folder survived the uninstall'
    Assert-Truthy (Test-Path $database) 'the clinic database survived the uninstall'
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
    # The annotation is size-limited, so the failure block is deliberately short: the
    # reason, then the handful of lines that led to it. The full transcript is
    # written next to it and uploaded with the artifacts.
    $tail = @($transcript | Select-Object -Last 8)
    Write-Log ''
    Write-Log '=== FAILURE ==='
    Write-Log $_.Exception.Message
    Write-Log '--- just before that ---'
    foreach ($line in $tail) { Write-Log $line }
    Set-Content -Path $transcriptFile -Value ($transcript -join "`n") -Encoding utf8
    exit 1
}

Set-Content -Path $transcriptFile -Value ($transcript -join "`n") -Encoding utf8
