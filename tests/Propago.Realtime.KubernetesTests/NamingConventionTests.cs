namespace Propago.Realtime.KubernetesTests;

public sealed class NamingConventionTests
{
    [Theory]
    [InlineData("dev-realtime")]
    [InlineData("test-realtime")]
    [InlineData("prod-realtime")]
    public void EnvironmentApplicationNameIsAccepted(string value)
    {
        Assert.Matches("^[a-z0-9]+-[a-z0-9-]+$", value);
    }
}
