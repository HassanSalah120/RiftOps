param(
    [string]$Version = "",
    [int]$Build = 1,
    [switch]$SkipTests
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
$Fyne = (Get-Command fyne -ErrorAction SilentlyContinue).Source
if (-not $Fyne) {
    $Fyne = Join-Path $env:USERPROFILE "go\bin\fyne.exe"
}
if (-not (Test-Path -LiteralPath $Fyne)) {
    throw "Fyne CLI not found. Run: go install fyne.io/tools/cmd/fyne@v1.7.2"
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
        "cmd/riftops-ui/riftops-ui.exe.manifest"
    )
    foreach ($GeneratedFile in $GeneratedFiles) {
        Remove-Item -Force -LiteralPath $GeneratedFile -ErrorAction SilentlyContinue
    }

	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		throw "Node.js/npm is required to build the RiftOps frontend."
	}
	Write-Host "[1/8] Installing the locked frontend dependencies..."
	Push-Location "cmd/riftops-ui/frontend"
	try {
		npm ci --ignore-scripts
		if ($LASTEXITCODE -ne 0) { throw "Frontend dependency install failed." }
		if (-not $SkipTests) {
			Write-Host "[2/8] Linting and testing the frontend..."
			npm run lint
			if ($LASTEXITCODE -ne 0) { throw "Frontend lint failed." }
			npm test
			if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed." }
		}
		Write-Host "[3/8] Building the embedded frontend..."
		npm run build
		if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
	}
	finally {
		Pop-Location
	}

    if (-not $SkipTests) {
		Write-Host "[4/8] Running race-enabled desktop tests..."
		go test -race -tags desktop ./...
        if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
		Write-Host "[5/8] Running go vet..."
		go vet -tags desktop ./...
        if ($LASTEXITCODE -ne 0) { throw "Vet failed." }
    }

    $Icon = (Resolve-Path -LiteralPath "cmd/riftops-ui/app.png").Path
    $Manifest = "cmd/riftops-ui/riftops-ui.exe.manifest"
    Copy-Item -Force -LiteralPath "packaging/windows/app.manifest" -Destination $Manifest
	Write-Host "[6/8] Compiling and packaging the desktop host..."
    & $Fyne package --os windows --src cmd/riftops-ui --release --tags desktop `
        --name RiftOps --app-id io.github.hassansalah120.riftops --app-version $Version `
        --app-build $Build --icon $Icon
    if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed." }

	Write-Host "[7/8] Moving and validating the packaged executable..."
    New-Item -ItemType Directory -Force dist | Out-Null
    if (-not (Test-Path -LiteralPath "cmd/riftops-ui/RiftOps.exe")) {
        throw "Fyne completed without producing cmd/riftops-ui/RiftOps.exe."
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
    Remove-Item -Force -LiteralPath cmd/riftops-ui/RiftOps.exe
    Write-Host "[8/8] Writing SHA-256 checksum..."
    $ResolvedOutput = (Resolve-Path -LiteralPath $OutputPath).Path
    $ChecksumPath = "$ResolvedOutput.sha256"
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ResolvedOutput).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $ChecksumPath -Encoding ascii -NoNewline -Value "$Hash  $([System.IO.Path]::GetFileName($ResolvedOutput))`n"
    Write-Host "Created $OutputPath and $OutputPath.sha256 (Windows GUI subsystem; no startup console)"
}
finally {
    foreach ($GeneratedFile in @(
        "cmd/riftops-ui/fyne_metadata_init.go",
        "cmd/riftops-ui/fyne.syso",
        "cmd/riftops-ui/FyneApp.ico",
        "cmd/riftops-ui/riftops-ui.exe.manifest"
    )) {
        Remove-Item -Force -LiteralPath $GeneratedFile -ErrorAction SilentlyContinue
    }
    Pop-Location
}
