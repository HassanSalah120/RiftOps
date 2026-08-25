[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$CertificatePath,
    [Parameter(Mandatory = $true)]
    [string]$CertificatePassword,
    [string]$TimestampUrl = "https://timestamp.digicert.com",
    [string]$ExpectedPublisher = "Kingof30"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Windows executable was not found: $Path"
}
if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
    throw "Signing certificate was not found: $CertificatePath"
}

$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signTool) {
    $sdkRoots = @(
        (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"),
        (Join-Path $env:ProgramFiles "Windows Kits\10\bin")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $signToolPath = Get-ChildItem -Path $sdkRoots -Filter signtool.exe -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if ($signToolPath) {
        $signTool = Get-Command $signToolPath
    }
}
if (-not $signTool) {
    throw "signtool.exe was not found. Install the Windows SDK on the signing runner."
}

& $signTool.Source sign /fd SHA256 /tr $TimestampUrl /td SHA256 /f $CertificatePath /p $CertificatePassword /d "RiftOps" /du "https://github.com/HassanSalah120/RiftOps" $Path
if ($LASTEXITCODE -ne 0) {
    throw "Authenticode signing failed with exit code $LASTEXITCODE."
}

$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne "Valid") {
    throw "Authenticode verification failed: $($signature.Status) $($signature.StatusMessage)"
}
if ($ExpectedPublisher -and $signature.SignerCertificate.Subject -notmatch [regex]::Escape($ExpectedPublisher)) {
    throw "The signing certificate subject does not contain the expected publisher '$ExpectedPublisher': $($signature.SignerCertificate.Subject)"
}

$checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
$checksumPath = "$Path.sha256"
Set-Content -LiteralPath $checksumPath -Encoding ascii -NoNewline -Value "$checksum  $([System.IO.Path]::GetFileName($Path))`n"
Write-Host "Signed and verified $Path as $($signature.SignerCertificate.Subject)"
Write-Host "Updated $checksumPath after signing"
