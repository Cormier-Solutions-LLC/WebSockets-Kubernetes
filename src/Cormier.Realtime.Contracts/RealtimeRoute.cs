namespace Cormier.Realtime.Contracts;

public readonly record struct RealtimeRoute
{
    private RealtimeRoute(string value, string topic, string? userId)
    {
        Value = value;
        Topic = topic;
        UserId = userId;
    }

    public string Value { get; }

    public string Topic { get; }

    public string? UserId { get; }

    public bool IsUserScoped => UserId is not null;

    public static RealtimeRoute ForTopic(string topic)
    {
        ValidateSegment(topic, nameof(topic));
        return new RealtimeRoute($"topics/{topic}", topic, null);
    }

    public static RealtimeRoute ForGroup(string group) => ForTopic(group);

    public static RealtimeRoute ForUserTopic(string userId, string topic)
    {
        ValidateSegment(userId, nameof(userId));
        ValidateSegment(topic, nameof(topic));
        var value = $"users/{userId}/topics/{topic}";
        if (value.Length > ProtocolValidator.MaximumRouteLength)
        {
            throw new ArgumentException("The user topic route must not exceed 256 characters.");
        }
        return new RealtimeRoute(value, topic, userId);
    }

    public static bool TryParse(string? value, out RealtimeRoute route)
    {
        route = default;
        if (string.IsNullOrWhiteSpace(value) || value!.Length > ProtocolValidator.MaximumRouteLength)
        {
            return false;
        }

        var segments = value.Split('/');
        if (segments.Length == 2 && segments[0] == "topics" && IsValidSegment(segments[1]))
        {
            route = new RealtimeRoute(value, segments[1], null);
            return true;
        }
        if (segments.Length == 4 && segments[0] == "users" && segments[2] == "topics" &&
            IsValidSegment(segments[1]) && IsValidSegment(segments[3]))
        {
            route = new RealtimeRoute(value, segments[3], segments[1]);
            return true;
        }
        return false;
    }

    public override string ToString() => Value ?? string.Empty;

    private static void ValidateSegment(string value, string parameterName)
    {
        if (!IsValidSegment(value))
        {
            throw new ArgumentException(
                "Route segments must contain 1-128 letters, digits, hyphens, underscores, or periods.",
                parameterName);
        }
    }

    private static bool IsValidSegment(string? value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value!.Length <= 128 &&
        value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_' or '.');
}
