defmodule CormierRealtimeExample.Web do
  import Plug.Conn
  require Logger
  @cookie "cormier_session"
  @protocol "cormier.realtime.v1"
  @max_body 65_536

  def init(options), do: options

  def offers_protocol?(values) do
    values
    |> Enum.flat_map(&String.split(&1, ","))
    |> Enum.any?(&(String.trim(&1) == @protocol))
  end

  def collect_response_chunk({:data, data}, {request, response}) do
    body = [response.body || "", data]

    if IO.iodata_length(body) > @max_body,
      do: {:halt, {request, %{response | body: :too_large}}},
      else: {:cont, {request, %{response | body: body}}}
  end

  def read_bounded_body(conn) do
    case read_body(conn, length: @max_body, read_timeout: 5_000) do
      {:ok, body, conn} -> {:ok, body, conn}
      {:more, _body, conn} -> {:error, :too_large, discard_body(conn)}
      {:error, reason} -> {:error, reason, conn}
    end
  end

  def authority(%{host: host, port: port, scheme: scheme}) do
    host = if String.contains?(host, ":"), do: "[#{host}]", else: host
    host <> port_suffix(port, scheme)
  end

  def call(conn, _options) do
    conn =
      conn
      |> put_resp_header("cache-control", "no-store")
      |> put_resp_header(
        "content-security-policy",
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'"
      )
      |> put_resp_header("referrer-policy", "no-referrer")
      |> put_resp_header("x-content-type-options", "nosniff")
      |> put_resp_header("x-frame-options", "DENY")

    config = Application.fetch_env!(:cormier_realtime_example, :runtime_config)
    route(conn.method, conn.path_info, conn, config)
  rescue
    _ ->
      Logger.error("request failed", event: "request_failed")
      json(conn, 500, %{code: "internal_error", message: "The request could not be completed."})
  end

  defp route("GET", [], conn, config),
    do: send_asset(conn, Path.join(config.shared_asset_root, "index.html"))

  defp route("GET", [asset], conn, config) when asset in ["app.css", "app.js"],
    do: send_asset(conn, Path.join(config.shared_asset_root, asset))

  defp route("GET", ["_content", "Cormier.Realtime.Browser", asset], conn, config) do
    if Regex.match?(~r/^[A-Za-z0-9._-]+$/, asset),
      do: send_asset(conn, Path.join(config.sdk_asset_root, asset)),
      else: send_resp(conn, 404, "")
  end

  defp route("GET", ["health"], conn, _config) do
    case Redix.command(CormierRealtimeExample.Redis, ["PING"], timeout: 5_000) do
      {:ok, "PONG"} -> json(conn, 200, %{status: "healthy"})
      _ -> json(conn, 503, %{status: "unavailable"})
    end
  end

  defp route("GET", ["api", "diagnostics"], conn, config) do
    redis =
      case Redix.command(CormierRealtimeExample.Redis, ["PING"], timeout: 5_000) do
        {:ok, "PONG"} -> "ready"
        _ -> "unavailable"
      end

    json(conn, 200, %{
      stack: "Elixir / Phoenix",
      topology: config.topology,
      instance: config.instance_name,
      redis: redis,
      heartbeatIntervalMilliseconds: config.heartbeat_interval_milliseconds,
      timestamp: DateTime.utc_now()
    })
  end

  defp route("POST", ["api", "login"], conn, config) do
    with :ok <- origin(conn, config),
         {:ok, body, conn} <- read_bounded_body(conn),
         {:ok, %{"tenantId" => tenant, "userId" => user}} <- Jason.decode(body),
         true <-
           MapSet.member?(config.allowed_tenants, tenant) and
             MapSet.member?(config.allowed_users, user) do
      id = :crypto.strong_rand_bytes(24) |> Base.url_encode64(padding: false)
      expires = DateTime.add(DateTime.utc_now(), config.session_lifetime_seconds, :second)

      record =
        Jason.encode!(%{
          tenantId: tenant,
          userId: user,
          allowedTopics: ["orders", "notifications"],
          expiresAt: expires,
          revoked: false
        })

      case Redix.command(
             CormierRealtimeExample.Redis,
             [
               "SET",
               CormierRealtimeExample.Config.session_key(config, id),
               record,
               "EX",
               config.session_lifetime_seconds
             ],
             timeout: 5_000
           ) do
        {:ok, "OK"} ->
          conn
          |> put_resp_cookie(@cookie, id,
            http_only: true,
            same_site: "Strict",
            secure: String.starts_with?(config.public_origin, "https://"),
            max_age: config.session_lifetime_seconds
          )
          |> json(200, %{tenantId: tenant, userId: user, expiresAt: expires})

        _ ->
          unavailable(conn)
      end
    else
      {:error, :origin} ->
        origin_error(conn)

      {:error, :too_large, conn} ->
        request_too_large(conn)

      _ ->
        json(conn, 400, %{
          code: "invalid_identity",
          message: "Select a configured test tenant and user."
        })
    end
  end

  defp route("GET", ["api", "session"], conn, config) do
    case load_session(conn, config) do
      {:ok, record, conn} -> json(conn, 200, Map.merge(record, %{"authenticated" => true}))
      {:error, :dependency, conn} -> unavailable(conn)
      {:error, _, conn} -> unauthorized(conn)
    end
  end

  defp route("POST", ["api", "logout"], conn, config) do
    with :ok <- origin(conn, config) do
      conn = fetch_cookies(conn)

      result =
        case conn.cookies[@cookie] do
          id when is_binary(id) ->
            Redix.command(
              CormierRealtimeExample.Redis,
              ["DEL", CormierRealtimeExample.Config.session_key(config, id)],
              timeout: 5_000
            )

          _ ->
            {:ok, 0}
        end

      case result do
        {:ok, _} ->
          conn
          |> delete_resp_cookie(@cookie, http_only: true, same_site: "Strict")
          |> send_resp(204, "")

        _ ->
          unavailable(conn)
      end
    else
      _ -> origin_error(conn)
    end
  end

  defp route("POST", ["realtime", "tickets"], conn, config) do
    with :ok <- origin(conn, config),
         {:ok, body, conn} <- read_bounded_body(conn),
         {:ok, response} <-
           Req.post(config.gateway_url <> "/realtime/tickets",
             body: body,
             headers: forward_headers(conn, config),
             connect_options: [timeout: 5_000],
             receive_timeout: 15_000,
             into: &collect_response_chunk/2,
             retry: false
           ),
         false <- response.body == :too_large do
      body = IO.iodata_to_binary(response.body)

      conn
      |> put_resp_header(
        "content-type",
        List.first(response.headers["content-type"] || ["application/json"])
      )
      |> send_resp(response.status, body)
    else
      {:error, :origin} -> origin_error(conn)
      {:error, :too_large, conn} -> request_too_large(conn)
      _ -> unavailable(conn)
    end
  end

  defp route("GET", ["realtime", "ws"], conn, config) do
    with :ok <- origin(conn, config),
         :ok <- websocket_protocol(conn) do
      state = %{
        url: websocket_url(config.gateway_url, conn.query_string),
        origin: config.public_origin,
        cookie: get_req_header(conn, "cookie") |> List.first(),
        host: authority(conn),
        forwarded_proto: CormierRealtimeExample.Config.public_scheme(config),
        protocol: @protocol
      }

      conn
      |> put_resp_header("sec-websocket-protocol", @protocol)
      |> WebSockAdapter.upgrade(CormierRealtimeExample.ProxySocket, state,
        timeout: 60_000,
        max_frame_size: @max_body
      )
    else
      {:error, :origin} -> origin_error(conn)
      {:error, :protocol} -> protocol_error(conn)
    end
  end

  defp route(_, _, conn, _config), do: send_resp(conn, 404, "")

  defp origin(conn, config),
    do:
      if(get_req_header(conn, "origin") == [config.public_origin],
        do: :ok,
        else: {:error, :origin}
      )

  defp websocket_protocol(conn) do
    if offers_protocol?(get_req_header(conn, "sec-websocket-protocol")),
      do: :ok,
      else: {:error, :protocol}
  end

  defp forward_headers(conn, config),
    do:
      Enum.flat_map(["origin", "cookie", "content-type"], fn name ->
        Enum.map(get_req_header(conn, name), &{name, &1})
      end) ++
        [
          {"host", authority(conn)},
          {"x-forwarded-proto", CormierRealtimeExample.Config.public_scheme(config)}
        ]

  defp port_suffix(80, :http), do: ""
  defp port_suffix(443, :https), do: ""
  defp port_suffix(port, _scheme), do: ":#{port}"

  defp discard_body(conn) do
    case read_body(conn, length: @max_body, read_timeout: 5_000) do
      {:more, _body, conn} -> discard_body(conn)
      {:ok, _body, conn} -> conn
      {:error, _reason} -> conn
    end
  end

  defp websocket_url(url, query) do
    suffix = if query == "", do: "", else: "?" <> query

    url
    |> String.replace_prefix("https://", "wss://")
    |> String.replace_prefix("http://", "ws://")
    |> Kernel.<>("/realtime/ws" <> suffix)
  end

  defp load_session(conn, config) do
    conn = fetch_cookies(conn)

    with id when is_binary(id) <- conn.cookies[@cookie],
         true <- Regex.match?(~r/^[A-Za-z0-9_-]{16,256}$/, id),
         {:ok, value} <-
           Redix.command(
             CormierRealtimeExample.Redis,
             ["GET", CormierRealtimeExample.Config.session_key(config, id)],
             timeout: 5_000
           ),
         value when is_binary(value) <- value,
         {:ok, record} <- Jason.decode(value),
         {:ok, expires, _} <- DateTime.from_iso8601(record["expiresAt"]),
         true <- !record["revoked"] and DateTime.after?(expires, DateTime.utc_now()) do
      {:ok, record, conn}
    else
      {:error, error}
      when is_struct(error, Redix.Error) or is_struct(error, Redix.ConnectionError) ->
        {:error, :dependency, conn}

      _ ->
        {:error, :unauthorized, conn}
    end
  end

  defp json(conn, status, body),
    do:
      conn |> put_resp_content_type("application/json") |> send_resp(status, Jason.encode!(body))

  defp send_asset(conn, path),
    do: conn |> put_resp_content_type(MIME.from_path(path)) |> send_file(200, path)

  defp unauthorized(conn),
    do:
      json(conn, 401, %{code: "authentication_required", message: "Authentication is required."})

  defp unavailable(conn),
    do:
      json(conn, 503, %{
        code: "service_unavailable",
        message: "The reference application dependency is unavailable."
      })

  defp request_too_large(conn),
    do: json(conn, 413, %{code: "invalid_request", message: "The request is invalid."})

  defp origin_error(conn),
    do: json(conn, 403, %{code: "origin_rejected", message: "The request Origin is not allowed."})

  defp protocol_error(conn),
    do:
      json(conn, 400, %{
        code: "subprotocol_required",
        message: "The required WebSocket subprotocol was not offered."
      })
end
