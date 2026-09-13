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
$previousLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = Join-Path $temporary "state"
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
    Assert ($config.mcpServers.integra_code_memory.args -contains '--session-projects') 'Session attachment must be enabled.'
    Assert (Test-Path -LiteralPath (Join-Path $project '.codex/config.toml')) 'Missing Codex config.'
    Must-Fail { & $installer -Project 'relative' -Client codex -Write }
    foreach ($client in @('codex', 'claude')) {
        $single = Join-Path $temporary $client
        [void][IO.Directory]::CreateDirectory($single)
        & $installer -Project $single -Client $client -Write | Out-Null
        Assert ((Test-Path -LiteralPath (Join-Path $single '.mcp.json')) -eq ($client -eq 'claude')) 'Incorrect client scope.'
    }
    $upgradeProject = Join-Path $temporary 'claude'
    $upgradePath = Join-Path $upgradeProject '.mcp.json'
    $oldConfigText = Get-Content -LiteralPath $upgradePath -Raw
    $oldConfig = $oldConfigText | ConvertFrom-Json
    $oldConfig.mcpServers.integra_code_memory.args[0] = 'C:\PreviousRuntime\apps\cli\src\index.ts'
    $oldConfigText = $oldConfig | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($upgradePath, $oldConfigText)
    $upgraded = & $installer -Project $upgradeProject -Client claude -Upgrade -Write | ConvertFrom-Json
    Assert (Test-Path -LiteralPath (Join-Path $upgraded.backupDirectory '.mcp.json')) 'Upgrade did not save previous configuration.'
    $newConfig = Get-Content -LiteralPath $upgradePath -Raw | ConvertFrom-Json
    Assert ($newConfig.mcpServers.integra_code_memory.args[0] -ne 'C:\PreviousRuntime\apps\cli\src\index.ts') 'Upgrade did not retarget the runtime.'
    $managementCli = Join-Path $env:LOCALAPPDATA 'integra-code-memory/cli/bin/codememory.cmd'
    Assert (Test-Path -LiteralPath $managementCli) 'Management CLI was not installed before database setup.'
    $cliProject = Join-Path $temporary 'CLI current directory'
    [void][IO.Directory]::CreateDirectory($cliProject)
    Push-Location -LiteralPath $cliProject
    try {
        & $managementCli projects add --client both --external-db --no-index | Out-Null
        Assert ($LASTEXITCODE -eq 0) 'CLI current-directory add failed without a database.'
        $registered = @(& $managementCli projects list | ConvertFrom-Json)
        Assert ($LASTEXITCODE -eq 0) 'CLI list failed.'
        Assert (@($registered | Where-Object { $_.root -eq $cliProject -and $_.enabled }).Count -eq 1) 'CLI selected the wrong directory.'
        & $managementCli projects remove --yes | Out-Null
        Assert ($LASTEXITCODE -eq 0) 'CLI current-directory removal failed.'
    } finally { Pop-Location }
    $runtime = Join-Path $temporary 'runtime'
    & $bootstrap -Project $project -Client both -InstallDir $runtime | Out-Null
    Assert (-not (Test-Path -LiteralPath $runtime)) 'Bootstrap preview wrote files.'
    Must-Fail { & $bootstrap -Project 'C:relative' -Client both }
    Must-Fail { & $bootstrap -Project $project -Client global }
    Must-Fail { & $bootstrap -Project $project -Client both -InstallDir $project -Write }

    if ($env:TEST_PUBLISHED_BOOTSTRAP -eq 'true') {
        $downloadedScript = Join-Path $temporary 'downloaded-bootstrap.ps1'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.29/bootstrap.ps1' -OutFile $downloadedScript
        $liveProject = Join-Path $temporary 'downloaded target'
        [void][IO.Directory]::CreateDirectory($liveProject)
        $liveRuntime = Join-Path $temporary 'downloaded runtime'
        & $downloadedScript -Project $liveProject -Client both -InstallDir $liveRuntime -Write -SkipServices | Out-Null
        & $downloadedScript -Project $liveProject -Client both -InstallDir $liveRuntime -Write -SkipServices -Upgrade | Out-Null
        $liveConfig = Get-Content -LiteralPath (Join-Path $liveProject '.mcp.json') -Raw | ConvertFrom-Json
        Assert ($liveConfig.mcpServers.integra_code_memory.args[3] -eq $liveProject) 'Published bootstrap selected the wrong project.'
        Write-Output 'Published PowerShell download and repeat installation passed.'
    }

    $parserCheck = & bun (Join-Path $repositoryRoot 'scripts/verify-parser.ts') (Join-Path $repositoryRoot 'tests/fixtures/typescript/regression-005-call-owners') 120000 --progress | ConvertFrom-Json
    Assert ($LASTEXITCODE -eq 0) 'Parser with progress failed.'
    Assert ($parserCheck.progressEvents -gt 0) 'No parser progress crossed the worker pipe.'
    Assert ($parserCheck.danglingEdges -eq 0) 'Progress changed graph integrity.'

    # Stub network/dependency commands; exercise bootstrap orchestration on real Windows paths.
    function git {
        $global:LASTEXITCODE = 0
        if ($args[0] -eq 'clone') {
            $destination = $args[-1]
            [void][IO.Directory]::CreateDirectory($destination)
            if ($global:CodeMemoryTestFailDownload) { $global:LASTEXITCODE = 8; return }
            [void][IO.Directory]::CreateDirectory((Join-Path $destination '.git'))
            Set-Content -LiteralPath (Join-Path $destination 'install.ps1') -Value 'param($Project, $Client, [switch]$Write, [switch]$WithServices) if (-not $Write) { throw "Missing write" }; Set-Content -LiteralPath (Join-Path $PSScriptRoot "received.txt") -Value "$Project|$Client"'
        } elseif ($args[2] -eq 'remote') { 'https://github.com/iOwsla/integra-codebase-memory.git' }
        elseif ($args[2] -eq 'describe') { 'v0.1.0-alpha.29' }
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
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $repositoryRoot 'scripts/setup/ensure-docker.ps1'), [ref]$tokens, [ref]$parseErrors)
    Assert ($parseErrors.Count -eq 0) 'Docker/WSL preparation script has syntax errors.'
    $global:CodeMemoryPreparedFeatures = @()
    function Enable-WindowsOptionalFeature {
        param([switch]$Online, [string]$FeatureName, [switch]$All, [switch]$NoRestart)
        Assert $NoRestart 'Preparation must not reboot automatically.'
        $global:CodeMemoryPreparedFeatures += $FeatureName
    }
    function wsl.exe {
        Assert (($args -join ' ') -eq '--install --web-download --no-distribution') 'Unexpected WSL installation arguments.'
        $global:LASTEXITCODE = 0
    }
    function bcdedit.exe {
        Assert (($args -join ' ') -eq '/set hypervisorlaunchtype auto') 'Unexpected boot configuration command.'
        $global:LASTEXITCODE = 0
    }
    & (Join-Path $repositoryRoot 'scripts/setup/ensure-docker.ps1') -PrepareWsl
    Assert ($LASTEXITCODE -eq 3010) 'Missing restart-required status.'
    Assert ($global:CodeMemoryPreparedFeatures.Count -eq 2) 'Missing Windows features.'
    $global:LASTEXITCODE = 0
    Write-Output 'Windows installer acceptance passed: real project integration, previews, repeats, explicit scope, bootstrap and failure cleanup.'
} finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
