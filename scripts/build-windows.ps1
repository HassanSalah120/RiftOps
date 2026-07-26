param(
    [string]$Version = "2.3.7",
    [int]$Build = 1,
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Root = Split-Path -Parent $PSScriptRoot
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
	Write-Host "[1/5] Building the embedded frontend..."
	Push-Location "cmd/riftops-ui/frontend"
	try {
		npm run build
		if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
	}
	finally {
		Pop-Location
	}

    if (-not $SkipTests) {
		Write-Host "[2/5] Running tests..."
		go test -tags desktop ./...
        if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
		Write-Host "[3/5] Running go vet..."
		go vet -tags desktop ./...
        if ($LASTEXITCODE -ne 0) { throw "Vet failed." }
    }

    $Icon = (Resolve-Path -LiteralPath "cmd/riftops-ui/app.png").Path
    $Manifest = "cmd/riftops-ui/riftops-ui.exe.manifest"
    Copy-Item -Force -LiteralPath "packaging/windows/app.manifest" -Destination $Manifest
	Write-Host "[4/5] Compiling and packaging the desktop host..."
    & $Fyne package --os windows --src cmd/riftops-ui --release --tags desktop `
        --name RiftOps --app-id io.github.hassansalah120.riftops --app-version $Version `
        --app-build $Build --icon $Icon
    if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed." }

	Write-Host "[5/5] Moving the packaged executable..."
    New-Item -ItemType Directory -Force dist | Out-Null
    if (-not (Test-Path -LiteralPath "cmd/riftops-ui/RiftOps.exe")) {
        throw "Fyne completed without producing cmd/riftops-ui/RiftOps.exe."
    }
    $OutputPath = "dist/RiftOps-windows-amd64.exe"
    try {
        Copy-Item -Force -LiteralPath cmd/riftops-ui/RiftOps.exe -Destination $OutputPath -ErrorAction Stop
    } catch [System.IO.IOException] {
        $OutputPath = "dist/RiftOps-windows-amd64-v$Version.exe"
        Copy-Item -Force -LiteralPath cmd/riftops-ui/RiftOps.exe -Destination $OutputPath -ErrorAction Stop
        Write-Warning "The standard output executable is in use. Created $OutputPath instead."
    }
    Remove-Item -Force -LiteralPath cmd/riftops-ui/RiftOps.exe
    Write-Host "Created $OutputPath"
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
