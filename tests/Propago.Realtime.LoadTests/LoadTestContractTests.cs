using Propago.Realtime.Contracts;

namespace Propago.Realtime.LoadTests;

public sealed class LoadTestContractTests
{
    [Fact]
    public void LoadHarnessUsesCurrentProtocolVersion()
    {
        Assert.Equal("1.0", ProtocolVersions.Current);
    }
}
