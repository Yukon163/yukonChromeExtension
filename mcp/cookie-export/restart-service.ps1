$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-runtime.ps1')
$bridgeRoot = Get-CookieBridgeRoot
$env:YUKON_COOKIE_BRIDGE_HOME = $bridgeRoot
$serviceLock = Enter-CookieServiceLock $bridgeRoot
try {
    $daemonPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'bridge-daemon.mjs'))
    $stateFile = Join-Path $bridgeRoot 'daemon-state.json'
    if (Test-Path -LiteralPath $stateFile) {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $running = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)"
        if ($running) {
            if ($running.Name -ne 'node.exe' -or -not $running.CommandLine.Contains($daemonPath)) {
                throw '记录的进程不是本机 Cookie 服务，已停止重启操作'
            }
            Stop-Process -Id $state.pid -Force -ErrorAction Stop
            Wait-Process -Id $state.pid -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
    & (Join-Path $PSScriptRoot 'start-service.ps1')
} finally { Exit-CookieServiceLock $serviceLock }
