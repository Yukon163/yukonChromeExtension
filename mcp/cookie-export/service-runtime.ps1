function Get-CookieBridgeRoot {
    if ($env:YUKON_COOKIE_BRIDGE_HOME) { return [IO.Path]::GetFullPath($env:YUKON_COOKIE_BRIDGE_HOME) }
    $bridgeRoot = Join-Path $env:LOCALAPPDATA 'YukonChromeCookieExport'
    try {
        $config = Get-Content -LiteralPath (Join-Path $bridgeRoot 'service-config.json') -Raw | ConvertFrom-Json
        if ($config.bridge_home -and [IO.Path]::IsPathRooted($config.bridge_home)) { return $config.bridge_home }
    } catch {}
    return $bridgeRoot
}

function Enter-CookieServiceLock([string]$BridgeRoot) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($BridgeRoot).ToLowerInvariant()))
        $name = 'Local\YukonCookieService-' + ([BitConverter]::ToString($digest).Replace('-', ''))
    } finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, $name)
    try {
        try { $acquired = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another Cookie service operation is still running; retry shortly' }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}

function Exit-CookieServiceLock($Mutex) {
    try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }
}

function Get-CookieNodePath([string]$BridgeRoot) {
    try { $config = Get-Content -LiteralPath (Join-Path $BridgeRoot 'service-config.json') -Raw | ConvertFrom-Json }
    catch { throw 'Cannot read Cookie service configuration; run install.ps1 again' }
    if ($config.node_path) {
        if (-not [IO.Path]::IsPathRooted($config.node_path) -or -not (Test-Path -LiteralPath $config.node_path -PathType Leaf)) {
            throw 'Configured Node executable is missing; run install.ps1 again'
        }
        return $config.node_path
    }
    return (Get-Command node -ErrorAction Stop).Source
}

function Write-CookieServiceLog([string]$BridgeRoot, [string]$Message) {
    # Log only caller-supplied lifecycle messages, never config contents or child stderr.
    try {
        $logPath = Join-Path $BridgeRoot 'service-start.log'
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
            Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
        }
        [IO.File]::AppendAllText($logPath, ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    } catch { Write-Warning 'Could not write Cookie service startup log' }
}
