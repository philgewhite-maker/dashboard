# Builds the Dashboard Capture share relay APK.
#
# Everything heavy lives OUTSIDE OneDrive so it isn't synced: the toolchain
# in %LOCALAPPDATA%\dashboard-capture-tools and Gradle's build output in
# %LOCALAPPDATA%\dashboard-capture-build. Only the finished APK is copied
# back, to android-relay\dist\DashboardCapture.apk (gitignored), so OneDrive
# carries it to the phone -- open it from the OneDrive app to install.
#
# The signing key lives in OneDrive\Claude\android-keys, outside the git
# repo (which is public) but backed up. Keep it: an update only installs
# over the existing app if it's signed with the same key.
#
# First run downloads the toolchain, then stops once so you can accept
# Google's Android SDK license yourself (it prompts; answer y):
#   powershell -ExecutionPolicy Bypass -File build.ps1 -AcceptLicenses
# After that, plain runs just build.
param([switch]$ToolsOnly, [switch]$AcceptLicenses)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # PS 5.1's progress bar makes downloads crawl
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectDir = $PSScriptRoot
$tools = Join-Path $env:LOCALAPPDATA 'dashboard-capture-tools'
$jdkDir = Join-Path $tools 'jdk'
$sdkDir = Join-Path $tools 'android-sdk'
$gradleVersion = '8.10.2'
$gradleDir = Join-Path $tools "gradle-$gradleVersion"
$keyDir = Join-Path (Split-Path (Split-Path $projectDir -Parent) -Parent) 'android-keys'
$apkOut = Join-Path $env:LOCALAPPDATA 'dashboard-capture-build\app\outputs\apk\release\app-release.apk'
$distDir = Join-Path $projectDir 'dist'

New-Item -ItemType Directory -Force $tools | Out-Null

function Get-Archive($url, $name) {
	$zip = Join-Path $tools $name
	if (-not (Test-Path $zip)) {
		Write-Host "Downloading $name ..."
		Invoke-WebRequest -Uri $url -OutFile "$zip.part" -UseBasicParsing
		Move-Item "$zip.part" $zip
	}
	return $zip
}

function Expand-To($zip, $dest) {
	New-Item -ItemType Directory -Force $dest | Out-Null
	# Windows' bundled tar handles zips far faster than Expand-Archive.
	tar -xf $zip -C $dest
	if ($LASTEXITCODE -ne 0) { throw "Couldn't extract $zip" }
}

# ---- JDK 17 ------------------------------------------------------------
if (-not (Test-Path (Join-Path $jdkDir 'bin\java.exe'))) {
	$zip = Get-Archive 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' 'temurin-jdk17.zip'
	$tmp = Join-Path $tools 'jdk-extract'
	if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
	Expand-To $zip $tmp
	$inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
	Move-Item $inner.FullName $jdkDir
	Remove-Item -Recurse -Force $tmp
}
$env:JAVA_HOME = $jdkDir
$env:Path = "$jdkDir\bin;$env:Path"

# ---- Android command-line tools ----------------------------------------
$sdkmanager = Join-Path $sdkDir 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
	$zip = Get-Archive 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' 'android-cmdline-tools.zip'
	$tmp = Join-Path $tools 'cmdline-extract'
	if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
	Expand-To $zip $tmp
	New-Item -ItemType Directory -Force (Join-Path $sdkDir 'cmdline-tools') | Out-Null
	Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $sdkDir 'cmdline-tools\latest')
	Remove-Item -Recurse -Force $tmp
}
$env:ANDROID_HOME = $sdkDir

# ---- Gradle ------------------------------------------------------------
if (-not (Test-Path (Join-Path $gradleDir 'bin\gradle.bat'))) {
	$zip = Get-Archive "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" "gradle-$gradleVersion-bin.zip"
	Expand-To $zip $tools
}

# ---- License gate ------------------------------------------------------
# Accepting Google's license is yours to do, not this script's: with
# -AcceptLicenses it shows you the prompts, and you answer them.
if ($AcceptLicenses) {
	& $sdkmanager --sdk_root="$sdkDir" --licenses
}
if (-not (Test-Path (Join-Path $sdkDir 'licenses\android-sdk-license'))) {
	Write-Host ''
	Write-Host 'Toolchain downloaded. One manual step: accept the Android SDK license by running' -ForegroundColor Yellow
	Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -AcceptLicenses" -ForegroundColor Yellow
	exit 2
}

# ---- SDK packages ------------------------------------------------------
if (-not (Test-Path (Join-Path $sdkDir 'platforms\android-35')) -or -not (Test-Path (Join-Path $sdkDir 'build-tools\35.0.0'))) {
	Write-Host 'Installing Android platform 35 and build-tools ...'
	& $sdkmanager --sdk_root="$sdkDir" 'platforms;android-35' 'build-tools;35.0.0'
	if ($LASTEXITCODE -ne 0) { throw 'sdkmanager failed' }
}

if ($ToolsOnly) { Write-Host 'Toolchain ready.'; exit 0 }

# ---- Signing key -------------------------------------------------------
New-Item -ItemType Directory -Force $keyDir | Out-Null
$keystore = Join-Path $keyDir 'dashboard-capture.jks'
$passFile = Join-Path $keyDir 'dashboard-capture.password'
if (-not (Test-Path $keystore)) {
	$bytes = New-Object byte[] 24
	[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
	$pass = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''
	Set-Content -Path $passFile -Value $pass -NoNewline -Encoding ascii
	& (Join-Path $jdkDir 'bin\keytool.exe') -genkeypair -keystore $keystore -alias relay -keyalg RSA -keysize 2048 -validity 10000 -storepass $pass -keypass $pass -dname 'CN=Dashboard Capture'
	if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
$env:RELAY_KEYSTORE = $keystore
$env:RELAY_KEYSTORE_PASSWORD = (Get-Content $passFile -Raw).Trim()

# ---- Build -------------------------------------------------------------
& (Join-Path $gradleDir 'bin\gradle.bat') -p $projectDir --no-daemon --project-cache-dir (Join-Path $tools 'project-cache') assembleRelease
if ($LASTEXITCODE -ne 0) { throw 'Gradle build failed' }

New-Item -ItemType Directory -Force $distDir | Out-Null
Copy-Item $apkOut (Join-Path $distDir 'DashboardCapture.apk') -Force
Write-Host "Built: $(Join-Path $distDir 'DashboardCapture.apk')" -ForegroundColor Green
