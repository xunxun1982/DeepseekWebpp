param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string]$OutputRoot = (Join-Path $ProjectRoot 'dist'),
  [string]$Version
)

$ErrorActionPreference = 'Stop'

$packageJson = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = if ($Version) { $Version } else { $packageJson.version }
$packageName = "DeepseekWebpp-$version"
$staging = Join-Path $OutputRoot $packageName
$zipPath = Join-Path $OutputRoot "$packageName.zip"

$outputFull = [System.IO.Path]::GetFullPath($OutputRoot)
$stagingFull = [System.IO.Path]::GetFullPath($staging)
if (-not $stagingFull.StartsWith($outputFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean a path outside output root: $stagingFull"
}
$zipFull = [System.IO.Path]::GetFullPath($zipPath)
if (-not $zipFull.StartsWith($outputFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean a zip path outside output root: $zipFull"
}

& (Join-Path $ProjectRoot 'scripts\build-native-host-exe.ps1') -ProjectRoot $ProjectRoot -Version $version
& (Join-Path $ProjectRoot 'scripts\build-native-host-exe.ps1') -ProjectRoot $ProjectRoot -Architectures @('amd64', '386') -Version $version

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
if (Test-Path -LiteralPath $staging) {
  Remove-Item -LiteralPath $staging -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Force -Path $staging | Out-Null

$dirs = @('extension', 'native-host', 'scripts')
foreach ($dir in $dirs) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $dir) -Destination (Join-Path $staging $dir) -Recurse
}

foreach ($file in @('README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $file) -Destination (Join-Path $staging $file)
}

$devOnly = @(
  'native-host\node_modules',
  'native-host\package-lock.json'
)
foreach ($relative in $devOnly) {
  $target = Join-Path $staging $relative
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

$hostManifestPath = Join-Path $staging 'native-host\com.deepseekwebpp.native_host.json'
$hostManifest = Get-Content -LiteralPath $hostManifestPath -Raw | ConvertFrom-Json
$hostManifest.path = 'deepseekwebpp-host.exe'
$json = $hostManifest | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($hostManifestPath, $json, $utf8NoBom)

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $zipPath)) {
  throw "Package zip was not created: $zipPath"
}

Write-Host "Package directory: $staging"
Write-Host "Package zip: $zipPath"
