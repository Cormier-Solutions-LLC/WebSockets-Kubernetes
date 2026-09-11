require "json"

class ApplicationController < ActionController::Base
  skip_forgery_protection

  after_action :security_headers
  rescue_from StandardError, with: :internal_error

  private

  def settings
    Rails.configuration.x.reference
  end

  def redis
    Rails.configuration.x.redis
  end

  def require_origin
    return true if request.headers["Origin"] == settings.public_origin

    render json: { code: "origin_rejected", message: "The request Origin is not allowed." }, status: :forbidden
    false
  end

  def dependency_unavailable
    render json: { code: "service_unavailable", message: "The reference application dependency is unavailable." }, status: :service_unavailable
  end

  def security_headers
    response.headers.merge!(
      "Cache-Control" => "no-store",
      "Content-Security-Policy" => "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'",
      "Referrer-Policy" => "no-referrer",
      "X-Content-Type-Options" => "nosniff",
      "X-Frame-Options" => "DENY"
    )
  end

  def internal_error(error)
    $stderr.puts({ event: "request_failed", stack: "ruby-rails", errorType: error.class.name }.to_json)
    render json: { code: "internal_error", message: "The request could not be completed." }, status: :internal_server_error
  end
end
