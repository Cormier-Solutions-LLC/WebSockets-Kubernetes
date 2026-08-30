using Microsoft.Extensions.Options;
using Cormier.Realtime.Redis;

namespace Cormier.Realtime.Gateway;

public sealed class RealtimeOptionsValidator(IOptions<RedisOptions> redisOptions) : IValidateOptions<RealtimeOptions>
{
    public ValidateOptionsResult Validate(string? name, RealtimeOptions options)
    {
        if (options.MaximumSubscriptions is < 1 or > 10_000)
        {
            return ValidateOptionsResult.Fail(
                "Realtime:MaximumSubscriptions must be between 1 and 10000.");
        }

        if (options.MaximumTrackedCorrelations is < 1 or > 100_000)
        {
            return ValidateOptionsResult.Fail(
                "Realtime:MaximumTrackedCorrelations must be between 1 and 100000.");
        }

        if (options.SlowConsumerStrikeLimit is < 1 or > 1_000)
        {
            return ValidateOptionsResult.Fail(
                "Realtime:SlowConsumerStrikeLimit must be between 1 and 1000.");
        }

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
