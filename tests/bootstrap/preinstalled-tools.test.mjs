import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const linuxOnly = { skip: process.platform !== 'linux' };

test('every CI browser installer resolves from its declared working directory', () => {
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const steps = workflow.split(/\r?\n      - /).filter(step => step.includes('setup-ci-playwright.sh'));
  assert.equal(steps.length, 12);
  for (const step of steps) {
    const directory = step.match(/working-directory: (\S+)/)?.[1] ?? '.';
    const script = step.match(/run: bash (\S+)/)?.[1];
    assert.ok(script, step);
    const resolved = new URL(script, new URL(`${directory}/`, root));
    assert.equal(resolved.href, new URL('scripts/setup-ci-playwright.sh', root).href);
    assert.ok(existsSync(resolved), `${directory}: ${script}`);
  }
});

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'preinstalled-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'commands.log');
  const version = join(directory, 'npm-version');
  writeFileSync(version, overrides.npm ?? '12.1.0');
  const commands = {
    curl: 'echo curl >> "$FIXTURE_LOG"; exit 99',
    pwsh: 'echo "${FIXTURE_PWSH_VERSION:-7.6.6}"',
    npx: 'if [[ "$*" == *--version* ]]; then echo "Version 1.63.0"; else echo "$*" >> "$FIXTURE_LOG"; fi',
    npm: 'if [[ "$1" == --version ]]; then cat "$FIXTURE_NPM_VERSION"; else echo "$*" >> "$FIXTURE_LOG"; [[ "$FIXTURE_NPM_FAILURE" != true ]] || exit 42; echo 12.1.0 > "$FIXTURE_NPM_VERSION"; fi',
  };
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(directory, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  }
  const manifest = join(directory, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ downloads: { 'pwsh.tar.gz': { sha256: 'expected' } }, tools: { playwright: '1.63.0 (chromium, firefox, webkit)' } }));
  return {
    directory, log, manifest,
    env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE_LOG: log,
      FIXTURE_NPM_VERSION: version, FIXTURE_NPM_FAILURE: 'false',
      CI_RUNNER_MANIFEST: manifest, CI_POWERSHELL_VERSION: '7.6.6',
      CI_POWERSHELL_LINUX_X64_SHA256: 'expected', CI_POWERSHELL_DOWNLOAD_BASE_URL: 'https://example.invalid',
      RUNNER_TEMP: directory, GITHUB_PATH: join(directory, 'github-path'), NPM_VERSION: '12.1.0',
      ...overrides.env,
    },
  };
}
function bash(script, current, args = []) {
  return spawnSync('bash', [new URL(`scripts/${script}`, root).pathname, ...args], { env: current.env, encoding: 'utf8' });
}

test('matching PowerShell version and image archive checksum reuse the binary without downloads', linuxOnly, t => {
  const current = fixture(t);
  const result = bash('setup-ci-powershell.sh', current);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Using preinstalled PowerShell 7.6.6/);
  assert.equal(readFileSync(current.env.GITHUB_PATH, 'utf8').trim(), current.directory);
  assert.throws(() => readFileSync(current.log), { code: 'ENOENT' });
});

test('a changed PowerShell version or checksum retains the download fallback', linuxOnly, t => {
  for (const env of [{ FIXTURE_PWSH_VERSION: '7.5.0' }, { CI_POWERSHELL_LINUX_X64_SHA256: 'different' }, { CI_RUNNER_MANIFEST: '/missing/manifest.json' }]) {
    const current = fixture(t, { env });
    assert.equal(bash('setup-ci-powershell.sh', current).status, 99);
    assert.match(readFileSync(current.log, 'utf8'), /curl/);
  }
});

test('matching Playwright release avoids apt but still checks browser revisions', linuxOnly, t => {
  const current = fixture(t);
  const result = bash('setup-ci-playwright.sh', current, ['chromium', 'webkit']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(current.log, 'utf8').trim(), '--no-install playwright install chromium webkit');
});

test('changed Playwright release or absent manifest installs system dependencies', linuxOnly, t => {
  for (const missing of [false, true]) {
    const current = fixture(t);
    if (missing) current.env.CI_RUNNER_MANIFEST = '/missing/manifest.json';
    else writeFileSync(current.manifest, JSON.stringify({ tools: { playwright: '1.62.0 (chromium)' } }));
    assert.equal(bash('setup-ci-playwright.sh', current, ['chromium']).status, 0);
    assert.match(readFileSync(current.log, 'utf8'), /install --with-deps chromium/);
  }
});

test('matching npm is reused; mismatches install and installation failures propagate', linuxOnly, t => {
  for (const [npm, failed, expected] of [['12.1.0', false, 0], ['11.0.0', false, 0], ['11.0.0', true, 42]]) {
    const current = fixture(t, { npm, env: { FIXTURE_NPM_FAILURE: String(failed) } });
    const result = spawnSync(process.execPath, [new URL('scripts/setup-ci-npm.mjs', root).pathname], { env: current.env, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    if (npm === '12.1.0') assert.throws(() => readFileSync(current.log), { code: 'ENOENT' });
    else assert.match(readFileSync(current.log, 'utf8'), /install --global npm@12.1.0/);
  }
});

test('npm setup reuses the installed version through the Windows npm command shim', {
  skip: process.platform !== 'win32',
}, () => {
  const current = spawnSync('npm --version', { shell: true, encoding: 'utf8' });
  assert.equal(current.status, 0, current.stderr);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/setup-ci-npm.mjs', root))], {
    env: { ...process.env, NPM_VERSION: current.stdout.trim() }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Using npm/);
});
