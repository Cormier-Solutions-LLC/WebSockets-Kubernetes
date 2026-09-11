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
end
