param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string]$ExtensionId = '',
  [string]$PreferencesPath = '',
  [string]$UserDataDir = '',
  [string]$ProfileName = 'Default'
)

$ErrorActionPreference = 'Stop'

function Get-ExtensionIdFromPreferences {
  param(
    [string]$Path,
    [string]$ExtensionPath
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    $preferences = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Host "Skipped unreadable Chrome preferences: $Path"
    return $null
  }

  $settings = $preferences.extensions.settings
  if (-not $settings) {
    return $null
  }

  $expectedExtensionPath = [System.IO.Path]::GetFullPath($ExtensionPath)
  foreach ($property in $settings.PSObject.Properties) {
    $manifest = $property.Value.manifest
    if ($manifest -and $manifest.name -eq 'DeepseekWeb++') {
      return $property.Name
    }

    if ($property.Value.path) {
      $candidateExtensionPath = [System.IO.Path]::GetFullPath($property.Value.path)
      if ($candidateExtensionPath -eq $expectedExtensionPath) {
        return $property.Name
      }
    }
  }
  return $null
}

function Add-PreferencesCandidates {
  param(
    [System.Collections.Generic.List[string]]$Paths,
    [string]$ProfileDir
  )

  if (-not $ProfileDir) {
    return
  }

  [void]$Paths.Add((Join-Path $ProfileDir 'Preferences'))
  [void]$Paths.Add((Join-Path $ProfileDir 'Secure Preferences'))
}

function Get-CandidatePreferencesPaths {
  $paths = [System.Collections.Generic.List[string]]::new()

  if ($PreferencesPath) {
    [void]$paths.Add($PreferencesPath)
  }

  if ($UserDataDir) {
    Add-PreferencesCandidates -ProfileDir (Join-Path $UserDataDir $ProfileName) -Paths $paths
  }

  $systemUserData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  if (Test-Path -LiteralPath $systemUserData) {
    Add-PreferencesCandidates -ProfileDir (Join-Path $systemUserData 'Default') -Paths $paths
    Get-ChildItem -LiteralPath $systemUserData -Directory -Filter 'Profile *' -ErrorAction SilentlyContinue | ForEach-Object {
      Add-PreferencesCandidates -ProfileDir $_.FullName -Paths $paths
    }
  }

  return $paths.ToArray() | Where-Object { $_ } | Select-Object -Unique
}

if (-not $ExtensionId) {
  $extensionPath = Join-Path $ProjectRoot 'extension'
  $checkedPreferencesPaths = @(Get-CandidatePreferencesPaths)
  foreach ($candidate in $checkedPreferencesPaths) {
    $found = Get-ExtensionIdFromPreferences -Path $candidate -ExtensionPath $extensionPath
    if ($found) {
      $ExtensionId = $found
      Write-Host "Found DeepseekWeb++ in Chrome preferences: $candidate"
      break
    }
  }
}

if (-not $ExtensionId) {
  Write-Host 'Checked Chrome preference files:'
  $checkedPreferencesPaths | ForEach-Object {
    Write-Host "  - $_"
  }
  throw 'DeepseekWeb++ extension ID was not found. Load the unpacked extension in the same Chrome profile, rerun this script with -UserDataDir for that profile, or pass -ExtensionId <id>.'
}

& (Join-Path $PSScriptRoot 'install-native-host.ps1') -ProjectRoot $ProjectRoot -ExtensionId $ExtensionId

Write-Host "Synced Native Host allowed origin: chrome-extension://$ExtensionId/"
Write-Host "Open https://chat.deepseek.com/ in the same Chrome profile where the extension is loaded."
