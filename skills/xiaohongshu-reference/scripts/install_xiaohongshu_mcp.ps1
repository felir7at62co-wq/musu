param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot 'xhs_release_manifest.json'),
    [string]$InstallDir = $(if ($env:XIAOHONGSHU_RUNTIME) { $env:XIAOHONGSHU_RUNTIME } else {
        $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
        Join-Path $dshHome 'xiaohongshu-runtime'
    })
)

$ErrorActionPreference = 'Stop'

function Remove-PartialFile {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force
    }
}

function Get-Sha256Hex {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

$manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

foreach ($artifact in $manifest.artifacts) {
    $target = Join-Path $InstallDir $artifact.name
    $expectedHash = ([string]$artifact.sha256).ToLowerInvariant()

    if (Test-Path -LiteralPath $target) {
        $existingHash = Get-Sha256Hex -Path $target
        if ($existingHash -eq $expectedHash) {
            Write-Output "verified: $($artifact.name)"
            continue
        }
        Remove-Item -LiteralPath $target -Force
    }

    $partial = "$target.download"
    Remove-PartialFile -Path $partial
    try {
        Invoke-WebRequest -Uri $artifact.url -OutFile $partial -UseBasicParsing
        $actualSize = (Get-Item -LiteralPath $partial).Length
        if ($actualSize -ne [int64]$artifact.size) {
            throw "artifact size mismatch: $($artifact.name)"
        }
        $actualHash = Get-Sha256Hex -Path $partial
        if ($actualHash -ne $expectedHash) {
            throw "artifact sha256 mismatch: $($artifact.name)"
        }
        Move-Item -LiteralPath $partial -Destination $target -Force
        Write-Output "installed: $($artifact.name)"
    }
    finally {
        Remove-PartialFile -Path $partial
    }
}

Write-Output "xiaohongshu-mcp $($manifest.version) ready"
