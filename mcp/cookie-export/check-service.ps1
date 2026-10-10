param([string]$BridgeHome)
$ErrorActionPreference = 'Stop'
if ($BridgeHome) {
    if (-not [IO.Path]::IsPathRooted($BridgeHome)) { throw 'The Cookie service directory must be absolute' }
    $env:YUKON_COOKIE_BRIDGE_HOME = $BridgeHome
}
try {
    & (Join-Path $PSScriptRoot 'start-service.ps1') | Out-Null
} catch {
    # Catch failures that happen before the startup script can initialize its own logger.
    $bridgeRoot = if ($env:YUKON_COOKIE_BRIDGE_HOME) { $env:YUKON_COOKIE_BRIDGE_HOME } else { Join-Path $env:LOCALAPPDATA 'YukonChromeCookieExport' }
    try {
        $logPath = Join-Path $bridgeRoot 'service-start.log'
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
            Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
        }
        $line = [DateTime]::UtcNow.ToString('o') + ' Scheduled check failed: ' + $_.Exception.Message + [Environment]::NewLine
        [IO.File]::AppendAllText($logPath, $line, (New-Object Text.UTF8Encoding($false)))
    } catch {}
    exit 1
}
