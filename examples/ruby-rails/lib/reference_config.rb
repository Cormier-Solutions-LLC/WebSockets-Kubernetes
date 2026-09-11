require "set"
require "uri"

class ReferenceConfig
  IDENTIFIER = /\A[A-Za-z0-9._-]{1,128}\z/
  PREFIX = /\A[A-Za-z0-9._:-]{1,128}\z/

  attr_reader :listen_host, :port, :public_origin, :public_uri, :gateway_url, :gateway_uri, :redis_url,
    :session_secret, :session_lifetime, :instance_name, :topology, :redis_instance_prefix,
    :redis_session_key_prefix, :allowed_tenants, :allowed_users, :shared_asset_root, :sdk_asset_root

  def self.load(environment)
    new(environment)
  end

  def initialize(environment)
    @listen_host = identifier(required(environment, "LISTEN_HOST"), /\A[A-Za-z0-9._:-]{1,253}\z/)
    @port = integer(required(environment, "PORT"), 1_024..65_535)
    @public_origin, @public_uri = origin(required(environment, "PUBLIC_ORIGIN"))
    @gateway_url, @gateway_uri = origin(required(environment, "GATEWAY_URL"))
    @redis_url = redis(required(environment, "REDIS_URL"))
    @session_secret = required(environment, "SESSION_SECRET")
    raise ArgumentError, "session configuration is invalid" unless (32..4_096).cover?(@session_secret.bytesize)

    @session_lifetime = integer(required(environment, "SESSION_LIFETIME_SECONDS"), 60..7_200)
    @instance_name = identifier(required(environment, "INSTANCE_NAME"))
    @topology = required(environment, "TOPOLOGY")
    raise ArgumentError, "topology configuration is invalid" unless %w[ha non-ha].include?(@topology)

    @redis_instance_prefix = identifier(required(environment, "REDIS_INSTANCE_PREFIX"), PREFIX)
    @redis_session_key_prefix = identifier(required(environment, "REDIS_SESSION_KEY_PREFIX"))
    @allowed_tenants = allowlist(required(environment, "ALLOWED_TENANTS"))
    @allowed_users = allowlist(required(environment, "ALLOWED_USERS"))
    @shared_asset_root = File.expand_path(environment.fetch("SHARED_ASSET_ROOT", "../../shared-web/wwwroot"), __dir__)
    @sdk_asset_root = File.expand_path(environment.fetch("SDK_ASSET_ROOT", "../../../sdk/typescript/dist"), __dir__)
  end

  def allows?(tenant, user)
    allowed_tenants.include?(tenant) && allowed_users.include?(user)
  end

  def session_key(id)
    "#{redis_instance_prefix}:#{redis_session_key_prefix}:#{id}"
  end

  private

  def required(environment, name)
    value = environment[name]
    raise ArgumentError, "required configuration is missing" if value.nil? || value.strip.empty?

    value
  end

  def integer(value, range)
    number = Integer(value, 10)
    raise ArgumentError, "numeric configuration is invalid" unless range.cover?(number)

    number
  rescue ArgumentError
    raise ArgumentError, "numeric configuration is invalid"
  end

  def origin(value)
    uri = URI.parse(value)
    explicit_default_port = value.match?(%r{\Ahttp://[^/?#]+:80(?:/|\z)}i) ||
      value.match?(%r{\Ahttps://[^/?#]+:443(?:/|\z)}i)
    unless value == value.downcase && %w[http https].include?(uri.scheme) && uri.host && uri.userinfo.nil? && uri.query.nil? && uri.fragment.nil? &&
        [ "", "/" ].include?(uri.path) && !explicit_default_port
      raise ArgumentError, "origin configuration is invalid"
    end

    normalized = value.delete_suffix("/")
    [ normalized, URI.parse(normalized) ]
  rescue URI::InvalidURIError
    raise ArgumentError, "origin configuration is invalid"
  end

  def redis(value)
    uri = URI.parse(value)
    raise ArgumentError, "Redis configuration is invalid" unless %w[redis rediss].include?(uri.scheme) && uri.host && uri.fragment.nil?

    value
  rescue URI::InvalidURIError
    raise ArgumentError, "Redis configuration is invalid"
  end

  def identifier(value, pattern = IDENTIFIER)
    raise ArgumentError, "identifier configuration is invalid" unless pattern.match?(value)

    value
  end

  def allowlist(value)
    items = value.split(",").map(&:strip).to_set
    raise ArgumentError, "allowlist configuration is invalid" if items.empty? || items.any? { |item| !IDENTIFIER.match?(item) }

    items.freeze
  end
end
