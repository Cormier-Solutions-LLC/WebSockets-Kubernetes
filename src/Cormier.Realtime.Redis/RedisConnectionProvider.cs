using StackExchange.Redis;

namespace Cormier.Realtime.Redis;

public sealed class RedisConnectionProvider(RedisOptions options) : IRedisReadinessProbe, IAsyncDisposable
{
    private readonly SemaphoreSlim _connectionLock = new(1, 1);
    private ConnectionMultiplexer? _connection;

    public IConnectionMultiplexer? CurrentConnection => Volatile.Read(ref _connection);

    public async ValueTask<IConnectionMultiplexer> GetConnectionAsync(CancellationToken cancellationToken)
    {
        var existing = Volatile.Read(ref _connection);
        if (existing is not null)
        {
            return existing;
        }

        await _connectionLock.WaitAsync(cancellationToken);
        try
        {
            existing = _connection;
            if (existing is not null)
            {
                return existing;
            }

            var configuration = ConfigurationOptions.Parse(options.Endpoint);
            configuration.User = string.IsNullOrWhiteSpace(options.User) ? null : options.User;
            configuration.Password = string.IsNullOrWhiteSpace(options.Password) ? null : options.Password;
            configuration.Ssl = options.Ssl;
            configuration.ServiceName = string.IsNullOrWhiteSpace(options.SentinelServiceName)
                ? null
                : options.SentinelServiceName;
            configuration.SentinelPassword = string.IsNullOrWhiteSpace(options.SentinelPassword)
                ? null
                : options.SentinelPassword;
            configuration.AbortOnConnectFail = false;
            configuration.ConnectRetry = options.ConnectRetryCount;
            configuration.ConnectTimeout = options.ConnectTimeoutMilliseconds;
            configuration.ClientName = $"{options.InstancePrefix}:gateway";
            existing = await ConnectionMultiplexer.ConnectAsync(configuration);
            Volatile.Write(ref _connection, existing);
            return existing;
        }
        finally
        {
            _connectionLock.Release();
        }
    }

    public async ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        try
        {
            var connection = await GetConnectionAsync(cancellationToken);
            return await connection.GetDatabase().PingAsync() <= TimeSpan.FromSeconds(2);
        }
        catch (RedisException)
        {
            return false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        var connection = Interlocked.Exchange(ref _connection, null);
        if (connection is not null)
        {
            await connection.DisposeAsync();
        }

        _connectionLock.Dispose();
    }
}
