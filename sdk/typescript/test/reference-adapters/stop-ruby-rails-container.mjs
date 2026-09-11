import { spawnSync } from "node:child_process";

export default function stopRubyRailsContainer() {
  spawnSync("docker", ["stop", "--timeout", "15", "cormier-ruby-rails-playwright"], { stdio: "ignore" });
}
