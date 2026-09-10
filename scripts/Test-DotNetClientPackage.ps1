[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$DotNetClientVersion = '0.1.0',
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$ContractsVersion = '0.1.0',
    [string]$PackageSource,
    [string]$UpstreamPackageSource = $env:NUGET_UPSTREAM_SOURCE
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($UpstreamPackageSource)) {
    throw 'UpstreamPackageSource or NUGET_UPSTREAM_SOURCE must identify the configured upstream NuGet feed.'
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$scratchRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cormier-realtime-client-" + [guid]::NewGuid().ToString('N'))
$feedPath = Join-Path $scratchRoot 'feed'
$packagesPath = Join-Path $scratchRoot 'packages'
$nugetConfigPath = Join-Path $scratchRoot 'NuGet.Config'
$contractsPackageVersion = ($ContractsVersion -split '\+', 2)[0]
$clientPackageVersion = ($DotNetClientVersion -split '\+', 2)[0]
$contractsCoreVersion = [version](($ContractsVersion -split '[-+]', 2)[0])
$contractsUpperBound = "{0}.{1}.0" -f $contractsCoreVersion.Major, ($contractsCoreVersion.Minor + 1)

try {
    New-Item -ItemType Directory -Path $feedPath -Force | Out-Null
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
            'src/Cormier.Realtime.Client/Cormier.Realtime.Client.csproj'
        )) {
            dotnet pack (Join-Path $repositoryRoot $project) --configuration Release --no-build --output $feedPath `
                -p:DotNetClientVersion=$DotNetClientVersion -p:ContractsVersion=$ContractsVersion
            if ($LASTEXITCODE -ne 0) { throw "Packing failed for $project." }
        }
    }
    else {
        $resolvedPackageSource = (Resolve-Path -LiteralPath $PackageSource -ErrorAction Stop).Path
        foreach ($package in @(
            "Cormier.Realtime.Contracts.$contractsPackageVersion.nupkg",
            "Cormier.Realtime.Client.$clientPackageVersion.nupkg",
            "Cormier.Realtime.Client.$clientPackageVersion.snupkg"
        )) {
            Copy-Item -LiteralPath (Join-Path $resolvedPackageSource $package) -Destination $feedPath -ErrorAction Stop
        }
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $contractsPackage = Join-Path $feedPath "Cormier.Realtime.Contracts.$contractsPackageVersion.nupkg"
    $clientPackage = Join-Path $feedPath "Cormier.Realtime.Client.$clientPackageVersion.nupkg"
    $symbolsPackage = Join-Path $feedPath "Cormier.Realtime.Client.$clientPackageVersion.snupkg"
    foreach ($requiredPackage in @($contractsPackage, $clientPackage, $symbolsPackage)) {
        if (-not (Test-Path -LiteralPath $requiredPackage)) {
            throw "Expected package artifact was not produced: $requiredPackage"
        }
    }

    $expectedEntries = @{
        $contractsPackage = @(
            'README.md',
            'lib/netstandard2.0/Cormier.Realtime.Contracts.dll',
            'lib/netstandard2.0/Cormier.Realtime.Contracts.xml',
            'lib/net10.0/Cormier.Realtime.Contracts.dll',
            'lib/net10.0/Cormier.Realtime.Contracts.xml'
        )
        $clientPackage = @(
            'README.md',
            'lib/netstandard2.0/Cormier.Realtime.Client.dll',
            'lib/netstandard2.0/Cormier.Realtime.Client.xml'
        )
    }
    foreach ($packagePath in $expectedEntries.Keys) {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
        try {
            $entryNames = @($archive.Entries | ForEach-Object FullName)
            foreach ($expectedEntry in $expectedEntries[$packagePath]) {
                if ($expectedEntry -notin $entryNames) {
                    throw "Package $packagePath is missing $expectedEntry."
                }
            }
        }
        finally {
            $archive.Dispose()
        }
    }

    $clientArchive = [System.IO.Compression.ZipFile]::OpenRead($clientPackage)
    try {
        $nuspecEntry = $clientArchive.Entries |
            Where-Object FullName -EQ 'Cormier.Realtime.Client.nuspec' |
            Select-Object -First 1
        $reader = [System.IO.StreamReader]::new($nuspecEntry.Open())
        try {
            $nuspec = $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }
        $expectedDependency = [regex]::Escape(
            "Cormier.Realtime.Contracts`" version=`"[$contractsPackageVersion, $contractsUpperBound)`"")
        if ($nuspec -notmatch $expectedDependency) {
            throw 'The client package does not constrain its contracts dependency to the compatible minor line.'
        }
        if ($nuspec -match 'Microsoft\.AspNetCore') {
            throw 'The runtime-neutral client package contains an ASP.NET Core dependency.'
        }
    }
    finally {
        $clientArchive.Dispose()
    }

    foreach ($targetFramework in @('net8.0', 'net10.0')) {
        $consumerPath = Join-Path $scratchRoot $targetFramework
        New-Item -ItemType Directory -Path $consumerPath -Force | Out-Null
        @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>$targetFramework</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Cormier.Realtime.Client" Version="$DotNetClientVersion" />
  </ItemGroup>
</Project>
"@ | Set-Content -LiteralPath (Join-Path $consumerPath 'Consumer.csproj') -Encoding utf8NoBOM

        @'
using Cormier.Realtime.Client;

using var client = new RealtimeClient(new RealtimeClientOptions
{
    Endpoint = new Uri("wss://gateway.example/realtime/ws"),
});
Console.WriteLine(client.State);
'@ | Set-Content -LiteralPath (Join-Path $consumerPath 'Program.cs') -Encoding utf8NoBOM

        dotnet restore (Join-Path $consumerPath 'Consumer.csproj') --configfile $nugetConfigPath
        if ($LASTEXITCODE -ne 0) { throw "Clean $targetFramework consumer restore failed." }
        dotnet run --project (Join-Path $consumerPath 'Consumer.csproj') --configuration Release --no-restore
        if ($LASTEXITCODE -ne 0) { throw "Clean $targetFramework consumer execution failed." }
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
