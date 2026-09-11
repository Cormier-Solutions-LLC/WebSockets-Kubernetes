defmodule CormierRealtimeExample.Application do
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    with {:ok, config} <- CormierRealtimeExample.Config.load() do
      Application.put_env(:cormier_realtime_example, :runtime_config, config)

      Application.put_env(
        :cormier_realtime_example,
        CormierRealtimeExample.Endpoint,
        Keyword.merge(
          Application.get_env(:cormier_realtime_example, CormierRealtimeExample.Endpoint),
          http: [ip: {0, 0, 0, 0}, port: config.port],
          secret_key_base: :crypto.strong_rand_bytes(64) |> Base.encode64()
        )
      )

      children = [
        {Phoenix.PubSub, name: CormierRealtimeExample.PubSub},
        {Redix,
         {config.redis_url,
          [
            name: CormierRealtimeExample.Redis,
            sync_connect: true,
            timeout: 5_000
          ]}},
        CormierRealtimeExample.Endpoint
      ]

      case Supervisor.start_link(children,
             strategy: :one_for_one,
             name: CormierRealtimeExample.Supervisor
           ) do
        {:ok, pid} ->
          Logger.warning("application started", event: "application_started")
          {:ok, pid}

        other ->
          startup_failure(other)
      end
    else
      other -> startup_failure(other)
    end
  end

  @impl true
  def stop(_state), do: Logger.warning("application stopped", event: "application_stopped")

  defp startup_failure(_reason) do
    Logger.error("application startup failed", event: "startup_failed")
    {:error, :startup_failed}
  end
end
