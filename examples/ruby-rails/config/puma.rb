threads 1, 5
workers 0
bind "unix:///tmp/cormier-rails.sock"
environment ENV.fetch("RAILS_ENV", "production")
preload_app!
