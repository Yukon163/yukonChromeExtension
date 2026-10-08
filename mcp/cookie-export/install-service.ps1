param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$ChromeUserData = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    [switch]$DiscoverOnly
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$bridgeRoot = Join-Path $env:LOCALAPPDATA 'YukonChromeCookieExport'
if (-not $ExtensionId) {
    $foundIds = @()
    if (Test-Path -LiteralPath $ChromeUserData) {
        foreach ($profileDir in Get-ChildItem -LiteralPath $ChromeUserData -Directory) {
            foreach ($preferencesName in @('Secure Preferences', 'Preferences')) {
                $preferencesFile = Join-Path $profileDir.FullName $preferencesName
                if (-not (Test-Path -LiteralPath $preferencesFile)) { continue }
                try { $preferences = Get-Content -LiteralPath $preferencesFile -Raw | ConvertFrom-Json } catch { continue }
                foreach ($extensionEntry in $preferences.extensions.settings.PSObject.Properties) {
                    if ($extensionEntry.Name -notmatch '^[a-p]{32}$' -or -not $extensionEntry.Value.path) { continue }
                    try { $installedPath = [IO.Path]::GetFullPath($extensionEntry.Value.path) } catch { continue }
                    if ($installedPath.TrimEnd('\') -eq $sourceRoot.TrimEnd('\')) { $foundIds += $extensionEntry.Name }
                }
            }
        }
    }
    $foundIds = @($foundIds | Sort-Object -Unique)
    if ($foundIds.Count -eq 1) { $ExtensionId = $foundIds[0] }
    else { throw '无法唯一定位扩展 ID，请传入 -ExtensionId <此扩展的32位ID>' }
}
if ($DiscoverOnly) { Write-Output $ExtensionId; exit 0 }
New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
& icacls.exe $bridgeRoot /inheritance:r /grant:r "*$($currentUser.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法设置本机服务目录访问权限' }
$encoding = New-Object Text.UTF8Encoding($false)
$configFile = Join-Path $bridgeRoot 'service-config.json'
$extensionConfig = Join-Path $sourceRoot 'cookie-bridge-config.json'
$token = ''
if (Test-Path -LiteralPath $configFile) {
    try { $token = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).token } catch {}
}
if ($token -notmatch '^[a-f0-9]{64}$') {
    $randomBytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($randomBytes)
    $generator.Dispose()
    $token = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
}
$config = @{token=$token; allowed_origins=@("chrome-extension://$ExtensionId/"); extension_config=$extensionConfig}
[IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json), $encoding)
if (-not (Test-Path -LiteralPath $extensionConfig)) { [IO.File]::WriteAllText($extensionConfig, '{}', $encoding) }
& icacls.exe $extensionConfig /inheritance:r /grant:r "*$($currentUser.Value):F" '*S-1-5-18:F' /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护扩展的本机连接令牌' }
$startPath = Join-Path $PSScriptRoot 'start-service.ps1'
$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
try {
    $command = '"' + $powerShellPath + '" -NoProfile -WindowStyle Hidden -File "' + $startPath + '"'
    $runKey.SetValue('YukonChromeCookieExport', $command, [Microsoft.Win32.RegistryValueKind]::String)
} finally { $runKey.Close() }

# 清理本安装器此前写入的宿主注册项，不触碰其他 Native Messaging 应用。
$legacySubkey = 'Software\Google\Chrome\NativeMessagingHosts\cn.yukon.chrome_cookie_export'
$legacyPaths = @((Join-Path $bridgeRoot 'cn.yukon.chrome_cookie_export.json'),(Join-Path $env:LOCALAPPDATA 'YukonChromeCookieExportRegistration\cn.yukon.chrome_cookie_export.json'))
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
    try {
        $legacyKey = $baseKey.OpenSubKey($legacySubkey)
        if ($legacyKey) {
            $oldPath = $legacyKey.GetValue('')
            $legacyKey.Close()
            if ($legacyPaths -contains $oldPath) { $baseKey.DeleteSubKey($legacySubkey,$false) }
        }
    } finally { $baseKey.Close() }
}
& $startPath
Write-Output "本机服务已安装并启动，扩展 ID：$ExtensionId"
Write-Output '这次切换连接方式后，请重新加载一次扩展；以后会自动连接。'
