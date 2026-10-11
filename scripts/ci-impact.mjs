import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const adapterJobs = [
  'node-express', 'java-spring-boot', 'kotlin-ktor', 'rust-axum', 'go-gin',
  'elixir-phoenix', 'php-laravel', 'python-fastapi', 'ruby-rails', 'swift-vapor',
];
const automationJobs = ['helm-and-automation', 'bootstrap-powershell-windows', 'bootstrap-lifecycle-parity'];
const runtimeJobs = ['build-test-aot', ...adapterJobs, 'full-circle'];
export const validationJobs = [...automationJobs, 'build-test-aot', 'dependency-review', ...adapterJobs, 'full-circle'];

function isDependency(path) {
  return /(?:^|\/)(?:package(?:-lock)?\.json|packages\.lock\.json|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|mix\.(?:exs|lock)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|.*\.gradle(?:\.kts)?|gradle\.lockfile|Package\.(?:swift|resolved)|uv\.lock|pyproject\.toml|global\.json|Directory\.Build\.(?:props|targets)|.*\.csproj)$/.test(path)
    || path.startsWith('.github/workflows/') || path.startsWith('.github/actions/');
}

export function selectJobs(paths, eventName = 'pull_request') {
  const all = validationJobs.filter(job => job !== 'dependency-review' || eventName === 'pull_request');
  // Main pushes produce the complete artifact set consumed by release workflows.
  if (eventName !== 'pull_request' || paths === null) return all;
  const selected = new Set();
  const add = jobs => jobs.forEach(job => selected.add(job));
  for (const path of paths) {
    if (isDependency(path)) selected.add('dependency-review');
    if (path.startsWith('.github/') || path.startsWith('scripts/') && !path.endsWith('.md')) {
      add(all);
    } else if (path.startsWith('src/') || path.startsWith('sdk/') || path.startsWith('protocol/')
      || path.startsWith('examples/shared-web/') || path.startsWith('examples/browser/')
      || path.startsWith('examples/full-circle/')) {
      add(runtimeJobs);
    } else if (path.startsWith('bootstrap/') || path.startsWith('helm/') || path.startsWith('cluster/')) {
      add([...automationJobs, 'build-test-aot', 'full-circle']);
    } else if (path.startsWith('tests/bootstrap/')) {
      add(automationJobs);
    } else if (path.startsWith('tests/') || path.startsWith('tools/') || path.startsWith('load/')
      || path.startsWith('observability/') || path === 'scripts/README.md') {
      selected.add('build-test-aot');
      if (path.startsWith('observability/')) selected.add('helm-and-automation');
    } else if (path.startsWith('examples/')) {
      const adapter = adapterJobs.find(job => path.startsWith(`examples/${job}/`));
      if (adapter) add([adapter, 'build-test-aot']);
      else if (path.startsWith('examples/aspnet-core/') || path.startsWith('examples/dotnet-client/')) {
        selected.add('build-test-aot');
      } else {
        add(all);
      }
    } else if (path.startsWith('docs/') || path.startsWith('refs/') || /^(?:README|CHANGELOG|LICENSE)(?:\.md)?$/.test(path)) {
      continue;
    } else {
      // Unknown/root build inputs and new surfaces must not silently lose coverage.
      add(all);
    }
  }
  return validationJobs.filter(job => selected.has(job));
}

export function changedFiles(base, head, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) {
    throw new Error('Full base and head commit SHAs are required.');
  }
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--'], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

export function checkResults(selected, results) {
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length
    || selected.some(job => !validationJobs.includes(job))) {
    throw new Error('Invalid CI job selection.');
  }
  if (results.changes?.result !== 'success') throw new Error('CI change detection did not succeed.');
  const failures = [];
  for (const job of validationJobs) {
    const result = results[job]?.result;
    const expected = selected.includes(job) ? 'success' : 'skipped';
    if (result !== expected) failures.push(`${job}=${result ?? 'missing'} (expected ${expected})`);
  }
  if (failures.length) throw new Error(`Required CI jobs did not succeed:\n${failures.join('\n')}`);
}

function main() {
  if (process.argv[2] === 'select') {
    let paths = null;
    if (process.env.CI_EVENT_NAME === 'pull_request') {
      try {
        paths = changedFiles(process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA);
      } catch {
        console.warn('Change comparison unavailable; running all PR validations.');
      }
    }
    const selected = selectJobs(paths, process.env.CI_EVENT_NAME);
    appendFileSync(process.env.GITHUB_OUTPUT, `selected=${JSON.stringify(selected)}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Affected CI jobs\n${selected.length ? selected.map(job => `- ${job}`).join('\n') : 'No validation jobs affected.'}\n`);
  } else if (process.argv[2] === 'check') {
    checkResults(JSON.parse(process.env.CI_SELECTED_JOBS), JSON.parse(process.env.CI_JOB_RESULTS));
    console.log('All affected CI jobs succeeded; unaffected jobs were skipped.');
  } else {
    throw new Error('Expected select or check.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
