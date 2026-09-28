using System.Text.Json;
using System.Threading.Channels;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Gateway;
using Cormier.Realtime.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Cormier.Realtime.HttpFallback;

public static class HttpFallbackHostingExtensions
{
    public static IServiceCollection AddRealtimeHttpFallback(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<HttpFallbackOptions>()
            .Bind(configuration.GetSection(HttpFallbackOptions.SectionName))
            .Validate(options => options.BasePath.StartsWith('/') && !options.BasePath.EndsWith('/'),
                "HttpFallback:BasePath must be an absolute path without a trailing slash.")
            .Validate(options => options.ConnectionTimeoutSeconds is >= 5 and <= 300,
                "HttpFallback:ConnectionTimeoutSeconds must be between 5 and 300.")
            .Validate(options => options.PollTimeoutSeconds is >= 1 and <= 30,
                "HttpFallback:PollTimeoutSeconds must be between 1 and 30.")
            .ValidateOnStart();
        services.TryAddSingleton(provider => provider.GetRequiredService<IOptions<HttpFallbackOptions>>().Value);
        services.TryAddSingleton<HttpFallbackConnectionManager>();
        return services;
    }

    public static IEndpointConventionBuilder MapRealtimeHttpFallback(this IEndpointRouteBuilder endpoints)
    {
        var options = endpoints.ServiceProvider.GetRequiredService<HttpFallbackOptions>();
        var realtimeOptions = endpoints.ServiceProvider.GetRequiredService<RealtimeOptions>();
        RealtimeGatewayHostingExtensions.EnsureRouteAvailable(endpoints, $"{options.BasePath}/connect", HttpMethods.Post);
        RealtimeGatewayHostingExtensions.EnsureRouteAvailable(endpoints, $"{options.BasePath}/connections/{{connectionId}}/stream", HttpMethods.Get);
        RealtimeGatewayHostingExtensions.EnsureRouteAvailable(endpoints, $"{options.BasePath}/connections/{{connectionId}}/messages", HttpMethods.Post);
        RealtimeGatewayHostingExtensions.EnsureRouteAvailable(endpoints, $"{options.BasePath}/connections/{{connectionId}}/poll", HttpMethods.Post);
        RealtimeGatewayHostingExtensions.EnsureRouteAvailable(endpoints, $"{options.BasePath}/connections/{{connectionId}}", HttpMethods.Delete);
        var connect = endpoints.MapPost($"{options.BasePath}/connect", (RequestDelegate)ConnectAsync);
        var stream = endpoints.MapGet($"{options.BasePath}/connections/{{connectionId}}/stream",
            (RequestDelegate)StreamAsync);
        var messages = endpoints.MapPost($"{options.BasePath}/connections/{{connectionId}}/messages",
            (RequestDelegate)MessagesAsync);
        var poll = endpoints.MapPost($"{options.BasePath}/connections/{{connectionId}}/poll",
            (RequestDelegate)PollAsync);
        var close = endpoints.MapDelete($"{options.BasePath}/connections/{{connectionId}}",
            (RequestDelegate)CloseAsync);
        var fallback = new CompositeBuilder(connect, stream, messages, poll, close);
        if (!string.IsNullOrWhiteSpace(realtimeOptions.AuthorizationPolicy))
        {
            fallback.RequireAuthorization(realtimeOptions.AuthorizationPolicy);
        }
        return fallback;
    }

