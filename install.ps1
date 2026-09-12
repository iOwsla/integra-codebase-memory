#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][ValidateSet('codex', 'claude', 'both')][string]$Client,
    [switch]$Write,
    [switch]$Upgrade,
    [switch]$WithServices
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'Bun is required. Install Bun, then rerun this installer.'
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules') -PathType Container)) {
    throw 'Install server dependencies first: bun install --frozen-lockfile'
}
$arguments = @((Join-Path $PSScriptRoot 'scripts/install-project.ts'), '--project', $Project, '--client', $Client.ToLowerInvariant())
if ($Upgrade) { $arguments += '--upgrade' }
if ($Write) { $arguments += '--write' }
if ($WithServices) { $arguments += '--with-services' }
& bun @arguments
if ($LASTEXITCODE -ne 0) { throw "Project installer failed (exit $LASTEXITCODE)." }

if ($Write) {
    $serviceRoot = $env:CODEMEMORY_SERVICE_DIR
    if (-not $serviceRoot) { $serviceRoot = Join-Path $env:LOCALAPPDATA 'integra-code-memory\service' }
    $cliBin = Join-Path (Split-Path -Parent $serviceRoot) 'cli\bin'
    # Dot-source to refresh the invoking PowerShell session as well as persistent PATH.
    . (Join-Path $PSScriptRoot 'scripts/setup/ensure-cli-path.ps1') -CliBin $cliBin
}
