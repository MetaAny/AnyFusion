# MetaClaw SSH shell workflow: start a persistent container running sshd once,
# then connect over SSH to run the TUI or browse files.
#
# Why SSH instead of `docker exec -it`: on Windows, `docker exec -it` gives
# the TUI input stream a stdin that isn't a real terminal, which crashes the TUI
# with "Raw mode is not supported". SSH provides a genuine PTY, so the Ink TUI
# works, and you also get a general-purpose shell for inspecting /workspace
# output files. VS Code Remote-SSH can open the same /workspace as a folder.
#
# The container's main process is sshd, so it stays up across sessions. The
# published port is loopback-only; this local workflow is not a remote SSH service.
# Login:
#   user: root   password: metaclaw   port: 2222
#
# Usage:
#   .\docker\shell.ps1 -Start         # build (if needed) + start the SSH container
#   .\docker\shell.ps1 -SetupSsh      # one-time: set up passwordless key login
#   .\docker\shell.ps1                # SSH in and launch the TUI (default)
#   .\docker\shell.ps1 -Exec          # same as default: SSH + TUI
#   .\docker\shell.ps1 -Bash          # SSH in to a plain bash shell (no TUI)
#   .\docker\shell.ps1 -Stop          # stop the container
#   .\docker\shell.ps1 -Remove        # stop and remove the container
#   .\docker\shell.ps1 -Rebuild       # rebuild image, then recreate container
#
# After -SetupSsh, `ssh metaclaw` (host alias) and VS Code Remote-SSH connect
# with no password. The key lives in .tmp\ssh_key (gitignored).
#
# Source edits require `-Rebuild`: runtime code, Planner homes, skills, and the
# entrypoint are baked into the image. Only workspace outputs and MetaClaw data
# use named volumes; host build/config directories are never bind-mounted.
#
# The default demo keeps only this Runtime container. Canonical Codex/Pi
# Executors run as child processes in the managed Subtask worktrees.
[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$Exec,
    [switch]$Bash,
    [switch]$Stop,
    [switch]$Remove,
    [switch]$Rebuild,
    [switch]$SetupSsh
)

# Note: we do NOT set $ErrorActionPreference = 'Stop' here. Docker writes normal
# "not found" notices to stderr, which Stop-mode would turn into fatal errors.
$ErrorActionPreference = 'Continue'

$repoRoot    = Split-Path -Parent $PSScriptRoot
# One runtime image contains MetaClaw, Planner, Node, and the optional SSH entry.
$runtimeImage = 'metaclaw-runtime'
$anyFusionPiRoot = Join-Path (Split-Path -Parent $repoRoot) 'AnyFusion-Pi'
$container   = 'metaclaw-shell'
$sshHost     = 'localhost'
$sshBindHost = '127.0.0.1'
$sshPort     = 2222
$sshUser     = 'root'
$sshPassword = 'metaclaw'   # only used to print a reminder; ssh prompts for it
$plannerEnvFile = Join-Path $repoRoot 'docker\planner-pi.env'
$codexExecutorEnvFile = Join-Path $repoRoot 'docker\executor-codex.env'
$piExecutorEnvFile = Join-Path $repoRoot 'docker\executor-pi.env'
$plannerEnvContainerPath = '/run/metaclaw/env/planner-pi.env'
$codexExecutorEnvContainerPath = '/run/metaclaw/env/executor-codex.env'
$piExecutorEnvContainerPath = '/run/metaclaw/env/executor-pi.env'
$workspaceVolume = 'metaclaw-shell-workspace'
# Pre-release schemas are intentionally not migrated. Scope the persistent data
# volume to the current schema so -Rebuild starts clean after a schema break
# while preserving the previous volume for manual recovery.
$dataVolume = 'metaclaw-shell-data-v30-anyfusion-planner'
$knownHosts  = Join-Path $repoRoot '.tmp\ssh_known_hosts'
# Key-based passwordless login. A dedicated key pair lives under .tmp (gitignored)
# so the global ~/.ssh is untouched. The public key is injected into the
# container's ~/.ssh/authorized_keys at every start, so it survives rebuilds.
$sshKeyDir   = Join-Path $repoRoot '.tmp\ssh_key'
$sshKeyPath  = Join-Path $sshKeyDir 'id_ed25519'
$sshConfigFile = Join-Path $sshKeyDir 'config'

