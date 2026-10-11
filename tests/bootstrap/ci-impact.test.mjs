import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { adapterJobs, changedFiles, checkResults, selectJobs, validationJobs } from '../../scripts/ci-impact.mjs';

const root = new URL('../../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');

test('documentation-only PRs skip validations, while main retains the release artifact pipeline', () => {
  assert.deepEqual(selectJobs(['README.md', 'docs/bootstrap.md', 'refs/snapshot.xml']), []);
  assert.deepEqual(selectJobs([], 'push'), validationJobs.filter(job => job !== 'dependency-review'));
  assert.deepEqual(selectJobs(null), validationJobs);
});

test('isolated adapter changes do not run unrelated adapters', () => {
  for (const adapter of adapterJobs) {
    assert.deepEqual(selectJobs([`examples/${adapter}/src/changed-file`]), ['build-test-aot', adapter]);
    assert.deepEqual(selectJobs([`examples/${adapter}/CHANGELOG.md`]), ['build-test-aot', adapter]);
  }
  assert.deepEqual(selectJobs(['examples/go-gin/go.mod']), ['build-test-aot', 'dependency-review', 'go-gin']);
  assert.deepEqual(selectJobs(['examples/python-fastapi/uv.lock']), ['build-test-aot', 'dependency-review', 'python-fastapi']);
});

test('shared runtime and browser changes exercise every downstream adapter', () => {
  for (const path of [
    'src/Cormier.Realtime.Contracts/ProtocolContracts.cs',
    'protocol/fixtures/v1/envelopes.json',
    'sdk/typescript/src/client.ts',
    'examples/shared-web/wwwroot/app.js',
    'examples/browser/index.html',
    'examples/full-circle/Program.cs',
  ]) {
    assert.deepEqual(selectJobs([path]), ['build-test-aot', ...adapterJobs, 'full-circle'], path);
  }
  assert.ok(selectJobs(['sdk/typescript/package-lock.json']).includes('dependency-review'));
});

test('deployment changes retain topology, cross-shell, runtime contract, and full-circle coverage', () => {
  for (const path of ['bootstrap/config.schema.json', 'helm/realtime-gateway/values.yaml', 'cluster/redis/managed-values.yaml']) {
    assert.deepEqual(selectJobs([path]), [
      'helm-and-automation', 'bootstrap-powershell-windows', 'bootstrap-lifecycle-parity', 'build-test-aot', 'full-circle',
    ], path);
  }
  assert.deepEqual(selectJobs(['observability/metrics-catalog.json']), ['helm-and-automation', 'build-test-aot']);
  assert.deepEqual(selectJobs(['load/profiles/production-readiness.json']), ['build-test-aot']);
  assert.deepEqual(selectJobs(['tests/bootstrap/branch-sync.test.mjs']), [
    'helm-and-automation', 'bootstrap-powershell-windows', 'bootstrap-lifecycle-parity',
  ]);
  assert.deepEqual(selectJobs(['tests/Cormier.Realtime.UnitTests/ProtocolTests.cs']), ['build-test-aot']);
});

test('shared automation, CI, root build inputs, and unknown surfaces conservatively run all jobs', () => {
  for (const path of [
    'scripts/ci-impact.mjs', 'scripts/setup-ci-node-prerequisites.sh',
    '.github/workflows/ci.yml', '.github/actions/setup-cormier-runner/action.yml',
    'Directory.Build.props', 'global.json', '.dockerignore', 'new-component/source.ts',
    'examples/new-adapter/source.ts',
  ]) assert.deepEqual(selectJobs([path]), validationJobs, path);
});

test('combined changes select the union without duplicate jobs', () => {
  assert.deepEqual(selectJobs(['examples/go-gin/main.go', 'examples/rust-axum/src/main.rs', 'examples/go-gin/main.go']), [
    'build-test-aot', 'rust-axum', 'go-gin',
  ]);
});

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-impact-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const commit = (file, content = file) => {
    writeFileSync(join(cwd, file), content);
    git('add', '--all');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, commit };
}

