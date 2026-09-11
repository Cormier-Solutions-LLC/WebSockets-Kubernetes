require "json"
require "minitest/autorun"
require "stringio"
require_relative "../lib/reference_config"
require_relative "../lib/limited_body_reader"

class ReferenceConfigTest < Minitest::Test
  def values
    {
      "LISTEN_HOST" => "127.0.0.1",
      "PORT" => "15500",
      "PUBLIC_ORIGIN" => "http://127.0.0.1:15500",
      "GATEWAY_URL" => "http://127.0.0.1:15501",
      "REDIS_URL" => "redis://127.0.0.1:6379",
      "SESSION_SECRET" => "x" * 32,
      "SESSION_LIFETIME_SECONDS" => "1200",
      "INSTANCE_NAME" => "ruby-rails-a",
      "TOPOLOGY" => "non-ha",
      "REDIS_INSTANCE_PREFIX" => "cormier:test",
      "REDIS_SESSION_KEY_PREFIX" => "sessions",
      "ALLOWED_TENANTS" => "tenant-a",
      "ALLOWED_USERS" => "user-a"
    }
  end

  def test_typed_configuration
    config = ReferenceConfig.load(values)
    assert_equal "127.0.0.1", config.listen_host
    assert_equal 15_500, config.port
    assert config.allows?("tenant-a", "user-a")
    assert_equal "cormier:test:sessions:id", config.session_key("id")
    root = File.expand_path("../../..", __dir__)
    assert_equal File.join(root, "examples/shared-web/wwwroot"), config.shared_asset_root
    assert_equal File.join(root, "sdk/typescript/dist"), config.sdk_asset_root
  end

  def test_rejects_unsafe_origin
    environment = values.merge("PUBLIC_ORIGIN" => "file:///tmp")
    assert_raises(ArgumentError) { ReferenceConfig.load(environment) }
  end

  def test_rejects_explicit_default_origin_port
    environment = values.merge("PUBLIC_ORIGIN" => "https://example.test:443")
    assert_raises(ArgumentError) { ReferenceConfig.load(environment) }
  end

  def test_rejects_noncanonical_origin_casing
    environment = values.merge("PUBLIC_ORIGIN" => "https://EXAMPLE.TEST")
    assert_raises(ArgumentError) { ReferenceConfig.load(environment) }
  end

  def test_rejects_out_of_range_origin_port
    environment = values.merge("PUBLIC_ORIGIN" => "https://example.test:99999")
    assert_raises(ArgumentError) { ReferenceConfig.load(environment) }
  end

  def test_rejects_malformed_origin_network_hosts
    %w[PUBLIC_ORIGIN GATEWAY_URL].product(%w[a..b -bad.example bad-.example 999.999.999.999 127.1]).each do |name, host|
      assert_raises(ArgumentError, "#{name} accepted #{host}") do
        ReferenceConfig.load(values.merge(name => "https://#{host}"))
      end
    end
  end

  def test_accepts_full_ipv6_origin_hosts
    environment = values.merge("PUBLIC_ORIGIN" => "https://[::1]", "GATEWAY_URL" => "http://[2001:db8::1]:15501")
    assert_equal "https://[::1]", ReferenceConfig.load(environment).public_origin
  end

  def test_canonical_contracts
    root = File.expand_path("../../..", __dir__)
    schema = JSON.parse(File.read(File.join(root, "examples/shared-web/reference-app.schema.json")))
    sdk = JSON.parse(File.read(File.join(root, "sdk/typescript/dist/version.json")))
    protocol = JSON.parse(File.read(File.join(root, "protocol/fixtures/v1/envelopes.json")))
    assert_includes schema.fetch("required"), "PUBLIC_ORIGIN"
    assert_equal "1.0", sdk.fetch("protocolVersion")
    assert_equal "1.0", protocol.fetch("protocolVersion")
  end

  def test_limited_body_reader_accepts_the_boundary
    body = "a" * (64 * 1_024)
    assert_equal body, LimitedBodyReader.read(StringIO.new(body), limit: body.bytesize)
  end

  def test_limited_body_reader_rejects_a_chunked_oversized_body
    stream = StringIO.new("a" * (64 * 1_024) + "b")
    assert_raises(LimitedBodyReader::TooLarge) do
      LimitedBodyReader.read(stream, limit: 64 * 1_024)
    end
  end

  def test_caddy_caps_login_and_ticket_bodies_before_rack_parses_them
    caddyfile = File.read(File.expand_path("../Caddyfile", __dir__))
    assert_includes caddyfile, "@bounded_request path /api/login /realtime/tickets"
    assert_includes caddyfile, "request_body @bounded_request"
    assert_includes caddyfile, "max_size 65536"
  end

  def test_preflight_checks_the_sdk_bundle_loaded_by_the_shared_page
    startup = File.read(File.expand_path("../start.sh", __dir__))
    %w[index.html app.css app.js].each { |asset| assert_includes startup, asset }
    assert_includes startup, "cormier-realtime.iife.js"
    refute_includes startup, "cormier-realtime.iife.min.js"
    assert_includes startup, 'readiness_url="http://$readiness_host:$PORT/api/diagnostics"'
    assert_includes startup, '--header "Host: $public_authority"'
    assert_includes startup, 'payload["stack"] == "Ruby / Rails"'
    assert_equal 2, startup.scan('[ "$attempt" -lt 150 ] || failure').length
    assert_operator startup.index("readiness_url="), :<, startup.index("application_started")
  end

  def test_ticket_responses_are_streamed_through_a_strict_limit
    controller = File.read(File.expand_path("../app/controllers/reference_controller.rb", __dir__))
    assert_includes controller, "response.read_body { |chunk| append.call(chunk) }"
    assert_includes controller, "LimitedBodyReader.collect(limit: MAXIMUM_UPSTREAM_BYTES)"
    assert_includes controller, "Timeout.timeout(TICKET_DEADLINE_SECONDS)"
    assert_includes controller, "http.start do |connection|"

    boundary = "a" * (64 * 1_024)
    assert_equal boundary, LimitedBodyReader.collect(limit: boundary.bytesize) { |append| append.call(boundary) }
    assert_raises(LimitedBodyReader::ResponseTooLarge) do
      LimitedBodyReader.collect(limit: boundary.bytesize) do |append|
        append.call(boundary)
        append.call("b")
      end
    end
  end
end