# Run a docker command, suppressing its stderr/exit-code without tripping the
# script. Returns the docker exit code so callers can branch on it.
function Invoke-DockerQuiet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $out = & docker @Args 2>&1 | Out-Null
    return $LASTEXITCODE
}

# Returns $true if the named container exists (running or stopped).
function Test-ContainerExists {
    $code = Invoke-DockerQuiet inspect --type=container $container
    return ($code -eq 0)
}

# Mounts are fixed when a container is created. Detect shells created before the
# current Runtime image so the default workflow does not silently reuse a stale
# container.
function Test-ContainerUsesCurrentImage {
    if (-not (Test-ContainerExists)) { return $false }
    $containerImage = docker inspect --format '{{.Image}}' $container 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $tagImage = docker image inspect --format '{{.Id}}' $runtimeImage 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    return (([string]$containerImage).Trim() -eq ([string]$tagImage).Trim())
}

function Test-ContainerHasLoopbackSshBinding {
    if (-not (Test-ContainerExists)) { return $false }
    $hostIps = docker inspect --format '{{range (index .HostConfig.PortBindings "22/tcp")}}{{println .HostIp}}{{end}}' $container 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $bindings = @($hostIps | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    return ($bindings.Count -gt 0 -and @($bindings | Where-Object { ([string]$_).Trim() -ne $sshBindHost }).Count -eq 0)
}

function Test-ImageExists {
    param([string]$Tag)
    $code = Invoke-DockerQuiet image inspect $Tag
    return ($code -eq 0)
}

# Ensure a dedicated ed25519 key pair exists for passwordless login to the
# container. Idempotent: if the key already exists, nothing is generated. The
# key stays under .tmp/ssh_key (gitignored), never touching ~/.ssh.
function Ensure-SshKey {
    if (Test-Path $sshKeyPath) { return }
    New-Item -ItemType Directory -Force -Path $sshKeyDir | Out-Null
    Write-Host "Generating dedicated SSH key for passwordless login..." -ForegroundColor Yellow
    & ssh-keygen -t ed25519 -N '' -f $sshKeyPath -C 'metaclaw-shell' -q
    if ($LASTEXITCODE -ne 0) {
        Write-Error "ssh-keygen failed."
        exit 1
    }
    # Windows: OpenSSH refuses to load a private key that other users can read
    # ("UNPROTECTED PRIVATE KEY FILE ... bad permissions"). New files inherit
    # the parent dir's ACL, which on Windows usually grants Authenticated/Users
    # read access. Strip inheritance and grant only the current user, or ssh
    # silently ignores the key and falls back to a password prompt.
    Lock-SshKeyPermissions
}

# Lock a file's Windows ACL to the current user only (disable inheritance,
# remove all inherited ACEs, grant just $env:USERNAME full control). Required
# for private keys on Windows; harmless on the .pub and config.
function Lock-SshKeyPermissions {
    $user = $env:USERNAME
    foreach ($p in @($sshKeyDir, $sshKeyPath, "$sshKeyPath.pub", $sshConfigFile)) {
        if (Test-Path $p) {
            icacls $p /inheritance:r 2>$null | Out-Null
            icacls $p /grant:r "${user}:F" 2>$null | Out-Null
        }
    }
}

# Inject the public key into the running container's authorized_keys so ssh
# logins skip the password prompt. Uses `docker cp` + simple `grep`/`cat` steps
# (no `$(...)` or `||` inside a single sh -c, which PowerShell mis-parses). We
# append rather than overwrite so any user-installed keys are preserved.
function Install-SshPublicKey {
    if (-not (Test-Path "$sshKeyPath.pub")) { return }
    if (-not (Test-ContainerExists)) { return }
    docker exec $container sh -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys' 2>$null | Out-Null
    $tmpRemote = '/tmp/metaclaw_pubkey.pub'
    docker cp "$sshKeyPath.pub" "${container}:$tmpRemote" 2>$null | Out-Null
    # Append the staged key only if it isn't already present. -f reads patterns
    # from the file; grep returns 0 (found) or 1 (not found) — we append on 1.
    $found = Invoke-DockerQuiet exec $container grep -qf $tmpRemote /root/.ssh/authorized_keys
    if ($found -ne 0) {
        docker exec $container sh -c 'cat /tmp/metaclaw_pubkey.pub >> ~/.ssh/authorized_keys' 2>$null | Out-Null
    }
    docker exec $container sh -c 'chmod 600 ~/.ssh/authorized_keys; rm -f /tmp/metaclaw_pubkey.pub' 2>$null | Out-Null
}

# Write an SSH client config (host alias `metaclaw`) so `ssh metaclaw` and VS
# Code Remote-SSH connect with the right port, user, key, and known_hosts
# without any per-invocation flags. Idempotent: rewrites the file each call.
function Write-SshClientConfig {
    Ensure-SshKey
    $config = @(
        "Host metaclaw"
        "    HostName $sshHost"
        "    Port $sshPort"
        "    User $sshUser"
        "    IdentityFile $sshKeyPath"
        "    IdentitiesOnly yes"
        "    UserKnownHostsFile $knownHosts"
        "    StrictHostKeyChecking accept-new"
        "    AddressFamily inet"
    ) -join "`n"
    Set-Content -Path $sshConfigFile -Value $config -Encoding ascii
}

# One-shot setup: generate key, install public key into the container, and write
# the client config. After this, `ssh metaclaw` (and VS Code Remote-SSH) connect
# with no password. Re-run after a -Rebuild to reseed the public key.
function Invoke-SetupSsh {
    Ensure-ContainerRunning
    Ensure-SshKey
    Install-SshPublicKey
    Write-SshClientConfig
    Write-Host "Passwordless SSH configured." -ForegroundColor Green
    Write-Host "  Connect:     ssh metaclaw   (or:  .\docker\shell.ps1)" -ForegroundColor Cyan
    Write-Host "  VS Code:     Remote-SSH -> connect to host 'metaclaw', open /workspace" -ForegroundColor Cyan
    Write-Host "  Config file: $sshConfigFile" -ForegroundColor DarkGray
}

function Test-Prereqs {
    $plannerPackage = Join-Path $anyFusionPiRoot 'package.json'
    if (-not (Test-Path $plannerPackage)) {
        Write-Error "Missing sibling AnyFusion-Pi repository at $anyFusionPiRoot."
        exit 1
    }
    $requiredEnvFiles = @($plannerEnvFile, $codexExecutorEnvFile, $piExecutorEnvFile)
    foreach ($requiredEnvFile in $requiredEnvFiles) {
        if (-not (Test-Path $requiredEnvFile)) {
            Write-Error ("Missing " + $requiredEnvFile + ". Copy its .example file and fill the provider settings.")
            exit 1
        }
    }
}

# Build the unified runtime image when it is missing.
function Build-RuntimeImage {
    param([switch]$Force)
    if (-not $Force -and (Test-ImageExists $runtimeImage)) { return }
    Write-Host ("Building unified runtime image " + $runtimeImage + " ...") -ForegroundColor Yellow
    docker build --build-context "anyfusion-pi=$anyFusionPiRoot" -f (Join-Path $repoRoot 'docker\Dockerfile.runtime') -t $runtimeImage $repoRoot
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Start-ShellContainer {
    # Remove any stale container with the same name (silent if none exists).
    if (Test-ContainerExists) {
        Invoke-DockerQuiet rm -f $container | Out-Null
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $knownHosts) | Out-Null

    Write-Host ("Starting persistent SSH container '" + $container + "' ...") -ForegroundColor Cyan
    # Main process: render provider config, then exec sshd -D so the container
    # stays up as an SSH server. Executor CLIs are installed in this image and
    # launched as child processes in their managed worktrees.
    #
    docker run -d --name $container `
      --network bridge `
      -p "${sshBindHost}:${sshPort}:22" `
      --entrypoint /bin/bash `
      -v "${workspaceVolume}:/workspace" `
      -v "${dataVolume}:/data" `
      -v "${plannerEnvFile}:${plannerEnvContainerPath}:ro" `
      -v "${codexExecutorEnvFile}:${codexExecutorEnvContainerPath}:ro" `
      -v "${piExecutorEnvFile}:${piExecutorEnvContainerPath}:ro" `
      -w /workspace `
      -e METACLAW_PLANNER_ENV_FILE=$plannerEnvContainerPath `
      -e METACLAW_CODEX_EXECUTOR_ENV_FILE=$codexExecutorEnvContainerPath `
      -e METACLAW_PI_EXECUTOR_ENV_FILE=$piExecutorEnvContainerPath `
      -e METACLAW_HOME=/data/metaclaw `
      -e METACLAW_EXECUTOR_BACKEND=worktree `
      -e METACLAW_EXECUTOR_CODEX_HOME=/var/lib/metaclaw/codex/executor `
      -e METACLAW_EXECUTOR_PI_HOME=/root `
      -e PI_SKIP_VERSION_CHECK=1 `
      -e PI_TELEMETRY=0 `
      $runtimeImage `
      -c "exec /opt/metaclaw/entrypoint.sh /usr/sbin/sshd -D"

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to start container."
        exit 1
    }

    # Re-seed the public key (if set up) so passwordless login survives rebuilds.
    Install-SshPublicKey
    Write-Host ("SSH container ready on 127.0.0.1:" + $sshPort + " (user=" + $sshUser + " password=" + $sshPassword + ").") -ForegroundColor Green
    Write-Host 'Executor backend: worktree child processes (Codex/Pi).' -ForegroundColor DarkGray
    if (Test-Path $sshKeyPath) {
        Write-Host "Passwordless login active (key at .tmp\ssh_key)." -ForegroundColor Green
    }
    Write-Host ("Run '.\docker\shell.ps1' (no args) to enter the TUI.") -ForegroundColor Green
}

function Ensure-ContainerRunning {
    if (Test-ContainerExists) {
        if (-not (Test-ContainerUsesCurrentImage)) {
            Write-Host "Container uses an older image; recreating it from $runtimeImage..." -ForegroundColor Yellow
            Start-ShellContainer
            return
        }
        if (-not (Test-ContainerHasLoopbackSshBinding)) {
            Write-Host "Container SSH is not loopback-only; recreating it safely..." -ForegroundColor Yellow
            Start-ShellContainer
            return
        }
        $running = docker inspect -f '{{.State.Running}}' $container 2>$null
        if ($running -ne 'true') {
            Write-Host "Container exists but is stopped, starting it..." -ForegroundColor Yellow
            docker start $container | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Failed to start container."
                exit $LASTEXITCODE
            }
        }
        return
    }
    Write-Host "Container not found, starting it first..." -ForegroundColor Yellow
    if (-not (Test-ImageExists $runtimeImage)) { Build-RuntimeImage }
    Start-ShellContainer
}

