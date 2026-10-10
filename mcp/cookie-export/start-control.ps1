$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-runtime.ps1')
$bridgeRoot = Get-CookieBridgeRoot
$env:YUKON_COOKIE_BRIDGE_HOME = $bridgeRoot
$serviceLock = Enter-CookieServiceLock $bridgeRoot
try {
    $controlPath = Join-Path $PSScriptRoot 'service-control.mjs'
    $stateFile = Join-Path $bridgeRoot 'service-control-state.json'
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
            $running = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)"
            if ($running -and $running.Name -eq 'node.exe' -and $running.CommandLine.Contains($controlPath)) { return }
        } catch {}
    }
    $nodePath = Get-CookieNodePath $bridgeRoot
    $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $controlPath + '"') -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 100
        if (Test-Path -LiteralPath $stateFile) {
            try {
                $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
                if ($state.pid -eq $process.Id) {
                    Write-CookieServiceLog $bridgeRoot "Controller started pid=$($process.Id) port=$($state.port)"
                    return
                }
            } catch {}
        }
        if ($process.HasExited) { throw '本机服务控制器启动失败' }
    }
    throw '本机服务控制器启动超时'
} catch {
    Write-CookieServiceLog $bridgeRoot ('Controller startup failed: ' + $_.Exception.Message)
    throw
} finally { Exit-CookieServiceLock $serviceLock }
