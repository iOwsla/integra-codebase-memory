#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][ValidateSet('codex', 'claude', 'both')][string]$Client,
    [switch]$Write,
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
if ($Write) { $arguments += '--write' }
if ($WithServices) { $arguments += '--with-services' }
& bun @arguments
if ($LASTEXITCODE -ne 0) { throw "Project installer failed (exit $LASTEXITCODE)." }
