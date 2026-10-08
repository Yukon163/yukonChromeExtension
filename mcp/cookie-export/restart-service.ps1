$ErrorActionPreference = 'Stop'
$bridgeRoot = if ($env:YUKON_COOKIE_BRIDGE_HOME) { $env:YUKON_COOKIE_BRIDGE_HOME } else { Join-Path $env:LOCALAPPDATA 'YukonChromeCookieExport' }
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
