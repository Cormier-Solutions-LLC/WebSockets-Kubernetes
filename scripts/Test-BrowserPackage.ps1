<#
.SYNOPSIS
    Packs and validates the Cormier.Realtime.Browser static-web-asset package.
.NOTES
    Version: 1.0.0
    Requires: PowerShell 7 and .NET SDK 10
    Outputs: Isolated temporary package feed and clean consumer; removed after validation.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$BrowserPackageVersion = '0.1.0',
    [string]$PackageSource,
    [string]$UpstreamPackageSource = $env:NUGET_UPSTREAM_SOURCE
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($UpstreamPackageSource)) {
    throw 'UpstreamPackageSource or NUGET_UPSTREAM_SOURCE must identify the configured upstream NuGet feed.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$scratchRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cormier-realtime-browser-" + [guid]::NewGuid().ToString('N'))
$feedPath = Join-Path $scratchRoot 'feed'
$packagesPath = Join-Path $scratchRoot 'packages'
$consumerPath = Join-Path $scratchRoot 'consumer'
$nugetConfigPath = Join-Path $scratchRoot 'NuGet.Config'
$normalizedVersion = ($BrowserPackageVersion -split '\+', 2)[0]

try {
    New-Item -ItemType Directory -Path $feedPath, $consumerPath -Force | Out-Null
    $escapedFeedPath = [System.Security.SecurityElement]::Escape($feedPath)
    $escapedPackagesPath = [System.Security.SecurityElement]::Escape($packagesPath)
    $escapedUpstream = [System.Security.SecurityElement]::Escape($UpstreamPackageSource)
    @"
<configuration>
  <config>
    <add key="globalPackagesFolder" value="$escapedPackagesPath" />
  </config>
  <packageSources>
    <clear />
    <add key="local" value="$escapedFeedPath" />
    <add key="upstream" value="$escapedUpstream" />
  </packageSources>
</configuration>
"@ | Set-Content -LiteralPath $nugetConfigPath -Encoding utf8NoBOM

    if ([string]::IsNullOrWhiteSpace($PackageSource)) {
        dotnet pack (Join-Path $repositoryRoot 'src/Cormier.Realtime.Browser/Cormier.Realtime.Browser.csproj') `
            --configuration Release --no-build --output $feedPath `
            -p:BrowserPackageVersion=$BrowserPackageVersion
        if ($LASTEXITCODE -ne 0) { throw 'Packing the browser package failed.' }
    }
    else {
        $resolvedPackageSource = (Resolve-Path -LiteralPath $PackageSource -ErrorAction Stop).Path
        Copy-Item -LiteralPath (Join-Path $resolvedPackageSource "Cormier.Realtime.Browser.$normalizedVersion.nupkg") `
            -Destination $feedPath -ErrorAction Stop
    }

    $packagePath = Join-Path $feedPath "Cormier.Realtime.Browser.$normalizedVersion.nupkg"
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw "Expected browser package was not produced: $packagePath"
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
    try {
        $entries = @($archive.Entries | ForEach-Object FullName)
        foreach ($required in @(
            'staticwebassets/cormier-realtime.js',
            'staticwebassets/cormier-realtime.min.js',
            'staticwebassets/cormier-realtime.iife.js',
            'staticwebassets/cormier-realtime.iife.min.js',
            'staticwebassets/types/index.d.ts',
            'staticwebassets/version.json',
            'buildTransitive/Cormier.Realtime.Browser.props'
        )) {
            if ($required -notin $entries) {
                throw "Browser package is missing intended asset $required."
            }
        }
    }
    finally {
        $archive.Dispose()
    }

    @"
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Cormier.Realtime.Browser" Version="$BrowserPackageVersion" />
  </ItemGroup>
</Project>
"@ | Set-Content -LiteralPath (Join-Path $consumerPath 'Consumer.csproj') -Encoding utf8NoBOM
    'var app = WebApplication.CreateBuilder(args).Build(); app.UseStaticFiles(); app.Run();' |
        Set-Content -LiteralPath (Join-Path $consumerPath 'Program.cs') -Encoding utf8NoBOM
    $webRoot = Join-Path $consumerPath 'wwwroot'
    New-Item -ItemType Directory -Path $webRoot -Force | Out-Null
    $exampleHtml = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'examples/browser/index.html') -Raw).
        Replace('../../sdk/typescript/dist/cormier-realtime.iife.min.js', '/_content/Cormier.Realtime.Browser/cormier-realtime.iife.min.js')
    Set-Content -LiteralPath (Join-Path $webRoot 'index.html') -Value $exampleHtml -Encoding utf8NoBOM
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'examples/browser/realtime-example.js') -Destination $webRoot

    dotnet restore (Join-Path $consumerPath 'Consumer.csproj') --configfile $nugetConfigPath
    if ($LASTEXITCODE -ne 0) { throw 'Clean browser consumer restore failed.' }
    dotnet build (Join-Path $consumerPath 'Consumer.csproj') --configuration Release --no-restore
    if ($LASTEXITCODE -ne 0) { throw 'Clean browser consumer build failed.' }
    $manifests = @(Get-ChildItem (Join-Path $consumerPath 'obj') -Filter '*staticwebassets*.json' -Recurse)
    $assetManifest = $manifests | Where-Object {
        (Get-Content -LiteralPath $_.FullName -Raw) -match 'cormier-realtime\.iife\.min\.js'
    } | Select-Object -First 1
    if ($null -eq $assetManifest) {
        throw 'The clean consumer static-web-asset manifest does not expose the browser package.'
    }
    if ((Get-Content -LiteralPath (Join-Path $webRoot 'index.html') -Raw) -notmatch '/_content/Cormier\.Realtime\.Browser/cormier-realtime\.iife\.min\.js') {
        throw 'The browser example does not consume the packaged production asset.'
    }
}
finally {
    if (Test-Path -LiteralPath $scratchRoot) {
        $resolvedScratch = (Resolve-Path -LiteralPath $scratchRoot).Path
        $resolvedTemp = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
        if (-not $resolvedScratch.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove temporary path outside the configured temporary directory: $resolvedScratch"
        }
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
}
