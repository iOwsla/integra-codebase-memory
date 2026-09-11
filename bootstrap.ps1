#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][ValidateSet('codex', 'claude', 'both')][string]$Client,
    [string]$InstallDir,
    [switch]$Write,
    [switch]$Upgrade,
    [switch]$SkipServices
)
$ErrorActionPreference = 'Stop'
$version = 'v0.1.0-alpha.19'
$repository = 'https://github.com/iOwsla/integra-codebase-memory.git'

function Assert-AbsolutePath([string]$Path) {
    # Reject drive-relative and root-relative paths; accept drive and UNC paths.
    if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
        throw 'Provide a fully qualified Windows path, such as C:\Projects\Example.'
    }
}
function Assert-NoRedirection([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Refusing a junction or symbolic link in the runtime path.'
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Invoke-GitChecked([string[]]$GitArguments) {
    $output = & git @GitArguments
    if ($LASTEXITCODE -ne 0) { throw "Git failed (exit $LASTEXITCODE)." }
    return $output
}

Assert-AbsolutePath $Project
if (-not (Test-Path -LiteralPath $Project -PathType Container)) { throw 'Project directory does not exist.' }
$Project = (Get-Item -LiteralPath $Project).FullName
if (-not $InstallDir) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; supply -InstallDir.' }
    $InstallDir = Join-Path $env:LOCALAPPDATA "integra-code-memory\releases\$version"
}
Assert-AbsolutePath $InstallDir
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if (-not $Write) {
    Write-Output "Preview: install $version in $InstallDir and configure $Client for $Project. Docker and managed PostgreSQL are prepared unless -SkipServices is selected. Add -Write to apply."
    return
}
foreach ($dependency in @('git', 'bun')) {
    if (-not (Get-Command $dependency -ErrorAction SilentlyContinue)) { throw "$dependency is required; install it and rerun." }
}
Assert-NoRedirection $InstallDir
if (Test-Path -LiteralPath $InstallDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '.git') -PathType Container)) { throw 'Runtime directory already exists and is not a managed checkout.' }
    if ((Invoke-GitChecked -GitArguments @('-C', $InstallDir, 'remote', 'get-url', 'origin')) -ne $repository) { throw 'Existing runtime has a different origin.' }
    if ((Invoke-GitChecked -GitArguments @('-C', $InstallDir, 'describe', '--tags', '--exact-match', 'HEAD')) -ne $version) { throw 'Existing runtime has a different version.' }
    if (Invoke-GitChecked -GitArguments @('-C', $InstallDir, 'status', '--porcelain', '--untracked-files=normal')) { throw 'Existing runtime has local changes.' }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'node_modules') -PathType Container)) { throw 'Runtime dependencies are missing; use a fresh -InstallDir.' }
} else {
    $parent = [IO.Directory]::GetParent($InstallDir).FullName
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = Join-Path $parent ('.codememory-download-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($temporary)
    try {
        $download = Join-Path $temporary 'runtime'
        Invoke-GitChecked -GitArguments @('clone', '--quiet', '--depth', '1', '--branch', $version, '--', $repository, $download)
        Push-Location -LiteralPath $download
        try {
            & bun install --frozen-lockfile --ignore-scripts
            if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed (exit $LASTEXITCODE)." }
        } finally { Pop-Location }
        Assert-NoRedirection $InstallDir
        # Directory.Move fails if the destination appeared; it never nests/overwrites.
        [IO.Directory]::Move($download, $InstallDir)
        Write-Output "Runtime installed: $InstallDir"
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}
& (Join-Path $InstallDir 'install.ps1') -Project $Project -Client $Client -Write -WithServices:(!$SkipServices) -Upgrade:$Upgrade
