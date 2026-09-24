defmodule CormierRealtimeExample.MixProject do
  use Mix.Project

  def project do
    [
      app: :cormier_realtime_example,
      version: "1.0.2-beta",
      elixir: "~> 1.20.4",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [mod: {CormierRealtimeExample.Application, []}, extra_applications: [:logger, :crypto]]
  end

  defp deps do
    [
      {:phoenix, "1.8.13"},
      {:bandit, "1.12.5"},
      {:redix, "1.9.1"},
      {:req, "0.7.4"},
      {:mint_web_socket, "1.0.6"},
      {:castore, "1.0.21"},
      {:websock_adapter, "0.6.0"},
      {:jason, "1.4.5"}
    ]
  end
end
