using System.Security.Cryptography;
using System.Text.Json;
using Propago.Realtime.Contracts;
using StackExchange.Redis;

namespace Propago.Realtime.Redis;

public interface IRealtimeSessionStore
{
    ValueTask<RealtimeIdentity?> ValidateAsync(string sessionId, CancellationToken cancellationToken);
}

public interface IConnectionTicketStore
{
    ValueTask<string> IssueAsync(
        RealtimeIdentity identity,
        string audience,
        TimeSpan lifetime,
        CancellationToken cancellationToken);

    ValueTask<RealtimeIdentity?> ConsumeAsync(
        string ticket,
        string audience,
        CancellationToken cancellationToken);
}

public sealed class RedisSessionStore(
    RedisConnectionProvider connectionProvider,
    RedisOptions options) : IRealtimeSessionStore
{
    public async ValueTask<RealtimeIdentity?> ValidateAsync(
        string sessionId,
        CancellationToken cancellationToken)
    {
        if (!IsSafeIdentifier(sessionId))
        {
            return null;
        }

        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var value = await connection.GetDatabase().StringGetAsync(SessionKey(sessionId));
        if (value.IsNullOrEmpty)
        {
            return null;
        }

        RedisSessionRecord? session;
        try
        {
            session = JsonSerializer.Deserialize(
                value.ToString(),
                RealtimeJsonSerializerContext.Default.RedisSessionRecord);
        }
        catch (JsonException)
        {
            return null;
        }

        if (session is null ||
            session.Revoked ||
            session.ExpiresAt <= DateTimeOffset.UtcNow ||
            !SecurityRecordValidator.IsValidIdentity(session.TenantId, session.UserId, session.AllowedTopics))
        {
            return null;
        }

        return new RealtimeIdentity(
            session.TenantId,
            session.UserId,
            session.AllowedTopics,
            session.ExpiresAt);
    }

    private RedisKey SessionKey(string sessionId) =>
        $"{options.InstancePrefix}:{options.SessionKeyPrefix}:{sessionId}";

    private static bool IsSafeIdentifier(string value) =>
        value.Length is >= 16 and <= 256 && value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_');
}

public sealed class RedisConnectionTicketStore(
    RedisConnectionProvider connectionProvider,
    RedisOptions options) : IConnectionTicketStore
{
    private const string ConsumeScript = "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value";

    public async ValueTask<string> IssueAsync(
        RealtimeIdentity identity,
        string audience,
        TimeSpan lifetime,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(audience);
        if (lifetime <= TimeSpan.Zero || lifetime > TimeSpan.FromMinutes(5))
        {
            throw new ArgumentOutOfRangeException(nameof(lifetime));
        }

        cancellationToken.ThrowIfCancellationRequested();
        var ticket = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
        var record = new ConnectionTicketRecord(
            identity.TenantId,
            identity.UserId,
            identity.AllowedTopics,
            DateTimeOffset.UtcNow.Add(lifetime),
            audience);
        var json = JsonSerializer.Serialize(
            record,
            RealtimeJsonSerializerContext.Default.ConnectionTicketRecord);
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var stored = await connection.GetDatabase().StringSetAsync(
            TicketKey(ticket),
            json,
            lifetime,
            When.NotExists);
        if (!stored)
        {
            throw new RedisException("Unable to issue a unique connection ticket.");
        }

        return ticket;
    }

    public async ValueTask<RealtimeIdentity?> ConsumeAsync(
        string ticket,
        string audience,
        CancellationToken cancellationToken)
    {
        if (ticket.Length is < 32 or > 128 ||
            ticket.Any(character => !char.IsLetterOrDigit(character) && character is not '-' and not '_') ||
            string.IsNullOrWhiteSpace(audience))
        {
            return null;
        }

        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var result = await connection.GetDatabase().ScriptEvaluateAsync(
            ConsumeScript,
            new RedisKey[] { TicketKey(ticket) });
        if (result.IsNull)
        {
            return null;
        }

        ConnectionTicketRecord? record;
        try
        {
            record = JsonSerializer.Deserialize(
                result.ToString(),
                RealtimeJsonSerializerContext.Default.ConnectionTicketRecord);
        }
        catch (JsonException)
        {
            return null;
        }

        if (record is null ||
            record.ExpiresAt <= DateTimeOffset.UtcNow ||
            !string.Equals(record.Audience, audience, StringComparison.OrdinalIgnoreCase) ||
            !SecurityRecordValidator.IsValidIdentity(record.TenantId, record.UserId, record.AllowedTopics))
        {
            return null;
        }

        return new RealtimeIdentity(
            record.TenantId,
            record.UserId,
            record.AllowedTopics,
            record.ExpiresAt);
    }

    private RedisKey TicketKey(string ticket) =>
        $"{options.InstancePrefix}:{options.TicketKeyPrefix}:{ticket}";
}

internal static class SecurityRecordValidator
{
    public static bool IsValidIdentity(
        string tenantId,
        string userId,
        IReadOnlyList<string> allowedTopics) =>
        IsSafeScope(tenantId) &&
        IsSafeScope(userId) &&
        allowedTopics is not null &&
        allowedTopics.Count is >= 1 and <= 256 &&
        allowedTopics.All(topic => topic == "*" || IsSafeScope(topic));

    private static bool IsSafeScope(string value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= 128 &&
        value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_' or '.');
}
