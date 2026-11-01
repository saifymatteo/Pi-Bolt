# Installs the compiled Pi-Bolt runtime from the fork's pi-native-v* releases.
# Installs only pi-bolt: the original Node `pi` command and its files are never touched.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Tag pi-native-v1.0.9-trial.2]
#Requires -Version 5.1
param(
	[string]$Tag,
	[string]$InstallDir = "$env:LOCALAPPDATA\pi-bolt",
	[string]$BinDir = "$env:USERPROFILE\.local\bin",
	[switch]$NoPathUpdate
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = 'saifymatteo/Pi-Bolt'
$Headers = @{ 'User-Agent' = 'pi-bolt-installer' }

if (-not $Tag) {
	$releases = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers $Headers
	$release = $releases | Where-Object { $_.tag_name -like 'pi-native-v*' -and -not $_.draft } | Select-Object -First 1
	if (-not $release) { throw "no pi-native-v* release found in $Repo" }
	$Tag = $release.tag_name
} else {
	$release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $Headers
}
if ($release.assets.name -notcontains 'pi-native-win32-x64.tar.gz') { throw "$Tag has no Windows archive" }
Write-Host "Installing $Tag"

$tmp = Join-Path ([IO.Path]::GetTempPath()) "pi-bolt-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
	$base = "https://github.com/$Repo/releases/download/$Tag"
	Invoke-WebRequest "$base/pi-native-win32-x64.tar.gz" -OutFile "$tmp\pi.tar.gz" -Headers $Headers
	Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS" -Headers $Headers
	$line = Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match '^([0-9a-f]{64})\s+pi-native-win32-x64\.tar\.gz' }
	if (-not $line) { throw 'SHA256SUMS has no Windows entry' }
	$expected = ($line -split '\s+')[0]
	$sha = [System.Security.Cryptography.SHA256]::Create()
	try { $digest = $sha.ComputeHash([IO.File]::ReadAllBytes("$tmp\pi.tar.gz")) } finally { $sha.Dispose() }
	$actual = ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
	if ($actual -ne $expected) { throw 'checksum mismatch: refusing to install' }

	if (Test-Path $InstallDir) {
		$old = "$InstallDir.old-$(Get-Date -Format yyyyMMddHHmmss)"
		Move-Item $InstallDir $old
		Write-Host "the previous install is in $old"
	}
	New-Item -ItemType Directory -Force $InstallDir | Out-Null
	# Prefer Windows' bsdtar: GNU tar (e.g. Git's on PATH) treats C:\ paths as remote hosts.
	$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
	if (-not (Test-Path $tar)) { $tar = 'tar' }
	& $tar -xzf "$tmp\pi.tar.gz" -C $InstallDir
	if ($LASTEXITCODE -ne 0) { throw 'tar extraction failed' }
} finally {
	Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$launcher = Join-Path $InstallDir 'pi-native\pi-bolt.cmd'
if (-not (Test-Path $launcher)) { throw "extracted archive is missing pi-bolt.cmd" }
New-Item -ItemType Directory -Force $BinDir | Out-Null
# A shim, not a copy: updates replace the runtime, the shim keeps working.
Set-Content -LiteralPath "$BinDir\pi-bolt.cmd" -Encoding Ascii -Value (
	"@echo off`r`n`"$launcher`" %*`r`nexit /b %errorlevel%`r`n")

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $NoPathUpdate -and $userPath -notlike "*$BinDir*") {
	[Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
	Write-Host "added $BinDir to your user PATH; open a new terminal for it"
}

& $launcher --version
Write-Host "Installed. Run: pi-bolt (new terminal, or $BinDir\pi-bolt.cmd)"
