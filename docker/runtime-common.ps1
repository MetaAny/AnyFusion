function Invoke-DockerQuiet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    & docker @Args 2>&1 | Out-Null
    return $LASTEXITCODE
}

function Test-RuntimeImageExists {
    param([string]$Tag)
    return ((Invoke-DockerQuiet image inspect $Tag) -eq 0)
}

function Test-RuntimePrereqs {
    param(
        [string]$RepoRoot,
        [string]$AnyFusionPiRoot,
        [string[]]$RequiredEnvFiles
    )
    if (-not (Test-Path (Join-Path $AnyFusionPiRoot 'package.json'))) {
        throw "Missing sibling AnyFusion-Pi repository at $AnyFusionPiRoot."
    }
    foreach ($requiredEnvFile in $RequiredEnvFiles) {
        if (-not (Test-Path $requiredEnvFile)) {
            throw "Missing $requiredEnvFile. Copy its .example file and fill the provider settings."
        }
    }
}

function Build-AnyFusionRuntimeImage {
    param(
        [string]$RepoRoot,
        [string]$AnyFusionPiRoot,
        [string]$Image,
        [switch]$Force
    )
    if (-not $Force -and (Test-RuntimeImageExists $Image)) { return }
    Write-Host "Building unified runtime image $Image ..." -ForegroundColor Yellow
    docker build --build-context "anyfusion-pi=$AnyFusionPiRoot" -f (Join-Path $RepoRoot 'docker\Dockerfile.runtime') -t $Image $RepoRoot
    if ($LASTEXITCODE -ne 0) { throw "Runtime image build failed with exit code $LASTEXITCODE." }
}
