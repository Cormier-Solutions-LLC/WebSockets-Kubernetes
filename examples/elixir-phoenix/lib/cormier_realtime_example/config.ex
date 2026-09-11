defmodule CormierRealtimeExample.Config do
  @safe ~r/^[A-Za-z0-9._-]+$/
  @prefix ~r/^[A-Za-z0-9._:-]+$/

  def load(getter \\ &System.get_env/1) do
    with {:ok, port} <- integer(getter, "PORT", 1024..65_535),
         {:ok, listen_host} <- host(required(getter, "LISTEN_HOST")),
         {:ok, origin} <- origin(required(getter, "PUBLIC_ORIGIN")),
         {:ok, gateway} <- origin(required(getter, "GATEWAY_URL")),
         {:ok, redis} <- redis(required(getter, "REDIS_URL")),
         {:ok, lifetime} <- integer(getter, "SESSION_LIFETIME_SECONDS", 60..7200),
         {:ok, instance} <- identifier(required(getter, "INSTANCE_NAME"), @safe),
         topology when topology in ["ha", "non-ha"] <- required(getter, "TOPOLOGY"),
         {:ok, prefix} <- identifier(required(getter, "REDIS_INSTANCE_PREFIX"), @prefix),
         {:ok, session_prefix} <- identifier(required(getter, "REDIS_SESSION_KEY_PREFIX"), @safe),
         {:ok, tenants} <- list(required(getter, "ALLOWED_TENANTS")),
         {:ok, users} <- list(required(getter, "ALLOWED_USERS")) do
      {:ok,
       %{
         port: port,
         listen_host: listen_host,
         public_origin: origin,
         gateway_url: gateway,
         redis_url: redis,
         session_lifetime_seconds: lifetime,
         instance_name: instance,
         topology: topology,
         redis_instance_prefix: prefix,
         redis_session_key_prefix: session_prefix,
         allowed_tenants: tenants,
         allowed_users: users,
         shared_asset_root: getter.("SHARED_ASSET_ROOT") || "../shared-web/wwwroot",
         sdk_asset_root: getter.("SDK_ASSET_ROOT") || "../../sdk/typescript/dist"
       }}
    else
      _ -> {:error, :invalid_configuration}
    end
  end

  def session_key(config, id),
    do: Enum.join([config.redis_instance_prefix, config.redis_session_key_prefix, id], ":")

  def public_scheme(config), do: URI.parse(config.public_origin).scheme

  def listen_address(host) do
    with {:error, _} <- :inet.parse_address(String.to_charlist(host)),
         {:ok, address} <- :inet.getaddr(String.to_charlist(host), :inet),
         do: {:ok, address}
  end

  defp host(value) when is_binary(value) and byte_size(value) in 1..253 do
    if Regex.match?(~r/^[A-Za-z0-9._:-]+$/, value),
      do: {:ok, value},
      else: {:error, :invalid_host}
  end

  defp host(_), do: {:error, :invalid_host}

  defp required(getter, name) do
    case getter.(name) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp integer(getter, name, range) do
    with value when is_binary(value) <- required(getter, name),
         {number, ""} <- Integer.parse(value),
         true <- number in range,
         do: {:ok, number}
  end

  defp origin(value) when is_binary(value) do
    explicit_default_port =
      Regex.match?(~r/^http:\/\/[^\/?#]+:80(?:\/|$)/i, value) or
        Regex.match?(~r/^https:\/\/[^\/?#]+:443(?:\/|$)/i, value)

    canonical_casing = value == String.downcase(value)

    case URI.parse(value) do
      %URI{scheme: scheme, host: host, userinfo: nil, query: nil, fragment: nil, path: path}
      when scheme in ["http", "https"] and is_binary(host) and path in [nil, "", "/"] and
             not explicit_default_port and canonical_casing ->
        {:ok, String.trim_trailing(value, "/")}

      _ ->
        {:error, :invalid_origin}
    end
  end

  defp origin(_), do: {:error, :invalid_origin}

  defp redis(value) when is_binary(value) do
    case URI.parse(value) do
      %URI{scheme: scheme, host: host, fragment: nil}
      when scheme in ["redis", "rediss"] and is_binary(host) ->
        {:ok, value}

      _ ->
        {:error, :invalid_redis}
    end
  end

  defp redis(_), do: {:error, :invalid_redis}

  defp identifier(value, pattern) when is_binary(value) and byte_size(value) in 1..128 do
    if Regex.match?(pattern, value), do: {:ok, value}, else: {:error, :invalid_identifier}
  end

  defp identifier(_, _), do: {:error, :invalid_identifier}

  defp list(value) when is_binary(value) do
    values = value |> String.split(",") |> Enum.map(&String.trim/1)

    if Enum.all?(values, &Regex.match?(@safe, &1)),
      do: {:ok, MapSet.new(values)},
      else: {:error, :invalid_list}
  end
end
