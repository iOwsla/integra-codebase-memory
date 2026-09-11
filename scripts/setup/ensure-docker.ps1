#Requires -Version 5.1
param([switch]$PrepareWsl)
$ErrorActionPreference = 'Stop'
if ($PrepareWsl) {
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart | Out-Null
    }
    & wsl.exe --install --web-download --no-distribution
    if ($LASTEXITCODE -notin @(0, 3010)) { throw 'WSL installation failed. Review the Windows error above.' }
    & bcdedit.exe /set hypervisorlaunchtype auto
    if ($LASTEXITCODE -ne 0) { throw 'Unable to enable hypervisor startup.' }
    exit 3010
}
$wslReady = $false
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    $version = (& wsl.exe --version 2>$null | Out-String) -replace "`0", ''
    if ($version -match '(\d+\.\d+\.\d+)(?:\.\d+)?') {
        if ([version]$Matches[1] -ge [version]'2.1.5') {
            & wsl.exe --status | Out-Null
            $wslReady = $LASTEXITCODE -eq 0
        }
    }
}
if (-not $wslReady) {
    Write-Output 'Preparing WSL without Ubuntu. Windows will request administrator permission.'
    $child = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-PrepareWsl')
    if ($child.ExitCode -eq 3010) { throw 'RESTART_REQUIRED: Save your work, restart Windows, then rerun the same CodeMemory installer. No project configuration has been written.' }
    throw 'WSL preparation did not complete. Resolve its Windows error, restart if requested, then rerun.'
}
$desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$userDesktop = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'
if (Test-Path -LiteralPath $userDesktop) { $desktop = $userDesktop }
if (-not (Test-Path -LiteralPath $desktop)) {
    $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')
    if ($architecture -ne 'AMD64') { throw 'Automatic Docker Desktop installation currently requires Windows x64.' }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('codememory-docker-' + [guid]::NewGuid().ToString('N') + '.exe')
    try {
        Invoke-WebRequest -UseBasicParsing -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $temporary
        $signature = Get-AuthenticodeSignature -LiteralPath $temporary
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Docker Inc') { throw 'Docker installer signature verification failed.' }
        # Keep the vendor installer interactive for its license and UAC prompts.
        $child = Start-Process -FilePath $temporary -Wait -PassThru -ArgumentList @('install', '--backend=wsl-2')
        if ($child.ExitCode -eq 3010) { throw 'RESTART_REQUIRED: Restart Windows and rerun the CodeMemory installer.' }
        if ($child.ExitCode -ne 0) { throw "Docker Desktop installer failed (exit $($child.ExitCode))." }
        if (Test-Path -LiteralPath $userDesktop) { $desktop = $userDesktop }
    } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
Start-Process -FilePath $desktop
Write-Output 'Complete Docker Desktop first-run prompts if displayed. Waiting for its Linux engine...'
