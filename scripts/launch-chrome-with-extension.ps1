param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string]$ChromePath = 'C:\Users\Administrator\AppData\Local\Google\Chrome\Application\chrome.exe',
  [string]$UserDataDir = '',
  [int]$RemoteDebuggingPort = 0
)

$ErrorActionPreference = 'Stop'

$extensionPath = Join-Path $ProjectRoot 'extension'
$logPath = Join-Path $ProjectRoot '.chrome-deepseekwebpp.log'

if (-not (Test-Path -LiteralPath $ChromePath)) {
  throw "Google Chrome was not found: $ChromePath"
}

Set-Clipboard -Value $extensionPath

$arguments = @(
  '--enable-logging',
  "--log-file=$logPath",
  'chrome://extensions/'
)

if ($UserDataDir) {
  New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
  $arguments = @("--user-data-dir=$UserDataDir", '--no-first-run') + $arguments
}

if ($RemoteDebuggingPort -gt 0) {
  $arguments = @("--remote-debugging-port=$RemoteDebuggingPort") + $arguments
}

Start-Process -FilePath $ChromePath -ArgumentList $arguments -WindowStyle Normal

Write-Host "Chrome started for extension install."
Write-Host "Extension path copied to clipboard: $extensionPath"
if ($UserDataDir) {
  Write-Host "Profile: $UserDataDir"
  Write-Host "After loading, run scripts\sync-native-host-origin.ps1 -UserDataDir `"$UserDataDir`""
} else {
  Write-Host "Profile: current Chrome profile"
  Write-Host "After loading, run scripts\sync-native-host-origin.ps1 or pass the extension ID to scripts\install-native-host.ps1 -ExtensionId <id>."
}
Write-Host "Chrome: $ChromePath"
if ($RemoteDebuggingPort -gt 0) {
  Write-Host "Debug: http://127.0.0.1:$RemoteDebuggingPort/json"
}
Write-Host "Log: $logPath"
Write-Host "In chrome://extensions: enable Developer mode, click Load unpacked, paste the copied path."
Write-Host "If Chrome opens another profile, copy the extension ID from chrome://extensions and pass -ExtensionId <id>."
