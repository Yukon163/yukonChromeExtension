$ErrorActionPreference = 'Stop'
$bridgeRoot = if ($env:YUKON_COOKIE_BRIDGE_HOME) { $env:YUKON_COOKIE_BRIDGE_HOME } else { Join-Path $env:LOCALAPPDATA 'YukonChromeCookieExport' }
$controlPath = Join-Path $PSScriptRoot 'service-control.mjs'
$stateFile = Join-Path $bridgeRoot 'service-control-state.json'
if (Test-Path -LiteralPath $stateFile) {
    try {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $running = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)"
        if ($running -and $running.Name -eq 'node.exe' -and $running.CommandLine.Contains($controlPath)) { return }
    } catch {}
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $controlPath + '"') -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
            if ($state.pid -eq $process.Id) { return }
        } catch {}
    }
    if ($process.HasExited) { throw '本机服务控制器启动失败' }
}
throw '本机服务控制器启动超时'
