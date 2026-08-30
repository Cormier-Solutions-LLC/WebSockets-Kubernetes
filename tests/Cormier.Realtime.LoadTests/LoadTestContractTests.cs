using Cormier.Realtime.Contracts;
using System.Text.Json;

namespace Cormier.Realtime.LoadTests;

public sealed class LoadTestContractTests
{
    [Fact]
    public void LoadHarnessUsesCurrentProtocolVersion()
    {
        Assert.Equal("1.0", ProtocolVersions.Current);
    }

    [Fact]
    public void ProductionProfilesCoverRequiredScenariosAndKeepEndpointsConfigurable()
    {
        var root = FindRepositoryRoot();
        var profileText = File.ReadAllText(Path.Join(root, "load", "profiles", "production-readiness.json"));
        using var profile = JsonDocument.Parse(profileText);
        var scenarios = profile.RootElement.GetProperty("profiles").EnumerateArray()
            .Select(item => item.GetProperty("scenario").GetString()!).ToArray();
        Assert.Equal(["connection", "fanout", "burst", "large-message", "slow-client", "soak"], scenarios);

        var harness = File.ReadAllText(Path.Join(root, "scripts", "Invoke-RealtimeLoad.ps1"));
        Assert.Contains("[Parameter(Mandatory)][ValidatePattern('^wss?://')][string]$Endpoint", harness, StringComparison.Ordinal);
        Assert.Contains("$OutputPath", harness, StringComparison.Ordinal);
        Assert.Contains("Cormier.Realtime.LoadRunner", harness, StringComparison.Ordinal);
        Assert.DoesNotContain("production.example", harness, StringComparison.OrdinalIgnoreCase);

        var runner = File.ReadAllText(Path.Join(root, "tools", "Cormier.Realtime.LoadRunner", "Program.cs"));
        Assert.Contains("Task.WhenAll(orderedClients.Select", runner, StringComparison.Ordinal);
        Assert.Contains("options.Scenario == \"soak\"", runner, StringComparison.Ordinal);
        Assert.Contains("DateTimeOffset.UtcNow < deadline", runner, StringComparison.Ordinal);
        Assert.Contains("acknowledgedMessageLatencyMilliseconds", runner, StringComparison.Ordinal);
        Assert.Contains("connectionLatencyMilliseconds", runner, StringComparison.Ordinal);
        Assert.Contains("connectionDeadline", runner, StringComparison.Ordinal);
        Assert.Contains("subscribe:{exception.GetType().Name}", runner, StringComparison.Ordinal);
        Assert.Contains("FailPending", runner, StringComparison.Ordinal);
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Join(current.FullName, "Cormier.Realtime.sln"))) current = current.Parent;
        return current?.FullName ?? throw new DirectoryNotFoundException("Repository root not found.");
    }
}
