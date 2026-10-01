$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }
function Check($what) {
  if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" }
}

$confPath = Join-Path $root "src-tauri\tauri.conf.json"
$version = ([IO.File]::ReadAllText($confPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json).version
if (-not $version) { throw "tauri.conf.json の version が空です。" }

Step "test"
& npm.cmd test
Check "npm test"

Step "dist"
& npm.cmd run dist
Check "npm run dist"

$nsis = Join-Path $root "src-tauri\target\release\bundle\nsis"
$found = @()
if (Test-Path $nsis) {
  $found = @(Get-ChildItem -Path $nsis -Filter "*-setup.exe" -File)
}
if ($found.Count -ne 1) {
  throw "セットアップ exe は 1 つである必要があります（$nsis に $($found.Count) 個）。"
}

$release = Join-Path $root "release"
$stage = Join-Path $release "_stage"
$setupName = "LexCrew-Doc-Setup-$version.exe"
$zipName = "LexCrew-Doc-$version.zip"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item $found[0].FullName (Join-Path $stage $setupName)

$bom = New-Object System.Text.UTF8Encoding $true
$guidePath = Join-Path $root "scripts\install-guide.ja.txt"
$guide = ([IO.File]::ReadAllText($guidePath, [Text.UTF8Encoding]::new($false))).Replace("{VERSION}", $version)
$zipDir = Join-Path $stage "zip"
New-Item -ItemType Directory -Force -Path $zipDir | Out-Null
Copy-Item (Join-Path $stage $setupName) (Join-Path $zipDir $setupName)
[IO.File]::WriteAllText((Join-Path $zipDir "INSTALL.txt"), $guide, $bom)
Compress-Archive -Path (Join-Path $zipDir "*") -DestinationPath (Join-Path $stage $zipName)

New-Item -ItemType Directory -Force -Path $release | Out-Null
Move-Item (Join-Path $stage $setupName) (Join-Path $release $setupName) -Force
Move-Item (Join-Path $stage $zipName) (Join-Path $release $zipName) -Force
Remove-Item $stage -Recurse -Force

Write-Host "created $(Join-Path $release $setupName)"
Write-Host "created $(Join-Path $release $zipName)"
