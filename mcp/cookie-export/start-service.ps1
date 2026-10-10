$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-runtime.ps1')
$bridgeRoot = Get-CookieBridgeRoot
$env:YUKON_COOKIE_BRIDGE_HOME = $bridgeRoot
$serviceLock = Enter-CookieServiceLock $bridgeRoot
try {
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
    $nodePath = Get-CookieNodePath $bridgeRoot
    $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $daemonPath + '"') -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100
        if (Test-Path -LiteralPath $stateFile) {
            try {
                $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
                if ($state.pid -eq $process.Id) {
                    Write-CookieServiceLog $bridgeRoot "Bridge started pid=$($process.Id) port=$($state.port)"
                    Write-Output "本机 Cookie 服务已启动：PID $($process.Id)，仅监听 127.0.0.1:$($state.port)"
                    return
                }
            } catch {}
        }
        if ($process.HasExited) { throw '本机服务启动失败，请确认已运行 npm install' }
    }
    throw '本机服务启动超时'
} catch {
    Write-CookieServiceLog $bridgeRoot ('Service startup failed: ' + $_.Exception.Message)
    throw
} finally { Exit-CookieServiceLock $serviceLock }
