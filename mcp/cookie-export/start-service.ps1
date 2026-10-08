$ErrorActionPreference = 'Stop'
$bridgeRoot = if ($env:YUKON_COOKIE_BRIDGE_HOME) { $env:YUKON_COOKIE_BRIDGE_HOME } else { Join-Path $env:LOCALAPPDATA 'YukonChromeCookieExport' }
& (Join-Path $PSScriptRoot 'start-control.ps1')
$daemonPath = Join-Path $PSScriptRoot 'bridge-daemon.mjs'
$stateFile = Join-Path $bridgeRoot 'daemon-state.json'
if (Test-Path -LiteralPath $stateFile) {
    try {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $running = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)"
        if ($running -and $running.Name -eq 'node.exe' -and $running.CommandLine.Contains($daemonPath)) {
            Write-Output '本机 Cookie 服务已经运行'
            return
        }
    } catch {}
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $daemonPath + '"') -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
            if ($state.pid -eq $process.Id) { Write-Output "本机 Cookie 服务已启动：PID $($process.Id)，仅监听 127.0.0.1:$($state.port)"; return }
        } catch {}
    }
    if ($process.HasExited) { throw '本机服务启动失败，请确认已运行 npm install' }
}
throw '本机服务启动超时'
