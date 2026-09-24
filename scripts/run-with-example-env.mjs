import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const [envFile, command, ...args] = process.argv.slice(2);
if (!envFile || !command) {
  console.error("Usage: node scripts/run-with-example-env.mjs <env-file> <command> [args...]");
  process.exitCode = 2;
} else {
  const fixture = Object.fromEntries(
    (await readFile(envFile, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid environment entry in ${envFile}.`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...fixture, ...process.env },
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
