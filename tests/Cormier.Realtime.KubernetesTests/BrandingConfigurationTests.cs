using System.Text.RegularExpressions;

namespace Cormier.Realtime.KubernetesTests;

public sealed partial class BrandingConfigurationTests
{
    private static readonly string Root = FindRepositoryRoot();

    [Fact]
    public void LegacyBrandIsAbsentOutsideHistoricalReferencesAndGeneratedOutputs()
    {
        var excludedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".backups", ".bootstrap", ".build", ".git", ".gradle", ".logs", ".venv",
            "_build", "artifacts", "bin", "deps", "node_modules", "obj", "refs", "target", "vendor"
        };
        var enumeration = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint
        };
        var candidates = Directory.EnumerateFiles(Root, "*", enumeration)
            .Where(path => !path.Split(Path.DirectorySeparatorChar).Any(excludedDirectories.Contains)
                || path.StartsWith(Path.Join(Root, "examples", "ruby-rails", "bin") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));

        var legacyBrand = string.Concat("pro", "pago");
        var violations = candidates
            .Where(path => File.ReadAllText(path).Contains(legacyBrand, StringComparison.OrdinalIgnoreCase))
            .Select(path => Path.GetRelativePath(Root, path))
            .ToArray();

        Assert.Empty(violations);
    }

    [Fact]
    public void ApplicationCodeContainsNoNetworkIdentityDefaults()
    {
        var source = Directory.EnumerateFiles(Path.Join(Root, "src"), "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Split(Path.DirectorySeparatorChar).Any(segment => segment is "bin" or "obj"));
        var violations = source
            .SelectMany(path => File.ReadLines(path).Select((line, index) => (path, line, index)))
            .Where(value => NetworkIdentity().IsMatch(value.line))
            .Select(value => $"{Path.GetRelativePath(Root, value.path)}:{value.index + 1}")
            .ToArray();

        Assert.Empty(violations);
    }

    [Fact]
    public void BootstrapGeneratesValidatedConfigurableNamingContract()
    {
        var bootstrap = Read("scripts/Bootstrap-Realtime.ps1");

        Assert.Contains("[ValidatePattern('^(?=.{1,27}$)[a-z0-9]+(?:-[a-z0-9]+)*$')]", bootstrap, StringComparison.Ordinal);
        Assert.Contains("realtime-$NameSuffix", bootstrap, StringComparison.Ordinal);
        Assert.Contains(".bootstrap", bootstrap, StringComparison.Ordinal);
        Assert.Contains("naming.json", bootstrap, StringComparison.Ordinal);
        Assert.Contains("redisInstancePrefix", bootstrap, StringComparison.Ordinal);
        Assert.Contains("kubernetesApplication", bootstrap, StringComparison.Ordinal);
        Assert.Contains("imageRepository", bootstrap, StringComparison.Ordinal);
        Assert.Contains("ContainerRegistry", bootstrap, StringComparison.Ordinal);
        Assert.Contains("naming.props", bootstrap, StringComparison.Ordinal);
        Assert.Contains(".bootstrap/naming.props", Read("Directory.Build.props"), StringComparison.Ordinal);
        var deployment = Read("scripts/Deploy-Realtime.ps1");
        Assert.Contains("$PSBoundParameters.ContainsKey('Application')", deployment, StringComparison.Ordinal);
        Assert.Contains("[string]$naming.redisInstancePrefix", deployment, StringComparison.Ordinal);
        Assert.DoesNotContain("$([string]$naming.redisInstancePrefix):$Environment", deployment, StringComparison.Ordinal);
        Assert.Contains("[ValidateLength(1,10)]", deployment, StringComparison.Ordinal);
        Assert.Contains("$target.Length -gt 53", deployment, StringComparison.Ordinal);
        Assert.Contains("$redisRelease.Length -gt 53", deployment, StringComparison.Ordinal);
        Assert.Contains("image.repository=$ImageRepository", deployment, StringComparison.Ordinal);
        Assert.Contains(".bootstrap/", Read(".gitignore"), StringComparison.Ordinal);
    }

    [Fact]
    public void AgentGuidanceRequiresEnvironmentIdentitiesToBeConfigured()
    {
        var guidance = Read("AGENTS.md");

        Assert.Contains("Every domain, origin, host/server name, IP address, CIDR, port", guidance, StringComparison.Ordinal);
        Assert.Contains("must be supplied through configuration", guidance, StringComparison.Ordinal);
        Assert.Contains("Never commit credentials", guidance, StringComparison.Ordinal);
    }

    private static string Read(string relative) =>
        File.ReadAllText(Path.Join(Root, relative.Replace('/', Path.DirectorySeparatorChar)));

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Join(current.FullName, "Cormier.Realtime.sln")))
        {
            current = current.Parent;
        }

        return current?.FullName ?? throw new DirectoryNotFoundException("Repository root not found.");
    }

    [GeneratedRegex(@"(?ix)(?:https?://|\blocalhost(?::\d+)?\b|\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b|\b[a-z0-9-]+\.(?:local|internal|example)\b)")]
    private static partial Regex NetworkIdentity();
}
