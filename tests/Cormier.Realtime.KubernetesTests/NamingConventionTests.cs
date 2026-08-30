namespace Cormier.Realtime.KubernetesTests;

public sealed class NamingConventionTests
{
    [Theory]
    [InlineData("dev-realtime")]
    [InlineData("test-realtime")]
    [InlineData("prod-realtime")]
    public void EnvironmentApplicationNameIsAccepted(string value)
    {
        Assert.Matches("^[a-z0-9]+-[a-z0-9][a-z0-9-]*$", value);
    }

    [Theory]
    [InlineData("Dev-realtime")]
    [InlineData("prod")]
    [InlineData("prod_realtime")]
    [InlineData("prod-")]
    public void InvalidEnvironmentApplicationNameIsRejected(string value)
    {
        Assert.DoesNotMatch("^[a-z0-9]+-[a-z0-9][a-z0-9-]*$", value);
    }
}
