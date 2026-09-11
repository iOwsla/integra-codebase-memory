#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('codememory-windows-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Must-Fail([scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed "Expected an error: $Action"
}
try {
    $project = Join-Path $temporary 'target project [one]'
    [void][IO.Directory]::CreateDirectory($project)
    $installer = Join-Path $repositoryRoot 'install.ps1'
    $bootstrap = Join-Path $repositoryRoot 'bootstrap.ps1'
    $env:DATABASE_URL = 'postgresql://invalid.invalid/never-connect'
    $preview = & $installer -Project $project -Client both | ConvertFrom-Json
    Assert (-not $preview.applied) 'Preview must not apply changes.'
    Assert (@(Get-ChildItem -LiteralPath $project -Force).Count -eq 0) 'Preview wrote files.'
    & $installer -Project $project -Client both -Write | Out-Null
    $again = & $installer -Project $project -Client both -Write | ConvertFrom-Json
    Assert ($again.changedFiles.Count -eq 0) 'Repeated install changed files.'
    $config = Get-Content -LiteralPath (Join-Path $project '.mcp.json') -Raw | ConvertFrom-Json
    Assert ($config.mcpServers.integra_code_memory.args[3] -eq $project) 'Wrong project root.'
    Assert (Test-Path -LiteralPath (Join-Path $project '.codex/config.toml')) 'Missing Codex config.'
    Must-Fail { & $installer -Project 'relative' -Client codex -Write }
    foreach ($client in @('codex', 'claude')) {
        $single = Join-Path $temporary $client
        [void][IO.Directory]::CreateDirectory($single)
        & $installer -Project $single -Client $client -Write | Out-Null
        Assert ((Test-Path -LiteralPath (Join-Path $single '.mcp.json')) -eq ($client -eq 'claude')) 'Incorrect client scope.'
    }
    $runtime = Join-Path $temporary 'runtime'
    & $bootstrap -Project $project -Client both -InstallDir $runtime | Out-Null
    Assert (-not (Test-Path -LiteralPath $runtime)) 'Bootstrap preview wrote files.'
    Must-Fail { & $bootstrap -Project 'C:relative' -Client both }
    Must-Fail { & $bootstrap -Project $project -Client global }
    Must-Fail { & $bootstrap -Project $project -Client both -InstallDir $project -Write }

    if ($env:TEST_PUBLISHED_BOOTSTRAP -eq 'true') {
        $downloadedScript = Join-Path $temporary 'downloaded-bootstrap.ps1'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.13/bootstrap.ps1' -OutFile $downloadedScript
        $liveProject = Join-Path $temporary 'downloaded target'
        [void][IO.Directory]::CreateDirectory($liveProject)
        $liveRuntime = Join-Path $temporary 'downloaded runtime'
        & $downloadedScript -Project $liveProject -Client both -InstallDir $liveRuntime -Write | Out-Null
        & $downloadedScript -Project $liveProject -Client both -InstallDir $liveRuntime -Write | Out-Null
        $liveConfig = Get-Content -LiteralPath (Join-Path $liveProject '.mcp.json') -Raw | ConvertFrom-Json
        Assert ($liveConfig.mcpServers.integra_code_memory.args[3] -eq $liveProject) 'Published bootstrap selected the wrong project.'
        Write-Output 'Published PowerShell download and repeat installation passed.'
    }

    # Stub network/dependency commands; exercise bootstrap orchestration on real Windows paths.
    function git {
        $global:LASTEXITCODE = 0
        if ($args[0] -eq 'clone') {
            $destination = $args[-1]
            [void][IO.Directory]::CreateDirectory($destination)
            if ($global:CodeMemoryTestFailDownload) { $global:LASTEXITCODE = 8; return }
            [void][IO.Directory]::CreateDirectory((Join-Path $destination '.git'))
            Set-Content -LiteralPath (Join-Path $destination 'install.ps1') -Value 'param($Project, $Client, [switch]$Write) if (-not $Write) { throw "Missing write" }; Set-Content -LiteralPath (Join-Path $PSScriptRoot "received.txt") -Value "$Project|$Client"'
        } elseif ($args[2] -eq 'remote') { 'https://github.com/iOwsla/integra-codebase-memory.git' }
        elseif ($args[2] -eq 'describe') { 'v0.1.0-alpha.13' }
    }
    function bun {
        $global:LASTEXITCODE = 0
        if ($global:CodeMemoryTestFailDependencies) { $global:LASTEXITCODE = 7; return }
        Assert (($args -join ' ') -eq 'install --frozen-lockfile --ignore-scripts') 'Unexpected Bun command.'
        [void][IO.Directory]::CreateDirectory((Join-Path (Get-Location).Path 'node_modules'))
    }
    $global:CodeMemoryTestFailDownload = $false
    $global:CodeMemoryTestFailDependencies = $false
    & $bootstrap -Project $project -Client both -InstallDir $runtime -Write | Out-Null
    & $bootstrap -Project $project -Client both -InstallDir $runtime -Write | Out-Null
    Assert ((Get-Content -LiteralPath (Join-Path $runtime 'received.txt') -Raw).Trim() -eq "$project|both") 'Lost project/client arguments.'
    foreach ($failure in @('download', 'dependencies')) {
        $global:CodeMemoryTestFailDownload = $failure -eq 'download'
        $global:CodeMemoryTestFailDependencies = $failure -eq 'dependencies'
        $failedRuntime = Join-Path $temporary $failure
        Must-Fail { & $bootstrap -Project $project -Client both -InstallDir $failedRuntime -Write }
        Assert (-not (Test-Path -LiteralPath $failedRuntime)) 'Failed runtime was published.'
        Assert (@(Get-ChildItem -LiteralPath $temporary -Filter '.codememory-download-*' -Force).Count -eq 0) 'Temporary download leaked.'
    }
    Write-Output 'Windows installer acceptance passed: real project integration, previews, repeats, explicit scope, bootstrap and failure cleanup.'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
