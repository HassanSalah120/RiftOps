<#
.SYNOPSIS
    RiftOps Unified Version Manager CLI wrapper.
.DESCRIPTION
    Wraps scripts/version-manager.go to inspect, synchronize, bump, and release versions across all repository files.
.EXAMPLE
    .\scripts\version.ps1 status
    .\scripts\version.ps1 sync
    .\scripts\version.ps1 bump patch
    .\scripts\version.ps1 release patch
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$Tool = Join-Path $ScriptDir "version-manager.go"

Push-Location $RepoRoot
try {
    & go run $Tool @args
}
finally {
    Pop-Location
}
