$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-runtime.ps1')
$bridgeRoot = Get-CookieBridgeRoot
$configPath = Join-Path $bridgeRoot 'service-config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$nodePath = (Get-Command node -ErrorAction Stop).Source
# MSIX can redirect AppData writes. Resolve the physical directory before registering
# a task, which runs outside the installing app's filesystem redirection context.
$physicalHome = & $nodePath -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' $bridgeRoot
if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathRooted($physicalHome)) { throw 'Cannot resolve the Cookie service directory' }
$config | Add-Member -NotePropertyName node_path -NotePropertyValue $nodePath -Force
$config | Add-Member -NotePropertyName bridge_home -NotePropertyValue $physicalHome -Force
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))

$taskName = 'YukonChromeCookieExport'
$currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$startPath = Join-Path $PSScriptRoot 'start-silent.js'
$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$scriptHostPath = (Get-Command wscript.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $scriptHostPath -Argument ('//B //Nologo //E:JScript "' + $startPath + '" "' + $powerShellPath + '" "' + $physicalHome + '"') -WorkingDirectory $PSScriptRoot
$logon = New-ScheduledTaskTrigger -AtLogOn -User $currentUserName
$logon.Delay = 'PT15S'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $currentUserName -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $logon -Settings $settings -Principal $principal -Description 'Start the local Cookie bridge and restart controller once when the current user logs on.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

# Migrate the startup entry only after Task Scheduler registration succeeds.
$runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
if ($runKey) {
    try { $runKey.DeleteValue('YukonChromeCookieExport', $false) } finally { $runKey.Close() }
}
Write-Output '本机服务登录启动已启用：登录后启动一次，不进行周期检查或自动恢复。'
