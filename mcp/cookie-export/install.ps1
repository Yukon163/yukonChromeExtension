param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$ChromeUserData = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    [switch]$DiscoverOnly
)
& (Join-Path $PSScriptRoot 'install-service.ps1') @PSBoundParameters
