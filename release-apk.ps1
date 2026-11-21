<#
.SYNOPSIS
  Build, sign, and publish an openGym Android sideload release APK to Emir-A/openGym on GitHub.
.EXAMPLE
  .\release-apk.ps1 -Version 1.4.6
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$')]
  [string]$Version,

  [int]$VersionCode = 0,
  [string]$Repo = 'Emir-A/openGym',
  [string]$Keystore = "$HOME\.config\opengym\release.keystore",
  [string]$Alias = 'opengym',
  [string]$StorePass = 'opengym-release',
  [string]$KeyPass = 'opengym-release',
  [string]$Notes = '',
  [switch]$SkipPublish
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Frontend = Join-Path $Root 'frontend'
$Android = Join-Path $Frontend 'android'
$ReleaseDir = Join-Path $Root 'release'

if (-not (Test-Path $Keystore)) {
  throw "Keystore not found at $Keystore. Create it first with keytool."
}

$JavaHome = @($env:JAVA_HOME, 'C:\Program Files\Android\Android Studio1\jbr', 'C:\Program Files\Android\Android Studio\jbr') |
  Where-Object { $_ -and (Test-Path (Join-Path $_ 'bin\java.exe')) } | Select-Object -First 1
if (-not $JavaHome) { throw 'JDK 21+ not found. Set JAVA_HOME or install Android Studio JBR.' }
$env:JAVA_HOME = $JavaHome

$AndroidHome = @($env:ANDROID_HOME, "$env:LOCALAPPDATA\Android\Sdk") |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $AndroidHome) { throw 'Android SDK not found. Set ANDROID_HOME.' }
$env:ANDROID_HOME = $AndroidHome
$env:PATH = "$JavaHome\bin;$AndroidHome\platform-tools;$env:PATH"

$BuildTools = Get-ChildItem (Join-Path $AndroidHome 'build-tools') | Sort-Object Name | Select-Object -Last 1
if (-not $BuildTools) { throw "No Android build-tools found under $AndroidHome\build-tools." }
$BtDir = $BuildTools.FullName

# 1. Bump version in frontend/package.json and frontend/android/app/build.gradle
$PkgPath = Join-Path $Frontend 'package.json'
$pkgText = [System.IO.File]::ReadAllText($PkgPath)
$pkgObj = $pkgText | ConvertFrom-Json
if ($pkgObj.version -ne $Version) {
  $pkgText = [regex]::Replace($pkgText, '"version"\s*:\s*"[^"]+"', """version"": ""$Version""", 1)
  [System.IO.File]::WriteAllText($PkgPath, $pkgText, [System.Text.UTF8Encoding]::new($false))
}

$GradlePath = Join-Path $Android 'app\build.gradle'
$gradleText = [System.IO.File]::ReadAllText($GradlePath)
if ($VersionCode -le 0) {
  if ($gradleText -match 'versionCode\s+(\d+)') {
    $currentCode = [int]$Matches[1]
    $VersionCode = if ($pkgObj.version -eq $Version) { $currentCode } else { $currentCode + 1 }
  } else {
    $VersionCode = 1
  }
}
$gradleText = [regex]::Replace($gradleText, 'versionCode\s+\d+', "versionCode $VersionCode", 1)
$gradleText = [regex]::Replace($gradleText, 'versionName\s+"[^"]+"', "versionName ""$Version""", 1)
[System.IO.File]::WriteAllText($GradlePath, $gradleText, [System.Text.UTF8Encoding]::new($false))

Write-Host "==> Building openGym v$Version (versionCode $VersionCode) for $Repo"

# 2. Build mobile bundle & sync Capacitor Android
Push-Location $Frontend
try {
  $env:VITE_MOBILE = '1'
  $env:VITE_HEVIER = '1'
  $env:VITE_UPDATE_REPO = $Repo
  npx vite build
  if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
  node scripts/check-season-clock.mjs dist
  if ($LASTEXITCODE -ne 0) { throw 'check-season-clock failed' }
  node ../scripts/catalogue/stage-media.mjs dist
  if ($LASTEXITCODE -ne 0) { throw 'stage-media failed' }
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { throw 'cap sync android failed' }
  node scripts/check-mobile-bundle.mjs
  if ($LASTEXITCODE -ne 0) { throw 'check-mobile-bundle failed' }
} finally {
  Pop-Location
}

