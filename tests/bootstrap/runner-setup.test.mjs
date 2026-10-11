import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const action = readFileSync(new URL('.github/actions/setup-cormier-runner/action.yml', root), 'utf8');
const setup = './.github/actions/setup-cormier-runner';
const scripts = [...action.matchAll(/^      run: \|\n((?:        .*\n|\n)+)/gm)]
  .map(match => match[1].replace(/^        /gm, ''));

test('all Linux jobs use shared setup after checkout and before dependent steps', () => {
  for (const file of readdirSync(new URL('.github/workflows/', root)).filter(file => file.endsWith('.yml'))) {
    const workflow = readFileSync(new URL(`.github/workflows/${file}`, root), 'utf8');
    for (const match of workflow.matchAll(/^  ([\w-]+):\n((?:(?!^  [\w-]+:)[\s\S])*)/gm)) {
      const [, name, job] = match;
      if (!job.includes('runs-on:')) continue;
      if (file === 'ci.yml' && name === 'bootstrap-powershell-windows') {
        assert.match(job, /runs-on: windows-latest/);
        assert.ok(!job.includes(setup));
        continue;
      }
      assert.match(job, /runs-on: cormier-runners/, `${file}: ${name}`);
      const setupIndex = job.indexOf(`uses: ${setup}`);
      assert.ok(setupIndex > job.indexOf('uses: actions/checkout@'), `${file}: ${name} setup follows checkout`);
      assert.ok(setupIndex >= 0, `${file}: ${name} includes setup`);
      const stepsBeforeSetup = job.slice(job.indexOf('    steps:'), setupIndex);
      assert.ok(!/\n        (?:run|shell):/.test(stepsBeforeSetup), `${file}: ${name} runs setup before scripts`);
      if (/docker\/login-action|docker (?:run|build|load)|start-ci-redis|    services:/.test(job)) {
        assert.match(job.slice(setupIndex), /^uses: .*setup-cormier-runner\n        with:\n          docker: 'true'/);
      }
    }
  }
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.match(ci, /native-aot: 'true'/);
  assert.match(ci, /build-tools: 'true'/);
  assert.match(ci, /shellcheck: 'true'/);
});

test('setup validation is triggered by workflow and local action changes', () => {
  const workflow = readFileSync(new URL('.github/workflows/runner-setup.yml', root), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.equal(workflow.match(/'\.github\/actions\/\*\*'/g).length, 2);
  assert.equal(workflow.match(/'\.github\/workflows\/\*\*'/g).length, 2);
  assert.match(workflow, /node --test tests\/bootstrap\/runner-setup\.test\.mjs/);
});

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cormier-runner-setup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'packages.log');
  const commands = {
    'dpkg-query': 'if [[ "$FIXTURE_INSTALLED" == true ]]; then printf "install ok installed"; else exit 1; fi',
    'apt-get': 'printf "%s\\n" "$*" >> "$FIXTURE_LOG"',
    sudo: '[[ "$1" != -n ]] || shift; exec "$@"',
    docker: '[[ "$FIXTURE_DOCKER" == true ]]',
  };
  for (const [name, script] of Object.entries(commands)) {
    writeFileSync(join(directory, name), `#!/bin/bash\nset -euo pipefail\n${script}\n`, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${directory}:/usr/bin:/bin`,
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    SETUP_DOCKER: 'false',
    SETUP_NATIVE_AOT: 'false',
    SETUP_BUILD_TOOLS: 'false',
    SETUP_SHELLCHECK: 'false',
    FIXTURE_INSTALLED: 'false',
    FIXTURE_DOCKER: 'true',
    FIXTURE_LOG: log,
    ...overrides,
  };
  return {
    run: (index = 0) => spawnSync('bash', ['-c', scripts[index]], { env, encoding: 'utf8' }),
    log,
  };
}

test('installs common and requested native prerequisites without a daemon startup', t => {
  assert.equal(scripts.length, 2);
  const current = fixture(t, { SETUP_NATIVE_AOT: 'true', SETUP_BUILD_TOOLS: 'true', SETUP_SHELLCHECK: 'true' });
  const result = current.run();
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(current.log, 'utf8');
  assert.match(log, /^update\ninstall --yes --no-install-recommends /);
  for (const packageName of ['curl', 'git', 'jq', 'libatomic1', 'clang', 'zlib1g-dev', 'build-essential', 'shellcheck']) {
    assert.ok(log.split(/\s+/).includes(packageName), packageName);
  }
  assert.doesNotMatch(action, /(?:systemctl|service) (?:start|restart)|dockerd &/);
});

test('preinstalled prerequisites need no package installation', t => {
  const current = fixture(t, { FIXTURE_INSTALLED: 'true' });
  const result = current.run();
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => readFileSync(current.log), { code: 'ENOENT' });
});

test('rejects unsupported runners and invalid inputs before installing', t => {
  for (const override of [{ RUNNER_OS: 'Windows' }, { RUNNER_ARCH: 'ARM64' }, { SETUP_DOCKER: 'yes' }]) {
    const current = fixture(t, override);
    assert.notEqual(current.run().status, 0);
    assert.throws(() => readFileSync(current.log), { code: 'ENOENT' });
  }
});

test('Docker jobs fail clearly when the runner daemon is unavailable', t => {
  const current = fixture(t, { FIXTURE_DOCKER: 'false' });
  const result = current.run(1);
  assert.notEqual(result.status, 0);
  // Buildx must be available before checking the daemon.
  const daemon = fixture(t);
  writeFileSync(join(daemon.log, '..', 'docker'), '#!/bin/bash\n[[ "$1" != info ]]\n', { mode: 0o755 });
  const failure = daemon.run(1);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Configure ARC with Docker-in-Docker/);
});
