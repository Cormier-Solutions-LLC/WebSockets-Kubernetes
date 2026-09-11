require_relative "boot"

require "rails"
require "action_controller/railtie"
require "action_view/railtie"
require "rails/test_unit/railtie"
require "digest"
require "logger"

require_relative "../lib/reference_config"

module CormierRealtimeExample
  class Application < Rails::Application
    config.load_defaults 8.1
    config.eager_load = true
    config.consider_all_requests_local = false
    config.action_dispatch.show_exceptions = :all
    config.logger = ActiveSupport::Logger.new(File::NULL)

    reference = ReferenceConfig.load(ENV)
    config.x.reference = reference
    config.secret_key_base = Digest::SHA256.hexdigest(reference.session_secret)
    config.session_store :cookie_store,
      key: "_cormier_realtime_reference",
      httponly: true,
      same_site: :strict,
      secure: reference.public_origin.start_with?("https://")
    config.hosts << reference.public_uri.host
    config.host_authorization = { exclude: ->(request) { request.path == "/health" } }
  end
end
