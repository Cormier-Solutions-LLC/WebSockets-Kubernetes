import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export default function stopPhpLaravelContainer() {
  spawnSync("docker", ["stop", "--timeout", "15", "cormier-php-laravel-playwright"], { stdio: "ignore" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stopPhpLaravelContainer();
}
