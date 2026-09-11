defmodule CormierRealtimeExample.ProxySocket do
  @behaviour WebSock

  @impl true
  def init(state) do
    case CormierRealtimeExample.UpstreamSocket.start(self(), state) do
      {:ok, upstream} -> {:ok, Map.put(state, :upstream, upstream)}
      _ -> {:stop, :dependency_unavailable, {1013, "dependency unavailable"}, state}
    end
  end

  @impl true
  def handle_in({data, opcode: type}, state) when type in [:text, :binary] do
    CormierRealtimeExample.UpstreamSocket.send_frame(state.upstream, {type, data})
    {:ok, state}
  end

  @impl true
  def handle_info({:upstream, frame}, state), do: {:push, frame, state}
  def handle_info(:upstream_closed, state), do: {:stop, :normal, state}
  def handle_info(_, state), do: {:ok, state}

  @impl true
  def terminate(_reason, state) do
    if state[:upstream], do: GenServer.stop(state.upstream, :normal)
    :ok
  catch
    :exit, _ -> :ok
  end
end

defmodule CormierRealtimeExample.UpstreamSocket do
  use GenServer

  def start(browser, options), do: GenServer.start(__MODULE__, {browser, options})
  def send_frame(server, frame), do: GenServer.cast(server, {:send, frame})

  @impl true
  def init({browser, options}) do
    uri = URI.parse(options.url)
    transport = if uri.scheme == "wss", do: :https, else: :http
    websocket_scheme = if uri.scheme == "wss", do: :wss, else: :ws
    port = uri.port || if(transport == :https, do: 443, else: 80)

    transport_options =
      [timeout: 15_000] ++
        if(transport == :https, do: [cacertfile: CAStore.file_path()], else: [])

    connect_options = [protocols: [:http1], transport_opts: transport_options]

    headers =
      [
        {"host", options.host},
        {"origin", options.origin},
        {"x-forwarded-proto", options.forwarded_proto},
        {"sec-websocket-protocol", options.protocol}
      ] ++
        if(options.cookie, do: [{"cookie", options.cookie}], else: [])

    with {:ok, connection} <- Mint.HTTP.connect(transport, uri.host, port, connect_options),
         {:ok, connection, reference} <-
           Mint.WebSocket.upgrade(websocket_scheme, connection, request_path(uri), headers),
         {:ok, connection, websocket} <-
           await_upgrade(
             connection,
             reference,
             nil,
             [],
             System.monotonic_time(:millisecond) + 15_000
           ) do
      {:ok,
       %{browser: browser, connection: connection, reference: reference, websocket: websocket}}
    else
      _ -> {:stop, :dependency_unavailable}
    end
  end

  defp request_path(%URI{path: path, query: nil}), do: path
  defp request_path(%URI{path: path, query: query}), do: path <> "?" <> query

  defp await_upgrade(connection, reference, status, headers, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      message ->
        case Mint.WebSocket.stream(connection, message) do
          {:ok, connection, responses} ->
            {status, headers, done?} =
              Enum.reduce(responses, {status, headers, false}, fn
                {:status, ^reference, value}, {_status, headers, done} -> {value, headers, done}
                {:headers, ^reference, value}, {status, _headers, done} -> {status, value, done}
                {:done, ^reference}, {status, headers, _done} -> {status, headers, true}
                _, state -> state
              end)

            if done?,
              do: Mint.WebSocket.new(connection, reference, status, headers),
              else: await_upgrade(connection, reference, status, headers, deadline)

          _ ->
            {:error, :upgrade_failed}
        end
    after
      remaining -> {:error, :upgrade_timeout}
    end
  end

  @impl true
  def handle_cast({:send, frame}, state) do
    with {:ok, websocket, data} <- Mint.WebSocket.encode(state.websocket, frame),
         {:ok, connection} <-
           Mint.WebSocket.stream_request_body(state.connection, state.reference, data) do
      {:noreply, %{state | websocket: websocket, connection: connection}}
    else
      _ ->
        send(state.browser, :upstream_closed)
        {:stop, :normal, state}
    end
  end

  @impl true
  def handle_info(message, state) do
    case Mint.WebSocket.stream(state.connection, message) do
      {:ok, connection, responses} ->
        case decode_responses(responses, %{state | connection: connection}) do
          {:ok, state} ->
            {:noreply, state}

          :closed ->
            send(state.browser, :upstream_closed)
            {:stop, :normal, state}
        end

      :unknown ->
        {:noreply, state}

      _ ->
        send(state.browser, :upstream_closed)
        {:stop, :normal, state}
    end
  end

  defp decode_responses(responses, state) do
    Enum.reduce_while(responses, {:ok, state}, fn
      {:data, reference, data}, {:ok, state} when reference == state.reference ->
        case Mint.WebSocket.decode(state.websocket, data) do
          {:ok, websocket, frames} ->
            Enum.each(frames, fn
              {type, payload} when type in [:text, :binary] ->
                send(state.browser, {:upstream, {type, payload}})

              {:close, _, _} ->
                send(state.browser, :upstream_closed)

              _ ->
                :ok
            end)

            {:cont, {:ok, %{state | websocket: websocket}}}

          _ ->
            {:halt, :closed}
        end

      _, result ->
        {:cont, result}
    end)
  end

  @impl true
  def terminate(_reason, state), do: Mint.HTTP.close(state.connection)
end
