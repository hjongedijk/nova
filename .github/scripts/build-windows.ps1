param([string]$Version = '')
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
Push-Location (Join-Path $root 'apps/windows')
try {
  $releaseVersion = if ($Version) { $Version.TrimStart('v') } else { '0.1.0' }
  if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
  $override = Join-Path (Get-Location) 'release-config.json'
  $signedRelease = [bool]$Version
  if ($signedRelease -and -not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw 'Configure the TAURI_SIGNING_PRIVATE_KEY repository secret before publishing Windows updates'
  }
  @{ version = $releaseVersion; bundle = @{ createUpdaterArtifacts = $signedRelease } } | ConvertTo-Json -Depth 4 | Set-Content $override
  # Cached targets can retain an installer for an older version.
  Remove-Item target/release/bundle/nsis -Recurse -Force -ErrorAction SilentlyContinue
  # Use the prebuilt pinned CLI; compiling the bundler from source is unnecessary.
  npx --yes --package @tauri-apps/cli@2.12.0 tauri build --config $override --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw 'Windows app or installer build failed' }
  $outputDirectory = Join-Path $root 'windows-out'
  New-Item -ItemType Directory -Force $outputDirectory | Out-Null
  Remove-Item (Join-Path $outputDirectory 'NOVA-Setup-*.exe*') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $outputDirectory 'latest.json') -Force -ErrorAction SilentlyContinue
  Copy-Item target/release/nova.exe (Join-Path $outputDirectory 'nova.exe')
  $installer = @(Get-ChildItem target/release/bundle/nsis/*.exe)
  if ($installer.Count -ne 1) { throw 'Expected exactly one NOVA installer' }
  $installerName = "NOVA-Setup-$releaseVersion.exe"
  Copy-Item $installer[0].FullName (Join-Path $outputDirectory $installerName)
  if ($signedRelease) {
    $signaturePath = "$($installer[0].FullName).sig"
    if (-not (Test-Path $signaturePath)) { throw 'Signed Windows update is missing its signature' }
    $signature = (Get-Content $signaturePath -Raw).Trim()
    if (-not $signature) { throw 'Update signature is empty' }
    Copy-Item $signaturePath (Join-Path $outputDirectory "$installerName.sig")
    node (Join-Path $root 'scripts/windows-update-manifest.mjs') $releaseVersion $signaturePath (Join-Path $outputDirectory 'latest.json')
    if ($LASTEXITCODE -ne 0) { throw 'Windows update manifest generation failed' }
  }
  Compress-Archive -Path (Join-Path $outputDirectory 'nova.exe') -DestinationPath (Join-Path $outputDirectory 'nova-windows.zip') -Force
} finally {
  Remove-Item release-config.json -ErrorAction SilentlyContinue
  Pop-Location
}
