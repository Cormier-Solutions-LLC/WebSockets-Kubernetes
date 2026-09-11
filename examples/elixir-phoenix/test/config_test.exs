defmodule CormierRealtimeExample.ConfigTest do
  use ExUnit.Case, async: true
  alias CormierRealtimeExample.Config
  alias CormierRealtimeExample.Web

  defp values,
    do: %{
      "LISTEN_HOST" => "127.0.0.1",
      "PORT" => "15600",
      "PUBLIC_ORIGIN" => "http://127.0.0.1:15600",
      "GATEWAY_URL" => "http://127.0.0.1:15601",
      "REDIS_URL" => "redis://127.0.0.1:6379",
      "SESSION_LIFETIME_SECONDS" => "1200",
      "INSTANCE_NAME" => "elixir-phoenix-a",
      "TOPOLOGY" => "non-ha",
      "REDIS_INSTANCE_PREFIX" => "cormier:elixir-test",
      "REDIS_SESSION_KEY_PREFIX" => "sessions",
      "ALLOWED_TENANTS" => "tenant-a",
      "ALLOWED_USERS" => "user-a"
    }

  test "validates typed configuration" do
    values = values()
    assert {:ok, config = %{listen_host: "127.0.0.1", port: 15_600}} = Config.load(&values[&1])
    assert Config.public_scheme(config) == "http"
    invalid = Map.put(values, "PUBLIC_ORIGIN", "file:///tmp")
    assert {:error, :invalid_configuration} = Config.load(&invalid[&1])
    invalid = Map.put(values, "PUBLIC_ORIGIN", "https://example.test:443")
    assert {:error, :invalid_configuration} = Config.load(&invalid[&1])
    invalid = Map.put(values, "PUBLIC_ORIGIN", "https://EXAMPLE.TEST")
    assert {:error, :invalid_configuration} = Config.load(&invalid[&1])
  end

  test "consumes canonical contracts" do
    schema = File.read!("../shared-web/reference-app.schema.json")
    Enum.each(Map.keys(values()), &assert(String.contains?(schema, ~s("#{&1}"))))
    assert File.read!("../../sdk/typescript/dist/version.json") =~ ~s("protocolVersion": "1.0")
    assert File.read!("../../protocol/fixtures/v1/envelopes.json") =~ ~s("protocolVersion": "1.0")
  end

  test "requires the exact websocket subprotocol" do
    refute Web.offers_protocol?([])
    refute Web.offers_protocol?(["other, cormier.realtime.v10"])
    assert Web.offers_protocol?(["other", " cormier.realtime.v1"])
  end
end
