require "redis"

settings = Rails.configuration.x.reference
client = Redis.new(
  url: settings.redis_url,
  connect_timeout: 5,
  read_timeout: 5,
  write_timeout: 5
)
client.ping
Rails.configuration.x.redis = client

at_exit do
  client.close
end