test('PR comparison uses merge base, handles renames/deletes, and does not truncate large diffs', t => {
  const { cwd, git, commit } = repository(t);
  const initial = commit('original.txt');
  git('checkout', '-b', 'feature');
  git('mv', 'original.txt', 'renamed.txt');
  for (let index = 0; index < 350; index++) writeFileSync(join(cwd, `changed-${index}.txt`), 'fixture');
  const head = commit('last.txt');
  git('checkout', 'main');
  const base = commit('base-only.txt');
  const files = changedFiles(base, head, cwd);
  assert.equal(files.length, 353);
  assert.ok(files.includes('original.txt'));
  assert.ok(files.includes('renamed.txt'));
  assert.ok(!files.includes('base-only.txt'));
  assert.deepEqual(changedFiles(initial, base, cwd), ['base-only.txt']);
  assert.throws(() => changedFiles('--invalid', head, cwd), /Full base and head/);
});

test('selection CLI safely falls back to the full suite when comparison is unavailable', t => {
  const { cwd } = repository(t);
  const output = join(cwd, 'output');
  const summary = join(cwd, 'summary');
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/ci-impact.mjs', root)), 'select'], {
    cwd,
    env: { ...process.env, CI_EVENT_NAME: 'pull_request', CI_BASE_SHA: '', CI_HEAD_SHA: '', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    stdio: 'pipe',
  });
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8').trim().slice('selected='.length)), validationJobs);
  assert.match(readFileSync(summary, 'utf8'), /Affected CI jobs/);
});

function resultsFor(selected) {
  return {
    changes: { result: 'success' },
    ...Object.fromEntries(validationJobs.map(job => [job, { result: selected.includes(job) ? 'success' : 'skipped' }])),
  };
}

test('success gate accepts only intended skips and requires every selected job to succeed', () => {
  const selected = selectJobs(['examples/go-gin/main.go']);
  assert.doesNotThrow(() => checkResults(selected, resultsFor(selected)));
  assert.doesNotThrow(() => checkResults([], resultsFor([])));
  for (const result of ['skipped', 'failure', 'cancelled', undefined]) {
    assert.throws(() => checkResults(selected, { ...resultsFor(selected), 'go-gin': { result } }), /go-gin=/);
  }
  assert.throws(() => checkResults([], { ...resultsFor([]), changes: { result: 'failure' } }), /change detection/);
  assert.throws(() => checkResults([], { ...resultsFor([]), 'node-express': { result: 'failure' } }), /node-express=/);
  assert.throws(() => checkResults(['unknown'], resultsFor([])), /Invalid CI job selection/);
  assert.throws(() => checkResults(['go-gin', 'go-gin'], resultsFor(['go-gin'])), /Invalid CI job selection/);
});

test('all workflow validations are gated by the selector and included in the stable required gate', () => {
  const jobs = [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([\w-]+):\n((?:(?!^  [\w-]+:)[\s\S])*)/gm)];
  assert.deepEqual(jobs.map(match => match[1]).sort(), ['changes', ...validationJobs, 'ci-success'].sort());
  for (const job of validationJobs) {
    const body = jobs.find(match => match[1] === job)[2];
    assert.match(body, /needs: changes/);
    assert.ok(body.includes(`contains(fromJSON(needs.changes.outputs.selected), '${job}')`), job);
  }
  const gate = jobs.find(match => match[1] === 'ci-success')[2];
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/);
  for (const job of ['changes', ...validationJobs]) assert.ok(gate.includes(`      - ${job}\n`), job);
  assert.match(gate, /CI_SELECTED_JOBS: \$\{\{ needs\.changes\.outputs\.selected \}\}/);
  assert.match(gate, /run: node scripts\/ci-impact\.mjs check/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /CI_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /CI_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});
