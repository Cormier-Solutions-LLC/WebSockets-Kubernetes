using Microsoft.Extensions.Options;
using Propago.Realtime.Redis;

namespace Propago.Realtime.Gateway;

public sealed class RealtimeOptionsValidator(IOptions<RedisOptions> redisOptions) : IValidateOptions<RealtimeOptions>
{
    public ValidateOptionsResult Validate(string? name, RealtimeOptions options)
    {
        if (options.DurableEventClasses.Length > 0 && !redisOptions.Value.StreamsEnabled)
        {
            return ValidateOptionsResult.Fail(
                "Redis:StreamsEnabled must be true when Realtime:DurableEventClasses is configured.");
        }

        if (options.DurableEventClasses.Any(eventClass => !IsValidEventClass(eventClass)))
        {
            return ValidateOptionsResult.Fail(
                "Realtime:DurableEventClasses entries must be 1-64 characters containing only letters, digits, '-' or '_'.");
        }

        return ValidateOptionsResult.Success;
    }

    private static bool IsValidEventClass(string eventClass) =>
        !string.IsNullOrWhiteSpace(eventClass) &&
        eventClass.Length <= 64 &&
        eventClass.All(character => char.IsLetterOrDigit(character) || character is '-' or '_');
}
