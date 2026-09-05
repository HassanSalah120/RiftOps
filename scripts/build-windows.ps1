param(
    [string]$Version = "",
    [int]$Build = 1,
    [switch]$SkipTests,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = (Get-Content -Raw -LiteralPath (Join-Path $Root "VERSION")).Trim()
}
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "VERSION is empty. Pass -Version explicitly."
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
    throw "Windows resource versions must contain three or four numeric components. Got '$Version'."
}
if ($Build -lt 1 -or $Build -gt 65535) {
    throw "Build must be between 1 and 65535."
}
$VersionParts = $Version.Split('.')
foreach ($VersionPart in $VersionParts) {
    if ([int]$VersionPart -gt 65535) {
        throw "Each Windows version component must be between 0 and 65535."
    }
}
$FileVersion = if ($VersionParts.Count -eq 3) { "$Version.$Build" } else { $Version }

$GoWinres = (Get-Command go-winres -ErrorAction SilentlyContinue).Source
if (-not $GoWinres) {
    $GoWinres = Join-Path $env:USERPROFILE "go\bin\go-winres.exe"
}
if (-not (Test-Path -LiteralPath $GoWinres)) {
    throw "go-winres is required. Run: go install github.com/tc-hib/go-winres@v0.3.3"
}
$Gcc = Get-Command gcc -ErrorAction SilentlyContinue
if (-not $Gcc) {
    $KnownGccPaths = @(
        "C:\ProgramData\mingw64\mingw64\bin\gcc.exe",
        "C:\mingw64\bin\gcc.exe",
        "C:\msys64\ucrt64\bin\gcc.exe",
        "C:\msys64\mingw64\bin\gcc.exe"
    )
    $GccPath = $KnownGccPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($GccPath) {
        $env:PATH = (Split-Path -Parent $GccPath) + ";" + $env:PATH
        $Gcc = Get-Command gcc -ErrorAction SilentlyContinue
    }
}
if (-not $Gcc) {
    throw "GCC/MinGW is required. Open an Administrator PowerShell, run 'choco install mingw --no-progress -y', then reopen PowerShell."
}
$env:CGO_ENABLED = "1"

