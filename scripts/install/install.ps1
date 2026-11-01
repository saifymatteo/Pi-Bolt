# Installs the compiled Pi-Bolt runtime from this fork's pi-native-v* releases.
# Installs only pi-bolt: the original Node `pi` command and its files are never touched.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Tag pi-native-v1.0.9]
# `pi-bolt update` runs this with PIBOLT_VERSION (the tag), PIBOLT_INSTALL, PIBOLT_VARIANT, PIBOLT_BIN_DIR,
# PIBOLT_NO_PATH and PIBOLT_YES set; all are honored here.
param([string]$Tag = "", [switch]$NoPathUpdate)
$ErrorActionPreference = 'Stop'

$Repo = 'saifymatteo/Pi-Bolt'
$Variant = if ($env:PIBOLT_VARIANT) { $env:PIBOLT_VARIANT } else { 'x64-jit' }
$InstallDir = if ($env:PIBOLT_INSTALL) { $env:PIBOLT_INSTALL } elseif ($env:PIBOLT_INSTALL_DIR) { $env:PIBOLT_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.pi-bolt' }
$BinDir = if ($env:PIBOLT_BIN_DIR) { $env:PIBOLT_BIN_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }
$Archive = "pi-bolt-win32-$Variant.zip"
$VariantDir = Join-Path $InstallDir "pi-bolt-win32-$Variant"

if (-not $Tag) { $Tag = $env:PIBOLT_VERSION }
if (-not $Tag) {
	# The release marked Latest, from its redirect: GitHub's API rate-limits shared addresses.
	$request = [System.Net.WebRequest]::Create("https://github.com/$Repo/releases/latest")
	$request.AllowAutoRedirect = $false
	$response = $request.GetResponse()
	$Tag = ($response.Headers['Location'] -split '/tag/')[-1]
	$response.Close()
	if (-not $Tag) { throw 'could not resolve the latest pi-native-v* release' }
}
Write-Host "Installing $Tag"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-bolt-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
	$base = "https://github.com/$Repo/releases/download/$Tag"
	$sums = Join-Path $tmp 'SHA256SUMS'
	& curl.exe -fsSL -o $sums "$base/SHA256SUMS"
	if ($LASTEXITCODE -ne 0) { throw 'could not download SHA256SUMS' }
	$line = (Get-Content $sums | Where-Object { $_ -match [regex]::Escape("  $Archive") } | Select-Object -First 1)
	if (-not $line) { throw "$Tag does not list $Archive" }
	$expected = ($line.TrimStart() -split '\s+')[0].ToLowerInvariant()
	$zip = Join-Path $tmp $Archive
	& curl.exe -fsSL -o $zip "$base/$Archive"
	if ($LASTEXITCODE -ne 0) { throw "could not download $Archive" }
	# .NET hashing directly: Get-FileHash needs a module this environment may not load.
	$sha256 = [System.Security.Cryptography.SHA256]::Create()
	try {
		$hash = (($sha256.ComputeHash([System.IO.File]::ReadAllBytes($zip)) | ForEach-Object { $_.ToString('x2') }) -join '')
	} finally { $sha256.Dispose() }
	if ($hash -ne $expected) { throw 'checksum mismatch: the download is corrupt or incomplete' }

	$unpacked = Join-Path $tmp 'unpacked'
	New-Item -ItemType Directory -Force $unpacked | Out-Null
	& tar.exe -xf $zip -C $unpacked
	if ($LASTEXITCODE -ne 0) { throw 'could not unpack the archive' }
	$build = Join-Path $unpacked "pi-bolt-win32-$Variant"
	$exe = Join-Path $build 'pi.exe'
	if (-not (Test-Path $exe)) { throw "the archive does not have pi-bolt-win32-$Variant\pi.exe" }
	& $exe --version *> $null
	if ($LASTEXITCODE -ne 0) { throw 'the downloaded executable does not run on this system' }

	New-Item -ItemType Directory -Force $InstallDir | Out-Null
	if (Test-Path $VariantDir) {
		# The build an install replaces is kept beside the new one as <folder>.previous (`pi-bolt update --rollback`).
		$previous = "$VariantDir.previous"
		if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
		Copy-Item $VariantDir $previous -Recurse
		Remove-Item $VariantDir -Recurse -Force
	}
	Copy-Item $build $VariantDir -Recurse
	# The earlier fork layout (%LOCALAPPDATA%\pi-bolt\pi-native) is ours alone; remove it once the new one is in place.
	$legacy = Join-Path $env:LOCALAPPDATA 'pi-bolt\pi-native'
	if ((Test-Path $legacy) -and ($InstallDir -ne (Join-Path $env:LOCALAPPDATA 'pi-bolt'))) {
		Remove-Item (Split-Path $legacy) -Recurse -Force
		Write-Host 'removed the previous fork install at %LOCALAPPDATA%\pi-bolt'
	}

	New-Item -ItemType Directory -Force $BinDir | Out-Null
	# A shim, not a copy: updates replace the runtime, the shim keeps working.
	Set-Content -LiteralPath (Join-Path $BinDir 'pi-bolt.cmd') -Encoding Ascii -Value (
		"@echo off`r`n`"$exe`" %*`r`nexit /b %errorlevel%`r`n")

	if (-not ($NoPathUpdate -or $env:PIBOLT_NO_PATH)) {
		$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		if ($userPath -notlike "*$BinDir*") {
			[Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
			Write-Host "added $BinDir to your user PATH; open a new terminal for it"
		}
	}

	& $exe --version
	Write-Host "Installed. Run: pi-bolt (new terminal, or $(Join-Path $BinDir 'pi-bolt.cmd'))"
} finally {
	Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
