param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string[]]$Architectures = @(),
  [string]$Version
)

$ErrorActionPreference = 'Stop'

$sourceDir = Join-Path $ProjectRoot 'native-host-go'
$output = Join-Path $ProjectRoot 'native-host\deepseekwebpp-host.exe'

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw 'Go is required to build the native host exe.'
}

$packageJson = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = if ($Version) { $Version } else { $packageJson.version }
$ldflags = "-s -w -buildid= -X main.appVersion=$version"

function Invoke-GoBuild {
  param(
    [string]$OutputPath
  )

  $arguments = @('build', '-trimpath', '-buildvcs=false', '-ldflags', $ldflags, '-o', $OutputPath, '.')
  & go @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "go build failed with exit code $LASTEXITCODE"
  }
}

Push-Location $sourceDir
try {
  if ($Architectures.Count -eq 0) {
    Invoke-GoBuild -OutputPath $output
    Write-Host "Built native host exe: $output"
  } else {
    $oldGoos = $env:GOOS
    $oldGoarch = $env:GOARCH
    $oldCgo = $env:CGO_ENABLED
    try {
      foreach ($arch in $Architectures) {
        $env:GOOS = 'windows'
        $env:GOARCH = $arch
        $env:CGO_ENABLED = '0'
        $archDir = Join-Path $ProjectRoot "native-host\bin\windows-$arch"
        New-Item -ItemType Directory -Force -Path $archDir | Out-Null
        $archOutput = Join-Path $archDir 'deepseekwebpp-host.exe'
        Invoke-GoBuild -OutputPath $archOutput
        Write-Host "Built native host exe ($arch): $archOutput"
      }
    } finally {
      $env:GOOS = $oldGoos
      $env:GOARCH = $oldGoarch
      $env:CGO_ENABLED = $oldCgo
    }
  }
} finally {
  Pop-Location
}
