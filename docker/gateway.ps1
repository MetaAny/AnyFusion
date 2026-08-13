# Persistent AnyFusion Feishu Gateway for Windows-hosted Docker Desktop.
#
# First deployment and source updates:
#   .\docker\gateway.ps1 -Rebuild
# Routine operations:
#   .\docker\gateway.ps1 -Start | -Restart | -Stop | -Status | -Logs [-Follow]
#   .\docker\gateway.ps1 -Doctor | -Remove
[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$Rebuild,
    [switch]$Restart,
    [switch]$Stop,
    [switch]$Status,
    [switch]$Logs,
    [switch]$Follow,
    [switch]$Doctor,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$anyFusionPiRoot = Join-Path (Split-Path -Parent $repoRoot) 'AnyFusion-Pi'
$runtimeImage = 'metaclaw-runtime'
$container = 'anyfusion-gateway'
$workspaceVolume = 'anyfusion-gateway-workspace'
$dataVolume = 'anyfusion-gateway-data-v35-anyfusion-planner'
$plannerEnvFile = Join-Path $repoRoot 'docker\planner-pi.env'
$codexExecutorEnvFile = Join-Path $repoRoot 'docker\executor-codex.env'
$piExecutorEnvFile = Join-Path $repoRoot 'docker\executor-pi.env'
$feishuEnvFile = Join-Path $repoRoot 'docker\feishu.env'
$plannerEnvContainerPath = '/run/metaclaw/env/planner-pi.env'
$codexExecutorEnvContainerPath = '/run/metaclaw/env/executor-codex.env'
$piExecutorEnvContainerPath = '/run/metaclaw/env/executor-pi.env'
$feishuEnvContainerPath = '/run/metaclaw/env/feishu.env'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

function Test-ContainerExists {
    return ((Invoke-DockerQuiet inspect --type=container $container) -eq 0)
}

function Assert-FeishuEnv {
    $content = Get-Content -Raw $feishuEnvFile
    foreach ($name in @('FEISHU_APP_ID', 'FEISHU_APP_SECRET')) {
        $match = [regex]::Match($content, "(?m)^\s*$name\s*=\s*(.+?)\s*$")
        if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups[1].Value)) {
            throw "$name is empty in $feishuEnvFile."
        }
    }
}

