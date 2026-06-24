param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string]$ExtensionId = ''
)

$ErrorActionPreference = 'Stop'

$hostName = 'com.deepseekwebpp.native_host'
$manifestPath = Join-Path $ProjectRoot 'native-host\com.deepseekwebpp.native_host.json'
$nativeHostDir = Join-Path $ProjectRoot 'native-host'
$exePath = Join-Path $nativeHostDir 'deepseekwebpp-host.exe'
$cmdPath = Join-Path $ProjectRoot 'native-host\deepseekwebpp-host.cmd'

function Get-NativeHostCandidatePaths {
  $processor = [string]$env:PROCESSOR_ARCHITECTURE
  if ($processor -match 'ARM64') {
    return @(
      'bin\windows-arm64\deepseekwebpp-host.exe',
      'bin\windows-amd64\deepseekwebpp-host.exe',
      'deepseekwebpp-host.exe'
    )
  }
  if ([Environment]::Is64BitOperatingSystem) {
    return @(
      'bin\windows-amd64\deepseekwebpp-host.exe',
      'deepseekwebpp-host.exe',
      'bin\windows-386\deepseekwebpp-host.exe'
    )
  }
  return @(
    'bin\windows-386\deepseekwebpp-host.exe',
    'deepseekwebpp-host.exe'
  )
}

$hostPath = $null
foreach ($candidate in Get-NativeHostCandidatePaths) {
  if (Test-Path -LiteralPath (Join-Path $nativeHostDir $candidate)) {
    $hostPath = $candidate
    break
  }
}

if ($hostPath) {
  # Windows Native Messaging allows a host path relative to the manifest file.
} elseif (Test-Path -LiteralPath $cmdPath) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Native host exe was not found and Node.js is not available for the development cmd fallback.'
  }
  $hostPath = 'deepseekwebpp-host.cmd'
} else {
  throw "Native host launcher not found: $exePath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.path = $hostPath
if ($ExtensionId) {
  $manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
}
$json = $manifest | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $json, $utf8NoBom)

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestPath

Write-Host "Registered $hostName"
Write-Host "Manifest: $manifestPath"
Write-Host "Host: $hostPath"
Write-Host "Allowed origins: $($manifest.allowed_origins -join ', ')"
