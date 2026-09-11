import { spawnSync } from "node:child_process";

export default function stopPhpLaravelContainer() {
  spawnSync("docker", ["stop", "--timeout", "15", "cormier-php-laravel-playwright"], { stdio: "ignore" });
}
