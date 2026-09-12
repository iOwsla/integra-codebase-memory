#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string]$CliBin)
& {
param([string]$CliBin)
$ErrorActionPreference = 'Stop'
$CliBin = [IO.Path]::GetFullPath($CliBin)
if (-not (Test-Path -LiteralPath (Join-Path $CliBin 'codememory.cmd') -PathType Leaf)) {
    throw 'Cannot register PATH: the shared CodeMemory launcher is missing.'
}
$base = Split-Path -Parent (Split-Path -Parent $CliBin)
function Normalize-Entry([string]$Entry) {
    return [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"')).Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}
$canonical = Normalize-Entry $CliBin
$legacyCli = Normalize-Entry (Join-Path $base 'cli')
$releases = (Normalize-Entry (Join-Path $base 'releases')) + '\'
function Repair-Path([string]$Value) {
    $kept = foreach ($entry in ($Value -split ';')) {
        $normalized = Normalize-Entry $entry
        # Only known CodeMemory launcher locations inside this installation are retired.
        $oldRelease = $normalized.StartsWith($releases) -and
            ($normalized.Substring($releases.Length) -match '^[^\\]+\\(bin|cli\\bin)$')
        if ($normalized -ne $canonical -and $normalized -ne $legacyCli -and -not $oldRelease) { $entry }
    }
    return (@($CliBin) + @($kept | Where-Object { $_ -ne '' })) -join ';'
}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $before = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $after = Repair-Path $before
    if ($after -ne $before) {
        $key.SetValue('Path', $after, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    }
    if ([string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ne $after) {
        throw 'User PATH verification failed.'
    }
} finally { $key.Dispose() }
$env:Path = Repair-Path $env:Path
# Notify Explorer so newly launched applications receive the persistent environment.
if (-not ('CodeMemory.EnvironmentNotify' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace CodeMemory {
    public static class EnvironmentNotify {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
    }
}
'@
}
$result = [UIntPtr]::Zero
[void][CodeMemory.EnvironmentNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
Write-Verbose 'CodeMemory user PATH repaired. Restart already-open terminal applications.'
} $CliBin
