#requires -Version 7.0

param(
    [string]$Hostname = "riftops-local-hassan.duckdns.org",
    [string]$Repository = "HassanSalah120/RiftOps"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($Hostname -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.duckdns\.org$') {
    throw "Hostname must be one DuckDNS hostname."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI is required and must be signed in."
}

$Root = Split-Path -Parent $PSScriptRoot
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("RiftOpsCert-" + [guid]::NewGuid().ToString("N"))
$CertificatePath = Join-Path $TempRoot "riftops-chat.pfx"
$Token = $null
$EncodedCertificate = $null

try {
    $Token = (Read-Host -MaskInput "DuckDNS token").Trim()
    if ($Token -notmatch '^[0-9a-fA-F-]{32,64}$') {
        throw "DuckDNS token format is invalid."
    }

    New-Item -ItemType Directory -Path $TempRoot | Out-Null
    $env:RIFTOPS_DUCKDNS_TOKEN = $Token

    Push-Location $Root
    try {
        & go run ./cmd/riftops -provision-proxy-certificate $CertificatePath -proxy-hostname $Hostname
        if ($LASTEXITCODE -ne 0) {
            throw "Certificate provisioning failed."
        }
        & go run ./cmd/riftops -validate-proxy-certificate $CertificatePath -proxy-hostname $Hostname
        if ($LASTEXITCODE -ne 0) {
            throw "Certificate validation failed."
        }
    }
    finally {
        Pop-Location
    }

    $EncodedCertificate = [Convert]::ToBase64String([IO.File]::ReadAllBytes($CertificatePath))
    $EncodedCertificate | & gh secret set RIFTOPS_PROXY_PFX_B64 --repo $Repository
    if ($LASTEXITCODE -ne 0) {
        throw "Could not store the certificate in GitHub Actions secrets."
    }

    Write-Host "Trusted proxy certificate validated and stored for $Repository."
}
finally {
    Remove-Item Env:RIFTOPS_DUCKDNS_TOKEN -ErrorAction SilentlyContinue
    $Token = $null
    $EncodedCertificate = $null
    try { Set-Clipboard -Value "" } catch {}
    if (Test-Path -LiteralPath $CertificatePath) {
        Remove-Item -LiteralPath $CertificatePath -Force
    }
    if (Test-Path -LiteralPath $TempRoot) {
        $ResolvedTemp = (Resolve-Path -LiteralPath $TempRoot).Path
        $ExpectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $ResolvedTemp.StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($ResolvedTemp) -notlike "RiftOpsCert-*") {
            throw "Refusing to remove unexpected temporary directory: $ResolvedTemp"
        }
        Remove-Item -LiteralPath $ResolvedTemp -Force
    }
}
