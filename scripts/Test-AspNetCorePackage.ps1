[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$AspNetCoreIntegrationVersion = '1.0.2-beta',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$ContractsVersion = '1.0.2-beta',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$RedisAdapterVersion = '1.0.2-beta',
    [string]$PackageSource,
    [string]$UpstreamPackageSource = $env:NUGET_UPSTREAM_SOURCE
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($UpstreamPackageSource)) {
    throw 'UpstreamPackageSource or NUGET_UPSTREAM_SOURCE must identify the configured upstream NuGet feed.'
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$scratchRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cormier-realtime-package-" + [guid]::NewGuid().ToString('N'))
$feedPath = Join-Path $scratchRoot 'feed'
$consumerPath = Join-Path $scratchRoot 'consumer'
$nugetConfigPath = Join-Path $scratchRoot 'NuGet.Config'
$packagesPath = Join-Path $scratchRoot 'packages'

try {
    New-Item -ItemType Directory -Path $feedPath, $consumerPath -Force | Out-Null
    $escapedFeedPath = [System.Security.SecurityElement]::Escape($feedPath)
    $escapedPackagesPath = [System.Security.SecurityElement]::Escape($packagesPath)
    @"
<configuration>
  <config>
    <add key="globalPackagesFolder" value="$escapedPackagesPath" />
  </config>
  <packageSources>
    <clear />
    <add key="local" value="$escapedFeedPath" />
    <add key="upstream" value="$([System.Security.SecurityElement]::Escape($UpstreamPackageSource))" />
  </packageSources>
</configuration>
"@ | Set-Content -LiteralPath $nugetConfigPath -Encoding utf8NoBOM

    if ([string]::IsNullOrWhiteSpace($PackageSource)) {
        foreach ($project in @(
            'src/Cormier.Realtime.Contracts/Cormier.Realtime.Contracts.csproj',
            'src/Cormier.Realtime.Redis/Cormier.Realtime.Redis.csproj',
            'src/Cormier.Realtime.AspNetCore/Cormier.Realtime.AspNetCore.csproj'
        )) {
            dotnet pack (Join-Path $repositoryRoot $project) --configuration Release --no-build --output $feedPath `
                -p:AspNetCoreIntegrationVersion=$AspNetCoreIntegrationVersion `
                -p:ContractsVersion=$ContractsVersion `
                -p:RedisAdapterVersion=$RedisAdapterVersion
            if ($LASTEXITCODE -ne 0) { throw "Packing failed for $project." }
        }
    }
    else {
        $resolvedPackageSource = (Resolve-Path -LiteralPath $PackageSource -ErrorAction Stop).Path
        foreach ($package in @(
            "Cormier.Realtime.Contracts.$(($ContractsVersion -split '\+', 2)[0]).nupkg",
            "Cormier.Realtime.Redis.$(($RedisAdapterVersion -split '\+', 2)[0]).nupkg",
            "Cormier.Realtime.AspNetCore.$(($AspNetCoreIntegrationVersion -split '\+', 2)[0]).nupkg"
        )) {
            Copy-Item -LiteralPath (Join-Path $resolvedPackageSource $package) -Destination $feedPath -ErrorAction Stop
        }
    }

    @"
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Cormier.Realtime.AspNetCore" Version="$AspNetCoreIntegrationVersion" />
  </ItemGroup>
</Project>
"@ | Set-Content -LiteralPath (Join-Path $consumerPath 'Consumer.csproj') -Encoding utf8NoBOM

    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'examples/aspnet-core/Program.cs') -Destination $consumerPath
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'examples/aspnet-core/appsettings.json') -Destination $consumerPath

    dotnet restore (Join-Path $consumerPath 'Consumer.csproj') --configfile $nugetConfigPath
    if ($LASTEXITCODE -ne 0) { throw 'Clean consumer restore failed.' }
    dotnet build (Join-Path $consumerPath 'Consumer.csproj') --configuration Release --no-restore
    if ($LASTEXITCODE -ne 0) { throw 'Clean consumer build failed.' }
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