Push-Location $Root
try {
    $GeneratedFiles = @(
        "cmd/riftops-ui/fyne_metadata_init.go",
        "cmd/riftops-ui/fyne.syso",
        "cmd/riftops-ui/FyneApp.ico",
        "cmd/riftops-ui/riftops-ui.exe.manifest",
        "cmd/riftops-ui/RiftOps.exe"
    )
    foreach ($GeneratedFile in $GeneratedFiles) {
        Remove-Item -Force -LiteralPath $GeneratedFile -ErrorAction SilentlyContinue
    }

	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		throw "Node.js/npm is required to build the RiftOps frontend."
	}
	Write-Host "[1/9] Installing the locked frontend dependencies..."
	Push-Location "cmd/riftops-ui/frontend"
	try {
		npm ci --ignore-scripts
		if ($LASTEXITCODE -ne 0) { throw "Frontend dependency install failed." }
		if (-not $SkipTests) {
			Write-Host "[2/9] Linting and testing the frontend..."
			npm run lint
			if ($LASTEXITCODE -ne 0) { throw "Frontend lint failed." }
			npm test
			if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed." }
		}
		Write-Host "[3/9] Building the embedded frontend..."
		npm run build
		if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
	}
	finally {
		Pop-Location
	}

    if (-not $SkipTests) {
		Write-Host "[4/9] Running race-enabled desktop tests..."
		go test -race -tags desktop ./...
        if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
		Write-Host "[5/9] Running go vet..."
		go vet -tags desktop ./...
        if ($LASTEXITCODE -ne 0) { throw "Vet failed." }
    }

	Write-Host "[6/9] Generating Windows resources and compiling the desktop host..."
    & $GoWinres simply `
        --icon "cmd/riftops-ui/app.ico" `
        --manifest gui `
        --product-version $Version `
        --file-version $FileVersion `
        --product-name "RiftOps" `
        --file-description "RiftOps League Companion" `
        --original-filename "RiftOps.exe" `
        --copyright "Copyright (c) 2026 Hassan Salah" `
        --arch amd64 `
        --out "cmd/riftops-ui/rsrc"
    if ($LASTEXITCODE -ne 0) { throw "Windows resource generation failed." }

    $LdFlags = "-s -w -H=windowsgui -X=github.com/HassanSalah120/RiftOps/internal/buildinfo.Version=$Version"
    go build -tags "desktop,release" -trimpath -ldflags $LdFlags -o "cmd/riftops-ui/RiftOps.exe" ./cmd/riftops-ui
    if ($LASTEXITCODE -ne 0) { throw "Windows compilation failed." }

	Write-Host "[7/9] Moving and validating the packaged executable..."
    New-Item -ItemType Directory -Force dist | Out-Null
    if (-not (Test-Path -LiteralPath "cmd/riftops-ui/RiftOps.exe")) {
        throw "Go completed without producing cmd/riftops-ui/RiftOps.exe."
    }
    # This is a portable desktop app, not an installer. Use a release-facing
    # filename so downloads read like a product rather than a compiler target.
    $OutputPath = "dist/RiftOps-$Version-win-x64.exe"
    try {
        Copy-Item -Force -LiteralPath cmd/riftops-ui/RiftOps.exe -Destination $OutputPath -ErrorAction Stop
    } catch [System.IO.IOException] {
        $OutputPath = "dist/RiftOps-$Version-win-x64-copy.exe"
        Copy-Item -Force -LiteralPath cmd/riftops-ui/RiftOps.exe -Destination $OutputPath -ErrorAction Stop
        Write-Warning "The standard output executable is in use. Created $OutputPath instead."
    }

    # PE subsystem 2 is Windows GUI. A console-subsystem binary opens a command
    # window on startup even though the application itself is a WebView host.
    $ExecutableBytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $OutputPath))
    $PeOffset = [System.BitConverter]::ToInt32($ExecutableBytes, 0x3c)
    $OptionalHeaderOffset = $PeOffset + 24
    $Subsystem = [System.BitConverter]::ToUInt16($ExecutableBytes, $OptionalHeaderOffset + 68)
    if ($Subsystem -ne 2) {
        throw "Packaged executable uses PE subsystem $Subsystem instead of Windows GUI (2)."
    }
    $VersionInfo = (Get-Item -LiteralPath $OutputPath).VersionInfo
    if ($VersionInfo.ProductName -ne "RiftOps") {
        throw "Packaged executable is missing the RiftOps product name."
    }
    if ($VersionInfo.FileDescription -ne "RiftOps League Companion") {
        throw "Packaged executable is missing the expected file description."
    }
    if ($VersionInfo.ProductVersion -ne $Version) {
        throw "Packaged product version '$($VersionInfo.ProductVersion)' does not match '$Version'."
    }
    if ($VersionInfo.FileVersion -ne $FileVersion) {
        throw "Packaged file version '$($VersionInfo.FileVersion)' does not match '$FileVersion'."
    }
    Remove-Item -Force -LiteralPath cmd/riftops-ui/RiftOps.exe
    Write-Host "[8/9] Writing SHA-256 checksum for portable binary..."
    $ResolvedOutput = (Resolve-Path -LiteralPath $OutputPath).Path
    $ChecksumPath = "$ResolvedOutput.sha256"
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ResolvedOutput).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $ChecksumPath -Encoding ascii -NoNewline -Value "$Hash  $([System.IO.Path]::GetFileName($ResolvedOutput))`n"
    Write-Host "Created $OutputPath and $OutputPath.sha256 (Windows GUI subsystem; no startup console)"

    if (-not $SkipInstaller) {
        Write-Host "[9/9] Checking Inno Setup and building Windows installer..."
        $IsccCmd = Get-Command iscc -ErrorAction SilentlyContinue
        $Iscc = if ($IsccCmd) { $IsccCmd.Source } else { $null }
        if (-not $Iscc) {
            $KnownIsccPaths = @(
                (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\iscc.exe"),
                "C:\Program Files (x86)\Inno Setup 6\iscc.exe",
                "C:\Program Files\Inno Setup 6\iscc.exe"
            )
            $Iscc = $KnownIsccPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        }

        if ($Iscc) {
            $InstallerScript = Join-Path $Root "scripts\installer.iss"
            $DistDir = (Resolve-Path -LiteralPath "dist").Path
            Write-Host "Compiling installer using $Iscc..."
            & $Iscc "/DAppVersion=$Version" "/DSourceExe=$ResolvedOutput" "/DOutputDir=$DistDir" $InstallerScript
            if ($LASTEXITCODE -ne 0) {
                throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
            }

            $InstallerPath = Join-Path $DistDir "RiftOps-Setup-$Version-x64.exe"
            if (Test-Path -LiteralPath $InstallerPath) {
                $InstallerChecksum = "$InstallerPath.sha256"
                $InstallerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstallerPath).Hash.ToLowerInvariant()
                Set-Content -LiteralPath $InstallerChecksum -Encoding ascii -NoNewline -Value "$InstallerHash  $([System.IO.Path]::GetFileName($InstallerPath))`n"
                Write-Host "Created $([System.IO.Path]::GetFileName($InstallerPath)) and $([System.IO.Path]::GetFileName($InstallerChecksum))"
            } else {
                throw "Expected installer output at $InstallerPath was not created."
            }
        } else {
            Write-Warning "Inno Setup (iscc.exe) not found. Skipping installer packaging."
        }
    } else {
        Write-Host "[9/9] Skipping installer packaging as requested."
    }
}
finally {
    foreach ($GeneratedFile in @(
        "cmd/riftops-ui/fyne_metadata_init.go",
        "cmd/riftops-ui/fyne.syso",
        "cmd/riftops-ui/FyneApp.ico",
        "cmd/riftops-ui/riftops-ui.exe.manifest",
        "cmd/riftops-ui/RiftOps.exe"
    )) {
        Remove-Item -Force -LiteralPath $GeneratedFile -ErrorAction SilentlyContinue
    }
    Pop-Location
}
