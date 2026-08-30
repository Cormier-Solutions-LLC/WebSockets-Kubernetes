using Cormier.Realtime.Contracts;

namespace Cormier.Realtime.LoadTests;

public sealed class LoadTestContractTests
{
    [Fact]
    public void LoadHarnessUsesCurrentProtocolVersion()
    {
        Assert.Equal("1.0", ProtocolVersions.Current);
    }
}