# 3. Assemble release APK
Push-Location $Android
try {
  .\gradlew.bat assembleSideloadRelease --max-workers=2
  if ($LASTEXITCODE -ne 0) { throw 'Gradle assembleSideloadRelease failed' }
} finally {
  .\gradlew.bat --stop -q 2>$null
  Pop-Location
}

# Clean up Capacitor's local gradle path rewrites so git stays clean
git -C $Root checkout -- frontend/android/app/capacitor.build.gradle frontend/android/capacitor.settings.gradle 2>$null

# 4. Align, sign, and hash
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
$Unsigned = Join-Path $Android 'app\build\outputs\apk\sideload\release\app-sideload-release-unsigned.apk'
$Aligned = Join-Path $ReleaseDir 'aligned.apk'
$ApkName = "openGym-$Version.apk"
$ApkPath = Join-Path $ReleaseDir $ApkName
$ShaPath = "$ApkPath.sha256"

& (Join-Path $BtDir 'zipalign.exe') -f -p 4 $Unsigned $Aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }
& (Join-Path $BtDir 'apksigner.bat') sign --ks $Keystore --ks-key-alias $Alias --ks-pass "pass:$StorePass" --key-pass "pass:$KeyPass" --out $ApkPath $Aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }
Remove-Item $Aligned, "$ApkPath.idsig" -ErrorAction SilentlyContinue

$hash = (Get-FileHash $ApkPath -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText($ShaPath, "$hash  $ApkName`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "==> Signed APK: $ApkPath ($hash)"

# 5. Update local Tailscale nginx download if running
$webRunning = docker ps --filter 'name=opengym-web-1' --format '{{.Names}}' 2>$null
if ($webRunning -contains 'opengym-web-1') {
  docker cp $ApkPath opengym-web-1:/usr/share/nginx/html/openGym.apk | Out-Null
  Write-Host '==> Updated https://yoga.adelie-avior.ts.net/openGym.apk'
}

if ($SkipPublish) { return }

# 6. Commit version bump & push to GitHub
$tag = "v$Version"
git -C $Root add frontend/package.json frontend/android/app/build.gradle
$dirtyVer = git -C $Root diff --cached --name-only
if ($dirtyVer) {
  git -C $Root commit -m "chore: release $tag"
  git -C $Root push origin main
}

# 7. Create GitHub Release and upload assets
$token = $env:GITHUB_TOKEN
if (-not $token) {
  $cred = "protocol=https`nhost=github.com`n`n" | git credential fill
  $token = ($cred | Where-Object { $_ -like 'password=*' } | Select-Object -First 1) -replace '^password=', ''
}
if (-not $token) { throw 'No GitHub token found via GITHUB_TOKEN or git credential fill.' }
if (-not $Notes) { $Notes = "openGym $tag sideload release." }

$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' }
$body = @{ tag_name = $tag; name = $tag; body = $Notes; draft = $false; prerelease = $false } | ConvertTo-Json
$rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -ContentType 'application/json' -Body $body
$uploadBase = ($rel.upload_url -replace '\{\?name,label\}$', '')

foreach ($file in @($ApkPath, $ShaPath)) {
  $fname = [System.IO.Path]::GetFileName($file)
  $ctype = if ($fname.EndsWith('.apk')) { 'application/vnd.android.package-archive' } else { 'text/plain' }
  $u = "${uploadBase}?name=$([uri]::EscapeDataString($fname))"
  Write-Host "==> Uploading $fname to GitHub release $tag..."
  curl.exe --fail-with-body -sS -X POST -H "Authorization: Bearer $token" -H "Content-Type: $ctype" --data-binary "@$file" $u | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload $fname" }
}

Write-Host "==> Published: https://github.com/$Repo/releases/tag/$tag"
