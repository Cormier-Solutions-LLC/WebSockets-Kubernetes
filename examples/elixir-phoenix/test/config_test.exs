defmodule CormierRealtimeExample.ConfigTest do
  use ExUnit.Case, async: true
  alias CormierRealtimeExample.Config
  alias CormierRealtimeExample.Application, as: ReferenceApplication
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
    invalid = Map.put(values, "PUBLIC_ORIGIN", "https://example.test:99999")
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

  test "bounds streamed ticket responses" do
    request = Req.new()
    response = Req.Response.new(body: "")
    boundary = :binary.copy("a", 65_536)

    assert {:cont, {^request, bounded}} =
             Web.collect_response_chunk({:data, boundary}, {request, response})

    assert IO.iodata_length(bounded.body) == 65_536

    assert {:halt, {^request, overflow}} =
             Web.collect_response_chunk({:data, "b"}, {request, bounded})

    assert overflow.body == :too_large
  end

  test "rejects and drains oversized request bodies" do
    conn = Plug.Test.conn(:post, "/realtime/tickets", :binary.copy("a", 65_537))
    assert {:error, :too_large, drained} = Web.read_bounded_body(conn)
    assert {:ok, "", _conn} = Plug.Conn.read_body(drained)
  end

  test "brackets IPv6 forwarding authorities" do
    assert Web.authority(%{host: "::1", port: 15_600, scheme: :http}) == "[::1]:15600"
    assert Web.authority(%{host: "example.test", port: 443, scheme: :https}) == "example.test"
  end

  test "authenticates secure Redis peers" do
    options = ReferenceApplication.redis_start_options("rediss://cache.example.test:6380")
    socket_options = Keyword.fetch!(options, :socket_opts)
    assert socket_options[:verify] == :verify_peer
    assert socket_options[:cacertfile] == CAStore.file_path()
    assert socket_options[:server_name_indication] == ~c"cache.example.test"
    assert is_function(socket_options[:customize_hostname_check][:match_fun], 2)
  end
end
