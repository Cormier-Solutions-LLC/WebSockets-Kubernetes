using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Cormier.Realtime.AspNetCore;

public sealed class DiagnosticsBearerOptions : AuthenticationSchemeOptions
{
    internal byte[] TokenHash { get; set; } = [];
}

public static class DiagnosticsAuthenticationExtensions
{
    public const string BearerScheme = "Cormier.Realtime.DiagnosticsBearer";

    public static IServiceCollection AddRealtimeDiagnosticsBearer(
        this IServiceCollection services,
        string authorizationPolicy,
        string token,
        params string[] additionalAuthorizationPolicies)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(authorizationPolicy);
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        if (token.Any(char.IsWhiteSpace))
        {
            throw new ArgumentException("The diagnostics bearer token cannot contain whitespace.", nameof(token));
        }
        if (authorizationPolicy.Length > 128)
        {
            throw new ArgumentOutOfRangeException(nameof(authorizationPolicy));
        }
        if (additionalAuthorizationPolicies is null || additionalAuthorizationPolicies.Any(
            policy => string.IsNullOrWhiteSpace(policy) || policy.Length > 128))
        {
            throw new ArgumentOutOfRangeException(nameof(additionalAuthorizationPolicies));
        }
        var policies = new[] { authorizationPolicy }
            .Concat(additionalAuthorizationPolicies)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (token.Length is < 32 or > 4096)
        {
            throw new ArgumentOutOfRangeException(nameof(token), "The diagnostics bearer token must contain between 32 and 4096 characters.");
        }

        var tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        services.AddAuthentication()
            .AddScheme<DiagnosticsBearerOptions, DiagnosticsBearerAuthenticationHandler>(
                BearerScheme,
                options => options.TokenHash = tokenHash);
        var authorization = services.AddAuthorizationBuilder();
        foreach (var policyName in policies)
        {
            authorization.AddPolicy(
                policyName,
                policy => policy
                    .AddAuthenticationSchemes(BearerScheme)
                    .RequireAuthenticatedUser());
        }
        return services;
    }
}

public sealed class DiagnosticsBearerAuthenticationHandler(
    IOptionsMonitor<DiagnosticsBearerOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder) : AuthenticationHandler<DiagnosticsBearerOptions>(options, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var presented = header["Bearer ".Length..].Trim();
        var presentedHash = SHA256.HashData(Encoding.UTF8.GetBytes(presented));
        if (!CryptographicOperations.FixedTimeEquals(presentedHash, Options.TokenHash))
        {
            return Task.FromResult(AuthenticateResult.Fail("The diagnostics bearer credential is invalid."));
        }

        var identity = new ClaimsIdentity(
            [new Claim(ClaimTypes.Name, "diagnostics-operator")],
            DiagnosticsAuthenticationExtensions.BearerScheme);
        var principal = new ClaimsPrincipal(identity);
        return Task.FromResult(AuthenticateResult.Success(
            new AuthenticationTicket(principal, DiagnosticsAuthenticationExtensions.BearerScheme)));
    }
}
