$ErrorActionPreference = "Stop"

$packageName = "nausicaa-harness"
$defaultVersion = "__NAUSICAA_DEFAULT_VERSION__"
$version = $env:NAUSICAA_VERSION
$registry = if ([string]::IsNullOrWhiteSpace($env:NAUSICAA_NPM_REGISTRY)) {
  "https://registry.npmjs.org"
} else {
  $env:NAUSICAA_NPM_REGISTRY.TrimEnd("/")
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand -or $null -eq $npmCommand) {
  throw "Nausicaa requires Node.js >=22.19.0 and npm. Install Node.js from https://nodejs.org/ and run this installer again."
}

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.(\d+)\.') {
  throw "Could not parse Node.js version: $nodeVersion"
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 19)) {
  throw "Nausicaa requires Node.js >=22.19.0; found $nodeVersion."
}

if ([string]::IsNullOrWhiteSpace($version) -and $defaultVersion -ne "__NAUSICAA_DEFAULT_VERSION__") {
  $version = $defaultVersion
}
if ([string]::IsNullOrWhiteSpace($version)) {
  $version = (& npm view $packageName version --registry $registry).Trim()
}
if ($version -notmatch '^[0-9A-Za-z.-]+$') {
  throw "Invalid Nausicaa version: $version"
}

Write-Host "Installing $packageName@$version with Node.js $nodeVersion..."
& npm install --global --omit=dev --registry $registry "$packageName@$version"
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed with exit code $LASTEXITCODE"
}
Write-Host ""
Write-Host "Nausicaa $version is installed. Run: nausicaa --help"
