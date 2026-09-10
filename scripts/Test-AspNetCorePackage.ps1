[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$scratchRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cormier-realtime-package-" + [guid]::NewGuid().ToString('N'))
$feedPath = Join-Path $scratchRoot 'feed'
$consumerPath = Join-Path $scratchRoot 'consumer'

try {
    New-Item -ItemType Directory -Path $feedPath, $consumerPath -Force | Out-Null

    foreach ($project in @(
        'src/Cormier.Realtime.Contracts/Cormier.Realtime.Contracts.csproj',
        'src/Cormier.Realtime.Redis/Cormier.Realtime.Redis.csproj',
        'src/Cormier.Realtime.AspNetCore/Cormier.Realtime.AspNetCore.csproj'
    )) {
        dotnet pack (Join-Path $repositoryRoot $project) --configuration Release --no-build --output $feedPath
        if ($LASTEXITCODE -ne 0) { throw "Packing failed for $project." }
    }

    @'
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Cormier.Realtime.AspNetCore" Version="0.1.0" />
  </ItemGroup>
</Project>
'@ | Set-Content -LiteralPath (Join-Path $consumerPath 'Consumer.csproj') -Encoding utf8NoBOM

    @'
using Cormier.Realtime.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRealtimeGateway(builder.Configuration);
var app = builder.Build();
app.UseRealtimeGateway();
app.MapRealtimeGateway();
app.Run();
'@ | Set-Content -LiteralPath (Join-Path $consumerPath 'Program.cs') -Encoding utf8NoBOM

    dotnet restore (Join-Path $consumerPath 'Consumer.csproj') "--source=$feedPath" '--source=https://api.nuget.org/v3/index.json'
    if ($LASTEXITCODE -ne 0) { throw 'Clean consumer restore failed.' }
    dotnet build (Join-Path $consumerPath 'Consumer.csproj') --configuration Release --no-restore
    if ($LASTEXITCODE -ne 0) { throw 'Clean consumer build failed.' }
}
finally {
    if (Test-Path -LiteralPath $scratchRoot) {
        Remove-Item -LiteralPath $scratchRoot -Recurse -Force
    }
}
