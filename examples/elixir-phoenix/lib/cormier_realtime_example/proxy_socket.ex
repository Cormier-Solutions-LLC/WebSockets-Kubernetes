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

  def handle_info({:upstream_closed, code, reason}, state),
    do: {:stop, :normal, {code, reason}, state}

  def handle_info(:upstream_closed, state), do: {:stop, :normal, state}
  def handle_info(_, state), do: {:ok, state}

  @impl true
  def terminate(reason, state) do
    if state[:upstream] do
      code = if reason == :remote, do: 1000, else: 1001
      CormierRealtimeExample.UpstreamSocket.close(state.upstream, code, "")
    end

    :ok
  catch
    :exit, _ -> :ok
  end
end

defmodule CormierRealtimeExample.UpstreamSocket do
  use GenServer

  @maximum_frame_bytes 64 * 1024

  def start(browser, options), do: GenServer.start(__MODULE__, {browser, options})
  def send_frame(server, frame), do: GenServer.cast(server, {:send, frame})
  def close(server, code, reason), do: GenServer.call(server, {:close, code, reason}, 1_500)

  @doc false
  def frame_allowed?(payload), do: byte_size(payload) <= @maximum_frame_bytes

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
    case write_frame(state, frame) do
      {:ok, state} -> {:noreply, state}
      :error -> stop_upstream(state)
    end
  end

  @impl true
  def handle_call({:close, code, reason}, from, state) do
    case write_frame(state, {:close, code, reason}) do
      {:ok, state} ->
        timer = Process.send_after(self(), :close_timeout, 1_000)
        {:noreply, Map.merge(state, %{closing_from: from, close_timer: timer})}

      :error ->
        {:stop, :normal, :error, state}
    end
  end

  @impl true
  def handle_info(:close_timeout, state) do
    state = finish_closing(state, :timeout)
    {:stop, :normal, state}
  end

  @impl true
  def handle_info(message, state) do
    case Mint.WebSocket.stream(state.connection, message) do
      {:ok, connection, responses} ->
        case decode_responses(responses, %{state | connection: connection}) do
          {:ok, state} ->
            {:noreply, state}

          {:closed, state} ->
            state = finish_closing(state, :ok)
            {:stop, :normal, state}
        end

      :unknown ->
        {:noreply, state}

      _ ->
        stop_upstream(state)
    end
  end

  defp decode_responses(responses, state) do
    Enum.reduce_while(responses, {:ok, state}, fn
      {:data, reference, data}, {:ok, state} when reference == state.reference ->
        case Mint.WebSocket.decode(state.websocket, data) do
          {:ok, websocket, frames} ->
            case decode_frames(frames, %{state | websocket: websocket}) do
              {:ok, state} -> {:cont, {:ok, state}}
              {:closed, state} -> {:halt, {:closed, state}}
            end

          _ ->
            send(state.browser, :upstream_closed)
            {:halt, {:closed, state}}
        end

      _, result ->
        {:cont, result}
    end)
  end

  defp decode_frames(frames, state) do
    Enum.reduce_while(frames, {:ok, state}, fn
      {type, payload}, {:ok, state} when type in [:text, :binary] ->
        if frame_allowed?(payload) do
          send(state.browser, {:upstream, {type, payload}})
          {:cont, {:ok, state}}
        else
          state = close_oversized_upstream(state)
          send(state.browser, {:upstream_closed, 1009, "message too large"})
          {:halt, {:closed, state}}
        end

      {:close, code, reason}, {:ok, state} ->
        send(state.browser, {:upstream_closed, code, reason})
        {:halt, {:closed, state}}

      _, result ->
        {:cont, result}
    end)
  end

  defp close_oversized_upstream(state) do
    case write_frame(state, {:close, 1009, "message too large"}) do
      {:ok, state} -> state
      :error -> state
    end
  end

  defp write_frame(state, frame) do
    with {:ok, websocket, data} <- Mint.WebSocket.encode(state.websocket, frame),
         {:ok, connection} <-
           Mint.WebSocket.stream_request_body(state.connection, state.reference, data) do
      {:ok, %{state | websocket: websocket, connection: connection}}
    else
      _ -> :error
    end
  end

  defp stop_upstream(state) do
    send(state.browser, :upstream_closed)
    state = finish_closing(state, :error)
    {:stop, :normal, state}
  end

  defp finish_closing(%{closing_from: from, close_timer: timer} = state, result) do
    Process.cancel_timer(timer)
    GenServer.reply(from, result)
    Map.drop(state, [:closing_from, :close_timer])
  end

  defp finish_closing(state, _result), do: state

  @impl true
  def terminate(_reason, state), do: Mint.HTTP.close(state.connection)
end
