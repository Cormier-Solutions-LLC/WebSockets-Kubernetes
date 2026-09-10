[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$PackageDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedDirectory = (Resolve-Path -LiteralPath $PackageDirectory).Path
$packages = @(Get-ChildItem -LiteralPath $resolvedDirectory -File | Where-Object {
    $_.Extension -in @('.nupkg', '.snupkg')
})
if ($packages.Count -eq 0) {
    throw "No NuGet packages were found in $resolvedDirectory."
}

foreach ($package in $packages) {
    $temporaryPackage = "$($package.FullName).deterministic"
    $source = [IO.Compression.ZipFile]::OpenRead($package.FullName)
    try {
        $coreEntries = @($source.Entries | Where-Object {
            $_.FullName -like 'package/services/metadata/core-properties/*.psmdcp'
        })
        if ($coreEntries.Count -ne 1) {
            throw "Package $($package.FullName) does not contain exactly one core-properties entry."
        }
        $originalCorePath = $coreEntries[0].FullName
        $fixedCorePath = 'package/services/metadata/core-properties/package.psmdcp'
        $content = @{}
        foreach ($entry in $source.Entries) {
            $stream = $entry.Open()
            try {
                $memory = [IO.MemoryStream]::new()
                try {
                    $stream.CopyTo($memory)
                    $bytes = $memory.ToArray()
                }
                finally {
                    $memory.Dispose()
                }
            }
            finally {
                $stream.Dispose()
            }
            $name = if ($entry.FullName -eq $originalCorePath) { $fixedCorePath } else { $entry.FullName }
            if ($entry.FullName -in @('_rels/.rels', '[Content_Types].xml')) {
                $text = [Text.Encoding]::UTF8.GetString($bytes).Replace($originalCorePath, $fixedCorePath)
                if ($entry.FullName -eq '_rels/.rels') {
                    $text = $text -replace '(metadata/core-properties" Target="/package/services/metadata/core-properties/package\.psmdcp" Id=")[^"]+', '${1}RCOREPROPERTIES'
                }
                $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
            }
            elseif ($entry.FullName -in @(
                'build/Microsoft.AspNetCore.StaticWebAssets.props',
                'build/Microsoft.AspNetCore.StaticWebAssetEndpoints.props'
            )) {
                $text = [Text.Encoding]::UTF8.GetString($bytes)
                $text = $text -replace '<LastWriteTime>[^<]+</LastWriteTime>', '<LastWriteTime>Tue, 01 Jan 1980 00:00:00 GMT</LastWriteTime>'
                $text = $text -replace '("Name":"Last-Modified","Value":")[^"]+', '${1}Tue, 01 Jan 1980 00:00:00 GMT'
                $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
            }
            $content[$name] = $bytes
        }
    }
    finally {
        $source.Dispose()
    }

    $target = [IO.Compression.ZipFile]::Open($temporaryPackage, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in @($content.Keys | Sort-Object)) {
            $entry = $target.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $stream = $entry.Open()
            try {
                $bytes = $content[$name]
                $stream.Write($bytes, 0, $bytes.Length)
            }
            finally {
                $stream.Dispose()
            }
        }
    }
    finally {
        $target.Dispose()
    }
    Move-Item -LiteralPath $temporaryPackage -Destination $package.FullName -Force
}
