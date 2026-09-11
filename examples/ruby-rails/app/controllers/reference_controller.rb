require "json"
require "date"
require "net/http"
require "securerandom"
require "time"
require "timeout"
require_relative "../../lib/limited_body_reader"

class ReferenceController < ApplicationController
  MAXIMUM_BODY_BYTES = 64 * 1_024
  MAXIMUM_UPSTREAM_BYTES = 64 * 1_024
  TICKET_DEADLINE_SECONDS = 15
  SESSION_COOKIE = "cormier_session"
  RFC3339_TIMESTAMP = /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\z/

  def self.valid_future_expiration?(value, now = Time.now.utc)
    return false unless value.is_a?(String) && RFC3339_TIMESTAMP.match?(value)

    components = Date._iso8601(value)
    Date.valid_date?(components.fetch(:year), components.fetch(:mon), components.fetch(:mday)) &&
      Time.iso8601(value) > now
  rescue ArgumentError, KeyError
    false
  end

  def index
    shared_asset("index.html", "text/html; charset=utf-8")
  end

  def css
    shared_asset("app.css", "text/css; charset=utf-8")
  end

  def javascript
    shared_asset("app.js", "text/javascript; charset=utf-8")
  end

  def sdk_asset
    name = params[:asset].to_s
    return head :not_found unless /\A[A-Za-z0-9._-]+\z/.match?(name)

    send_asset(File.join(settings.sdk_asset_root, name), name.end_with?(".js") ? "text/javascript; charset=utf-8" : "application/json")
  end

  def health
    redis.ping
    render json: { status: "healthy" }
  rescue Redis::BaseError
    render json: { status: "unavailable" }, status: :service_unavailable
  end

  def diagnostics
    redis_status = begin
      redis.ping
      "ready"
    rescue Redis::BaseError
      "unavailable"
    end
    render json: {
      stack: "Ruby / Rails",
      topology: settings.topology,
      instance: settings.instance_name,
      redis: redis_status,
      timestamp: Time.now.utc.iso8601
    }
  end

  def login
    return unless require_origin

    tenant = params[:tenantId].to_s
    user = params[:userId].to_s
    unless settings.allows?(tenant, user)
      return render json: { code: "invalid_identity", message: "Select a configured test tenant and user." }, status: :bad_request
    end

    id = SecureRandom.urlsafe_base64(36, false)
    expires_at = Time.now.utc + settings.session_lifetime
    record = { tenantId: tenant, userId: user, allowedTopics: %w[orders notifications], expiresAt: expires_at.iso8601(6), revoked: false }
    redis.set(settings.session_key(id), JSON.generate(record), ex: settings.session_lifetime)
    cookies[SESSION_COOKIE] = {
      value: id,
      expires: expires_at,
      httponly: true,
      same_site: :strict,
      secure: settings.public_origin.start_with?("https://")
    }
    session[:reference_authenticated] = true
    render json: record
  rescue Redis::BaseError
    dependency_unavailable
  end

  def session_status
    record = read_session
    return render json: { code: "authentication_required", message: "Authentication is required." }, status: :unauthorized unless record

    render json: { authenticated: true }.merge(record)
  rescue Redis::BaseError, JSON::ParserError
    dependency_unavailable
  end

  def logout
    return unless require_origin

    id = cookies[SESSION_COOKIE].to_s
    redis.del(settings.session_key(id)) if valid_session_id?(id)
    reset_session
    cookies.delete(SESSION_COOKIE)
    head :no_content
  rescue Redis::BaseError
    dependency_unavailable
  end

  def ticket
    return unless require_origin
    return render(json: { code: "authentication_required", message: "Authentication is required." }, status: :unauthorized) unless read_session
    return render(json: { code: "invalid_request", message: "The request is invalid." }, status: :content_too_large) if request.content_length.to_i > MAXIMUM_BODY_BYTES

    body = LimitedBodyReader.read(request.body, limit: MAXIMUM_BODY_BYTES)

    status, content_type, response_body = forward_ticket(body)
    render body: response_body, status: status, content_type: content_type
  rescue LimitedBodyReader::TooLarge
    render json: { code: "invalid_request", message: "The request is invalid." }, status: :content_too_large
  rescue IOError, SystemCallError, Timeout::Error, Redis::BaseError, JSON::ParserError, LimitedBodyReader::ResponseTooLarge
    dependency_unavailable
  end

  private

  def shared_asset(name, type)
    send_asset(File.join(settings.shared_asset_root, name), type)
  end

  def send_asset(path, type)
    return head :not_found unless File.file?(path)

    send_file path, type: type, disposition: "inline"
  end

  def valid_session_id?(id)
    /\A[A-Za-z0-9_-]{16,256}\z/.match?(id)
  end

  def read_session
    return nil unless session[:reference_authenticated] == true

    id = cookies[SESSION_COOKIE].to_s
    return nil unless valid_session_id?(id)

    encoded = redis.get(settings.session_key(id))
    return nil unless encoded

    record = JSON.parse(encoded)
    expires_at = record.fetch("expiresAt")
    return nil unless self.class.valid_future_expiration?(expires_at)
    return nil if record.fetch("revoked", true)

    record
  rescue KeyError, ArgumentError
    nil
  end

  def forward_ticket(body)
    uri = settings.gateway_uri.dup
    uri.path = "/realtime/tickets"
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.open_timeout = 5
    http.read_timeout = 15
    http.write_timeout = 5
    upstream = Net::HTTP::Post.new(uri)
    upstream["Host"] = request.host_with_port
    upstream["X-Forwarded-Proto"] = settings.public_uri.scheme
    %w[Origin Cookie Content-Type].each do |header|
      value = request.headers[header]
      upstream[header] = value if value.present?
    end
    upstream.body = body
    status = nil
    content_type = nil
    response_body = nil
    Timeout.timeout(TICKET_DEADLINE_SECONDS) do
      http.start do |connection|
        connection.request(upstream) do |response|
          status = response.code.to_i
          content_type = response["Content-Type"] || "application/json"
          response_body = LimitedBodyReader.collect(limit: MAXIMUM_UPSTREAM_BYTES) do |append|
            response.read_body { |chunk| append.call(chunk) }
          end
        end
      end
    end
    [ status, content_type, response_body ]
  end
end