# Provider env files are bind-mounted and may change while the persistent shell
# container keeps running. Re-render Planner and Executor configs before each
# interactive entry so a new base URL is never paired with stale credentials.
function Refresh-ContainerProviderConfigs {
    docker exec $container /opt/metaclaw/entrypoint.sh : 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Failed to refresh provider configs from mounted env files.'
        exit $LASTEXITCODE
    }
}

# Wait until sshd is accepting connections on the published port (it starts a
# moment after `docker run` returns). Times out after ~15s. Uses bash for its
# /dev/tcp support (the image's default sh is dash, which lacks /dev/tcp).
function Wait-SshReady {
    $deadline = 15
    for ($i = 0; $i -lt $deadline; $i++) {
        $code = Invoke-DockerQuiet exec $container /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/22'
        if ($code -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    Write-Warning "sshd did not become ready within ${deadline}s; ssh may fail."
}

# ssh client flags common to every connect: accept the host key on first connect
# (writing it to a repo-local known_hosts so the user's global file stays clean),
# force IPv4 to avoid localhost resolution surprises on Windows. If a dedicated
# key exists (set up via -SetupSsh), prefer it for passwordless login; ssh falls
# back to a password prompt otherwise.
function Ssh-CommonArgs {
    $args = @(
        '-p', $sshPort,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', "UserKnownHostsFile=$knownHosts",
        '-o', 'AddressFamily=inet'
    )
    if (Test-Path $sshKeyPath) {
        $args += @(
            '-i', $sshKeyPath,
            '-o', 'IdentitiesOnly=yes',
            '-o', 'PreferredAuthentications=publickey,password'
        )
    }
    $args += "$sshUser@$sshHost"
    return $args
}

# Remove any stale [host]:port entry from the repo-local known_hosts. Every
# container rebuild regenerates sshd's host key, so the stored fingerprint stops
# matching and ssh refuses to connect ("REMOTE HOST IDENTIFICATION HAS CHANGED").
# accept-new only handles first-seen keys, not changed ones, so we proactively
# drop the entry and let ssh accept the fresh key. Silent if absent.
function Clear-StaleHostKey {
    if (Test-Path $knownHosts) {
        & ssh-keygen -R "[$sshHost]:$sshPort" -f $knownHosts 2>&1 | Out-Null
    }
}

function Enter-Tui {
    Wait-SshReady
    Clear-StaleHostKey
    Write-Host ("Launching AnyFusion Planner TUI over SSH (port " + $sshPort + ")...") -ForegroundColor Cyan
    Write-Host "Tip: /exit to leave the TUI; Ctrl+C to force-quit. Container keeps running." -ForegroundColor DarkGray
    $args = Ssh-CommonArgs
    $args += @('-t', 'cd /workspace && node /app/dist/index.js')
    & ssh @args
}

function Enter-Bash {
    Wait-SshReady
    Clear-StaleHostKey
    Write-Host ("SSH bash (port " + $sshPort + "). Ctrl+D or 'exit' to leave.") -ForegroundColor DarkGray
    $args = Ssh-CommonArgs
    $args += @('-t', 'cd /workspace && exec /bin/bash')
    & ssh @args
}

# --- main dispatch ---
Test-Prereqs

if ($Rebuild) {
    Build-RuntimeImage -Force
    Start-ShellContainer
    return
}

if ($Remove) {
    if (Test-ContainerExists) { Invoke-DockerQuiet rm -f $container | Out-Null }
    Write-Host "Removed." -ForegroundColor Green
    return
}
if ($Stop) {
    if (Test-ContainerExists) { Invoke-DockerQuiet stop $container | Out-Null }
    Write-Host "Stopped." -ForegroundColor Green
    return
}

if ($Start) {
    if (-not (Test-ImageExists $runtimeImage)) { Build-RuntimeImage }
    Start-ShellContainer
    return
}

if ($SetupSsh) { Invoke-SetupSsh; return }

# Default + -Exec + -Bash all need a running container.
Ensure-ContainerRunning
Refresh-ContainerProviderConfigs

if ($Bash) { Enter-Bash } else { Enter-Tui }
