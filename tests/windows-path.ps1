#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('codememory-path-' + [guid]::NewGuid())
$bin = Join-Path $root 'cli\bin'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$original = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$kind = if ($null -ne $original) { $key.GetValueKind('Path') } else { $null }
$processPath = $env:Path
try {
    [void][IO.Directory]::CreateDirectory($bin)
    Set-Content -LiteralPath (Join-Path $bin 'codememory.cmd') -Value '@echo ok'
    $other = 'C:\Unrelated Tools\bin;%SystemRoot%\System32'
    $seed = "$other;$root\cli;$($bin.ToUpperInvariant())\;$root\releases\alpha-old\bin;$root\releases\alpha-old\cli\bin;$root\releases\alpha-old\custom"
    $key.SetValue('Path', $seed, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $script = Join-Path $PSScriptRoot '..\scripts\setup\ensure-cli-path.ps1'
    . $script -CliBin $bin
    $expected = "$bin;$other;$root\releases\alpha-old\custom"
    $actual = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($actual -cne $expected) { throw "Unexpected repaired PATH: $actual" }
    if (-not $env:Path.StartsWith("$bin;")) { throw 'Current session not refreshed' }
    . $script -CliBin $bin
    if ($key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $expected) { throw 'Repeat repair changed PATH' }
    Remove-Item -LiteralPath (Join-Path $bin 'codememory.cmd')
    $failed = $false
    try { . $script -CliBin $bin } catch { $failed = $true }
    if (-not $failed) { throw 'Missing launcher accepted' }
    if ($key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $expected) { throw 'Failure mutated PATH' }
    Write-Output 'PASS: persistent PATH, current session, legacy cleanup, preservation, repeat repair, missing launcher'
} finally {
    if ($null -eq $original) { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $original, $kind) }
    $key.Dispose()
    $env:Path = $processPath
    Remove-Item -LiteralPath $root -Recurse -Force
}
