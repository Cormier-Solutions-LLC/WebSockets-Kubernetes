using Microsoft.Extensions.Caching.Distributed;
using StackExchange.Redis;

namespace Cormier.Realtime.Example.FullCircle;

internal sealed class RedisDistributedCache(
    Cormier.Realtime.Redis.RedisConnectionProvider connections,
    Cormier.Realtime.Redis.RedisOptions redisOptions) : IDistributedCache
{
    private string Key(string key) => $"{redisOptions.InstancePrefix}:aspnet-session:{key}";

    private string LifetimeKey(string key) => $"{Key(key)}:lifetime-ms";

    public byte[]? Get(string key) => GetAsync(key).GetAwaiter().GetResult();

    public async Task<byte[]?> GetAsync(string key, CancellationToken token = default)
    {
        token.ThrowIfCancellationRequested();
        var database = (await connections.GetConnectionAsync(token)).GetDatabase();
        var value = await database.StringGetAsync(Key(key));
        return value.IsNull ? null : (byte[]?)value;
    }

    public void Refresh(string key) => RefreshAsync(key).GetAwaiter().GetResult();

    public async Task RefreshAsync(string key, CancellationToken token = default)
    {
        token.ThrowIfCancellationRequested();
        var database = (await connections.GetConnectionAsync(token)).GetDatabase();
        var lifetimeValue = await database.StringGetAsync(LifetimeKey(key));
        if (long.TryParse(lifetimeValue.ToString(), System.Globalization.CultureInfo.InvariantCulture, out var lifetimeMilliseconds) &&
            lifetimeMilliseconds > 0)
        {
            var lifetime = TimeSpan.FromMilliseconds(lifetimeMilliseconds);
            await Task.WhenAll(
                database.KeyExpireAsync(Key(key), lifetime),
                database.KeyExpireAsync(LifetimeKey(key), lifetime));
        }
    }

    public void Remove(string key) => RemoveAsync(key).GetAwaiter().GetResult();

    public async Task RemoveAsync(string key, CancellationToken token = default)
    {
        token.ThrowIfCancellationRequested();
        var database = (await connections.GetConnectionAsync(token)).GetDatabase();
        await database.KeyDeleteAsync([Key(key), LifetimeKey(key)]);
    }

    public void Set(string key, byte[] value, DistributedCacheEntryOptions options) =>
        SetAsync(key, value, options).GetAwaiter().GetResult();

    public async Task SetAsync(
        string key,
        byte[] value,
        DistributedCacheEntryOptions options,
        CancellationToken token = default)
    {
        token.ThrowIfCancellationRequested();
        var lifetime = options.AbsoluteExpirationRelativeToNow ?? options.SlidingExpiration;
        if (options.AbsoluteExpiration is not null)
        {
            var absoluteLifetime = options.AbsoluteExpiration.Value - DateTimeOffset.UtcNow;
            lifetime = lifetime is null || absoluteLifetime < lifetime ? absoluteLifetime : lifetime;
        }
        if (lifetime <= TimeSpan.Zero)
        {
            await RemoveAsync(key, token);
            return;
        }
        var database = (await connections.GetConnectionAsync(token)).GetDatabase();
        if (lifetime is null)
        {
            await Task.WhenAll(
                database.StringSetAsync(Key(key), value),
                database.KeyDeleteAsync(LifetimeKey(key)));
        }
        else
        {
            var lifetimeValue = ((long)lifetime.Value.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
            await Task.WhenAll(
                database.StringSetAsync(Key(key), value, lifetime.Value),
                database.StringSetAsync(LifetimeKey(key), lifetimeValue, lifetime.Value));
        }
    }
}