function Assert-Prereqs {
    Test-RuntimePrereqs -RepoRoot $repoRoot -AnyFusionPiRoot $anyFusionPiRoot `
      -RequiredEnvFiles @($plannerEnvFile, $codexExecutorEnvFile, $piExecutorEnvFile, $feishuEnvFile)
    Assert-FeishuEnv
}

function Remove-GatewayContainer {
    if (Test-ContainerExists) {
        & docker rm -f $container | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to remove the Gateway container.' }
    }
}

function Start-GatewayContainer {
    Remove-GatewayContainer
    Write-Host "Starting persistent Feishu Gateway '$container' ..." -ForegroundColor Cyan
    & docker run -d --name $container `
      --network bridge `
      --restart unless-stopped `
      --health-cmd 'node /app/dist/index.js gateway health' `
      --health-interval 10s `
      --health-timeout 5s `
      --health-retries 6 `
      --health-start-period 180s `
      -v "${workspaceVolume}:/workspace" `
      -v "${dataVolume}:/data" `
      -v "${plannerEnvFile}:${plannerEnvContainerPath}:ro" `
      -v "${codexExecutorEnvFile}:${codexExecutorEnvContainerPath}:ro" `
      -v "${piExecutorEnvFile}:${piExecutorEnvContainerPath}:ro" `
      -v "${feishuEnvFile}:${feishuEnvContainerPath}:ro" `
      -w /workspace/default `
      -e METACLAW_PLANNER_ENV_FILE=$plannerEnvContainerPath `
      -e METACLAW_CODEX_EXECUTOR_ENV_FILE=$codexExecutorEnvContainerPath `
      -e METACLAW_PI_EXECUTOR_ENV_FILE=$piExecutorEnvContainerPath `
      -e METACLAW_FEISHU_ENV_FILE=$feishuEnvContainerPath `
      -e ANYFUSION_DEFAULT_CONFIG=/opt/metaclaw/gateway-config.yaml `
      -e ANYFUSION_DATA_HOME=/data/anyfusion `
      -e ANYFUSION_CONFIG_HOME=/data/anyfusion/config `
      -e METACLAW_HOME=/data/anyfusion/runtime `
      -e METACLAW_EXECUTOR_CODEX_HOME=/data/anyfusion/config/codex `
      -e METACLAW_EXECUTOR_PI_HOME=/data/anyfusion/config/pi-home `
      -e PI_SKIP_VERSION_CHECK=1 `
      -e PI_TELEMETRY=0 `
      $runtimeImage `
      node /app/dist/index.js gateway run --project /workspace/default
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Gateway container.' }
    Wait-GatewayHealthy
}

function Wait-GatewayHealthy {
    for ($i = 0; $i -lt 240; $i++) {
        $state = (& docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' $container 2>$null)
        if ($LASTEXITCODE -ne 0 -or $state -match '^exited|^dead') {
            Write-Host 'Gateway stopped before becoming healthy. Recent logs:' -ForegroundColor Red
            & docker logs --tail 100 $container
            throw 'Gateway startup failed.'
        }
        if ($state -match ' healthy$') {
            Write-Host 'AnyFusion Feishu Gateway is healthy.' -ForegroundColor Green
            return
        }
        Start-Sleep -Seconds 1
    }
    & docker logs --tail 100 $container
    throw 'Gateway did not become healthy within 240 seconds.'
}

function Show-Status {
    if (-not (Test-ContainerExists)) {
        Write-Host 'Gateway container does not exist.' -ForegroundColor Yellow
        return
    }
    & docker inspect --format 'container={{.Name}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart={{.HostConfig.RestartPolicy.Name}}' $container
    if ((& docker inspect --format '{{.State.Running}}' $container) -eq 'true') {
        & docker exec $container node /app/dist/index.js gateway health
    }
}

if ($Remove) {
    Remove-GatewayContainer
    Write-Host 'Gateway container removed; persistent volumes were preserved.' -ForegroundColor Green
    return
}
if ($Stop) {
    if (Test-ContainerExists) { & docker stop $container | Out-Null }
    Write-Host 'Gateway stopped.' -ForegroundColor Green
    return
}
if ($Logs) {
    if (-not (Test-ContainerExists)) { throw 'Gateway container does not exist.' }
    if ($Follow) { & docker logs --follow $container } else { & docker logs --tail 200 $container }
    return
}
if ($Doctor) {
    if (-not (Test-ContainerExists)) { throw 'Gateway container does not exist.' }
    & docker exec $container node /app/dist/index.js gateway doctor
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    return
}
if ($Status) { Show-Status; return }
if ($Restart) {
    if (-not (Test-ContainerExists)) { throw 'Gateway container does not exist.' }
    & docker restart $container | Out-Null
    Wait-GatewayHealthy
    return
}

Assert-Prereqs
if ($Rebuild) {
    Build-AnyFusionRuntimeImage -RepoRoot $repoRoot -AnyFusionPiRoot $anyFusionPiRoot -Image $runtimeImage -Force
    Start-GatewayContainer
    return
}
if (-not (Test-RuntimeImageExists $runtimeImage)) {
    Build-AnyFusionRuntimeImage -RepoRoot $repoRoot -AnyFusionPiRoot $anyFusionPiRoot -Image $runtimeImage
}
if ($Start -and (Test-ContainerExists)) {
    $running = (& docker inspect --format '{{.State.Running}}' $container)
    if ($running -ne 'true') { & docker start $container | Out-Null }
    Wait-GatewayHealthy
    return
}
Start-GatewayContainer
