[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [string]$ExpectedPublisher = "SignPath Foundation"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Windows executable was not found: $Path"
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
Write-Host "Verified $Path as $($signature.SignerCertificate.Subject)"
Write-Host "Updated $checksumPath after SignPath signing"