    private static async Task ConnectAsync(HttpContext context)
    {
        var authenticator = context.RequestServices.GetRequiredService<RealtimeAuthenticator>();
        var manager = context.RequestServices.GetRequiredService<HttpFallbackConnectionManager>();
        var authentication = await authenticator.AuthenticateAsync(context, context.RequestAborted);
        if (!authentication.Succeeded)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        var state = manager.Create(authentication);
        if (state is null)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }
        context.Response.Headers.CacheControl = "no-store";
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsync(
            $"{{\"connectionId\":\"{state.Id}\",\"connectionToken\":\"{state.Token}\"}}",
            context.RequestAborted);
    }

    private static async Task StreamAsync(HttpContext context)
    {
        var connectionId = GetConnectionId(context);
        var manager = context.RequestServices.GetRequiredService<HttpFallbackConnectionManager>();
        var logger = context.RequestServices.GetRequiredService<ILogger<HttpFallbackConnectionManager>>();
        if (!TryGet(context, connectionId, manager, out var state))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (!state.TryAttachStream())
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            return;
        }
        context.Response.ContentType = "application/x-ndjson; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store, no-transform";
        context.Response.Headers["X-Accel-Buffering"] = "no";
        await context.Response.StartAsync(context.RequestAborted);
        try
        {
            await foreach (var pending in state.Transport.ReadAllAsync(context.RequestAborted))
            {
                await context.Response.Body.WriteAsync(pending.Payload, context.RequestAborted);
                await context.Response.Body.WriteAsync("\n"u8.ToArray(), context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
            }
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            HttpFallbackLog.StreamAborted(logger, connectionId);
        }
        finally
        {
            await manager.CloseAsync(state, "http_stream_closed", CancellationToken.None);
        }
    }

    private static async Task MessagesAsync(HttpContext context)
    {
        var connectionId = GetConnectionId(context);
        var manager = context.RequestServices.GetRequiredService<HttpFallbackConnectionManager>();
        var options = context.RequestServices.GetRequiredService<RealtimeOptions>();
        if (!TryGet(context, connectionId, manager, out var state))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (context.Request.ContentLength is > 0 && context.Request.ContentLength > options.MaximumMessageBytes)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            return;
        }
        MessageEnvelope? envelope;
        try
        {
            var payload = new byte[options.MaximumMessageBytes + 1];
            var length = 0;
            while (length < payload.Length)
            {
                var read = await context.Request.Body.ReadAsync(payload.AsMemory(length), context.RequestAborted);
                if (read == 0) break;
                length += read;
            }
            if (length > options.MaximumMessageBytes)
            {
                context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                return;
            }
            envelope = JsonSerializer.Deserialize(
                payload.AsSpan(0, length),
                RealtimeJsonSerializerContext.Default.MessageEnvelope);
        }
        catch (JsonException)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }
        if (envelope is null)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }
        if (!await state.InboundGate.WaitAsync(0, context.RequestAborted))
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            return;
        }
        bool dispatched;
        try
        {
            if (!manager.IsActive(state))
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            dispatched = await manager.DispatchAsync(state, envelope, context.RequestAborted);
        }
        finally
        {
            state.InboundGate.Release();
        }
        if (!dispatched)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        context.Response.StatusCode = StatusCodes.Status202Accepted;
    }

    private static async Task PollAsync(HttpContext context)
    {
        var connectionId = GetConnectionId(context);
        var manager = context.RequestServices.GetRequiredService<HttpFallbackConnectionManager>();
        var options = context.RequestServices.GetRequiredService<HttpFallbackOptions>();
        if (!TryGet(context, connectionId, manager, out var state))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (!state.TryBeginPoll())
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            return;
        }
        context.Response.Headers.CacheControl = "no-store";
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
            timeout.CancelAfter(TimeSpan.FromSeconds(options.PollTimeoutSeconds));
            HttpFallbackTransport.HttpFallbackPayload pending;
            try
            {
                pending = await state.Transport.ReadAsync(timeout.Token);
            }
            catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
            {
                context.Response.StatusCode = StatusCodes.Status204NoContent;
                return;
            }
            catch (ChannelClosedException)
            {
                context.Response.StatusCode = StatusCodes.Status410Gone;
                return;
            }
            context.Response.ContentType = "application/json; charset=utf-8";
            try
            {
                await context.Response.Body.WriteAsync(pending.Payload, context.RequestAborted);
            }
            finally
            {
                pending.Complete();
            }
        }
        finally
        {
            state.EndPoll();
        }
    }

    private static async Task CloseAsync(HttpContext context)
    {
        var connectionId = GetConnectionId(context);
        var manager = context.RequestServices.GetRequiredService<HttpFallbackConnectionManager>();
        if (!TryGet(context, connectionId, manager, out var state))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        await manager.CloseAsync(state, "client_disconnect", context.RequestAborted);
        context.Response.StatusCode = StatusCodes.Status204NoContent;
    }

    private static bool TryGet(HttpContext context, string id, HttpFallbackConnectionManager manager,
        out HttpFallbackConnectionManager.State state) =>
        manager.TryGet(id, context.Request.Headers["X-Cormier-Connection"].ToString(), out state!);

    private static string GetConnectionId(HttpContext context) =>
        context.Request.RouteValues["connectionId"]?.ToString() ?? string.Empty;

    private sealed class CompositeBuilder(params IEndpointConventionBuilder[] builders) : IEndpointConventionBuilder
    {
        public void Add(Action<EndpointBuilder> convention)
        {
            foreach (var builder in builders) builder.Add(convention);
        }
    }
}

internal static partial class HttpFallbackLog
{
    [LoggerMessage(
        EventId = 5000,
        Level = LogLevel.Debug,
        Message = "HTTP fallback connection {ConnectionId} background operation was cancelled.")]
    public static partial void BackgroundCancelled(ILogger logger, string connectionId);

    [LoggerMessage(
        EventId = 5001,
        Level = LogLevel.Debug,
        Message = "HTTP fallback connection {ConnectionId} streaming request was cancelled by the client.")]
    public static partial void StreamAborted(ILogger logger, string connectionId);
}
