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
    internal string PrincipalName { get; set; } = string.Empty;
}

public static class DiagnosticsAuthenticationExtensions
{
    public const string BearerScheme = "Cormier.Realtime.DiagnosticsBearer";
    public const string MetricsBearerScheme = "Cormier.Realtime.MetricsBearer";

    public static IServiceCollection AddRealtimeDiagnosticsBearer(
        this IServiceCollection services,
        string authorizationPolicy,
        string token) =>
        AddRealtimeBearer(services, authorizationPolicy, token, BearerScheme, "diagnostics-operator");

    public static IServiceCollection AddRealtimeMetricsBearer(
        this IServiceCollection services,
        string authorizationPolicy,
        string token) =>
        AddRealtimeBearer(services, authorizationPolicy, token, MetricsBearerScheme, "metrics-scraper");

    private static IServiceCollection AddRealtimeBearer(
        IServiceCollection services,
        string authorizationPolicy,
        string token,
        string authenticationScheme,
        string principalName)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(authorizationPolicy);
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        if (token.Any(char.IsWhiteSpace))
        {
            throw new ArgumentException("The bearer token cannot contain whitespace.", nameof(token));
        }
        if (authorizationPolicy.Length > 128)
        {
            throw new ArgumentOutOfRangeException(nameof(authorizationPolicy));
        }
        if (token.Length is < 32 or > 4096)
        {
            throw new ArgumentOutOfRangeException(nameof(token), "The bearer token must contain between 32 and 4096 characters.");
        }

        var tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        foreach (var descriptor in services.Where(static descriptor =>
                     descriptor.ServiceType == typeof(DiagnosticsBearerRegistration)))
        {
            if (descriptor.ImplementationInstance is not DiagnosticsBearerRegistration registration ||
                registration.AuthenticationScheme == authenticationScheme)
            {
                continue;
            }
            if (string.Equals(registration.AuthorizationPolicy, authorizationPolicy, StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException(
                    "The diagnostics and metrics bearer helpers require distinct authorization policy names.",
                    nameof(authorizationPolicy));
            }
            if (CryptographicOperations.FixedTimeEquals(registration.TokenHash, tokenHash))
            {
                throw new ArgumentException(
                    "The diagnostics and metrics bearer helpers require distinct bearer tokens.",
                    nameof(token));
            }
        }
        services.AddSingleton(new DiagnosticsBearerRegistration(
            authorizationPolicy,
            tokenHash,
            authenticationScheme));
        services.AddAuthentication()
            .AddScheme<DiagnosticsBearerOptions, DiagnosticsBearerAuthenticationHandler>(
                authenticationScheme,
                options =>
                {
                    options.TokenHash = tokenHash;
                    options.PrincipalName = principalName;
                });
        services.AddAuthorizationBuilder().AddPolicy(
            authorizationPolicy,
            policy => policy
                .AddAuthenticationSchemes(authenticationScheme)
                .RequireAuthenticatedUser());
        return services;
    }

    private sealed record DiagnosticsBearerRegistration(
        string AuthorizationPolicy,
        byte[] TokenHash,
        string AuthenticationScheme);
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
            return Task.FromResult(AuthenticateResult.Fail("The bearer credential is invalid."));
        }

        var identity = new ClaimsIdentity(
            [new Claim(ClaimTypes.Name, Options.PrincipalName)],
            Scheme.Name);
        var principal = new ClaimsPrincipal(identity);
        return Task.FromResult(AuthenticateResult.Success(
            new AuthenticationTicket(principal, Scheme.Name)));
    }
}
