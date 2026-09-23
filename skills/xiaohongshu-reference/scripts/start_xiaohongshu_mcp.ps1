param(
    [switch]$Login,
    [int]$StartupTimeoutSeconds = 1200,
    [int]$HealthTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$runtime = if ($env:XIAOHONGSHU_RUNTIME) { $env:XIAOHONGSHU_RUNTIME } else { Join-Path $dshHome 'xiaohongshu-runtime' }
$client = Join-Path $PSScriptRoot 'xhs_reference_search.py'

& (Join-Path $PSScriptRoot 'install_xiaohongshu_mcp.ps1') -InstallDir $runtime
$installerSucceeded = $?
if (-not $installerSucceeded) {
    throw 'xiaohongshu-mcp installation failed'
}

if ($Login) {
    $loginProcess = Start-Process `
        -FilePath (Join-Path $runtime 'xiaohongshu-login-windows-amd64.exe') `
        -WorkingDirectory $runtime `
        -Wait `
        -PassThru
    exit $loginProcess.ExitCode
}

function Test-PortOpen {
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $tcp.BeginConnect('127.0.0.1', 18060, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne(500)) { return $false }
        $tcp.EndConnect($result)
        return $true
    }
    catch { return $false }
    finally { $tcp.Close() }
}

function Test-McpHealthy {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & python -B $client --timeout $HealthTimeoutSeconds status --quiet *> $null
        $healthExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return ($healthExitCode -eq 0 -or $healthExitCode -eq 2)
}

if (Test-PortOpen) {
    if (Test-McpHealthy) {
        Write-Output 'xiaohongshu-mcp already running'
        exit 0
    }
    throw 'port 18060 is occupied by a non-MCP or unhealthy service; nothing was terminated'
}

Start-Process `
    -FilePath (Join-Path $runtime 'xiaohongshu-mcp-windows-amd64.exe') `
    -ArgumentList '-headless=true' `
    -WorkingDirectory $runtime `
    -WindowStyle Hidden | Out-Null

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ((Test-PortOpen) -and (Test-McpHealthy)) {
        Write-Output 'xiaohongshu-mcp started on http://127.0.0.1:18060/mcp'
        exit 0
    }
}

throw "xiaohongshu-mcp did not become healthy within $StartupTimeoutSeconds seconds"
