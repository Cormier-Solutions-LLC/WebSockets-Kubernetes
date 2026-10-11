import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const {
  analyzeCiFailure, analyzeJob, buildCopilotRequest, classifyLog, failedJobs, priorRequests, sanitize,
} = createRequire(import.meta.url)('../../scripts/ci-failure-autofix.cjs');

test('workflow triggers only on failed CI runs and runs on Cormier runners with trusted code', () => {
  const workflow = readFileSync(new URL('.github/workflows/ci-failure-autofix.yml', root), 'utf8');
  assert.match(workflow, /workflow_run:\n    workflows: \[Realtime gateway CI\]\n    types: \[completed\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(workflow, /head_repository\.full_name == github\.repository/);
  assert.match(workflow, /runs-on: cormier-runners/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head/);
  assert.match(workflow, /github-token: \$\{\{ secrets\.CI_AUTOFIX_TOKEN \}\}/);
  assert.match(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'), /^name: Realtime gateway CI$/m);
});

test('failed jobs exclude ignored names and the aggregate gate unless it failed alone', () => {
  const jobs = [
    { name: 'changes', conclusion: 'success' },
    { name: 'go-gin', conclusion: 'failure' },
    { name: 'rust-axum', conclusion: 'skipped' },
    { name: 'analyze', conclusion: 'failure' },
    { name: 'ci-success', conclusion: 'failure' },
  ];
  assert.deepEqual(failedJobs(jobs, ['analyze']).map(job => job.name), ['go-gin']);
  assert.deepEqual(failedJobs([jobs[0], jobs[4]]).map(job => job.name), ['ci-success']);
});

test('credential, authorization and infrastructure errors require user input', () => {
  const at = '2026-10-11T15:00:00.0000000Z ';
  assert.deepEqual(classifyLog(`${at}##[error]Username and password required`), ['missing credentials']);
  assert.deepEqual(classifyLog(`${at}##[error]Input required and not supplied: password`), ['missing credentials']);
  assert.deepEqual(classifyLog('Error response from daemon: unauthorized: authentication required'), ['authentication failure']);
  assert.deepEqual(classifyLog('error: Resource not accessible by integration'), ['authorization failure']);
  assert.deepEqual(classifyLog('ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), ['runner infrastructure']);
  assert.deepEqual(analyzeJob({ name: 'x', conclusion: 'cancelled' }, '').reasons, ['job cancelled']);
  assert.deepEqual(analyzeJob({ name: 'x', conclusion: 'failure' }, null).reasons, ['logs unavailable']);
});

test('ordinary code failures and passing test names stay automatically repairable', () => {
  assert.deepEqual(classifyLog([
    'ok 4 - rejects a missing password required by the secret helper',
    "error TS2322: Type 'string' is not assignable to type 'number'.",
    'FAIL tests/gateway.test.ts > rejects 403 origin',
  ].join('\n')), []);
});

test('excerpts cannot close fences or mention accounts', () => {
  assert.equal(sanitize('```@octocat'), "'''@\u200boctocat");
  const body = buildCopilotRequest({
    mention: '@copilot', sha: 'a'.repeat(40), attempt: 1, maxAttempts: 3,
    run: { id: 7, name: 'Realtime gateway CI', html_url: 'https://example.invalid/run' },
    jobs: [analyzeJob({ name: 'go-gin', conclusion: 'failure', html_url: 'https://example.invalid/job' }, 'error: ``` @someone')],
  });
  assert.match(body, /^@copilot /);
  assert.match(body, /stop without guessing/);
  assert.match(body, /<!-- cormier-ci-autofix:copilot sha=a{40} run=7 -->$/);
  assert.equal(body.match(/```/g).length, 2);
});

test('prior markers dedupe commits and count repair attempts', () => {
  const comments = [
    { body: 'x <!-- cormier-ci-autofix:copilot sha=abc run=1 -->' },
    { body: '<!-- cormier-ci-autofix:input sha=def run=2 -->' },
    { body: 'unrelated' },
  ];
  assert.deepEqual(priorRequests(comments, 'def'), { copilotAttempts: 1, handledSha: true });
  assert.deepEqual(priorRequests(comments, 'fff'), { copilotAttempts: 1, handledSha: false });
});

function harness({ log, comments = [], token = 'true' }) {
  const run = {
    id: 9, name: 'Realtime gateway CI', html_url: 'https://example.invalid/run', event: 'pull_request',
    head_sha: 'b'.repeat(40), head_branch: 'feature', head_repository: { full_name: 'o/r' },
    pull_requests: [{ number: 5 }], triggering_actor: { login: 'dev' },
  };
  const outputs = {};
  const posted = [];
  const jobs = [{ id: 1, name: 'go-gin', conclusion: 'failure' }, { id: 2, name: 'ci-success', conclusion: 'failure' }];
  const github = {
    paginate: async method => method(),
    rest: {
      actions: { listJobsForWorkflowRun: () => jobs, downloadJobLogsForWorkflowRun: async () => ({ data: log }) },
      pulls: { get: async () => ({ data: { state: 'open', number: 5, head: { sha: run.head_sha }, user: { login: 'author' } } }) },
      issues: { listComments: () => comments, createComment: async args => posted.push(args) },
    },
  };
  const summary = { addHeading: () => summary, addTable: () => summary, write: async () => {} };
  const core = { notice() {}, warning() {}, setOutput: (k, v) => { outputs[k] = v; }, summary };
  Object.assign(process.env, {
    CI_AUTOFIX_TOKEN_CONFIGURED: token, CI_AUTOFIX_WORKFLOW_NAME: 'Repair failed CI', CI_AUTOFIX_MAX_ATTEMPTS: '2',
  });
  return { run: () => analyzeCiFailure({ github, context: { repo: { owner: 'o', repo: 'r' }, payload: { workflow_run: run } }, core }), outputs, posted };
}

test('repairable failures dispatch Copilot without posting a GITHUB_TOKEN comment', async () => {
  const h = harness({ log: 'error: go vet failed' });
  await h.run();
  assert.equal(h.outputs.dispatch, 'true');
  assert.equal(h.outputs.pull_number, '5');
  assert.equal(h.posted.length, 0);
});

test('unresolvable failures, missing token, and attempt limits stop and prompt the user', async () => {
  for (const options of [
    { log: '##[error]Username and password required' },
    { log: 'error: x', token: 'false' },
    { log: 'error: x', comments: ['1', '2'].map(n => ({ body: `<!-- cormier-ci-autofix:copilot sha=${n.repeat(4)} run=${n} -->` })) },
  ]) {
    const h = harness(options);
    await h.run();
    assert.equal(h.outputs.dispatch, 'false');
    assert.equal(h.posted.length, 1);
    assert.match(h.posted[0].body, /^@author @dev Automatic CI repair was \*\*not\*\* started/);
    assert.match(h.posted[0].body, /cormier-ci-autofix:input sha=b{40} run=9/);
  }
});

test('already handled commits are not processed again', async () => {
  const h = harness({ log: 'error: x', comments: [{ body: `<!-- cormier-ci-autofix:input sha=${'b'.repeat(40)} run=8 -->` }] });
  await h.run();
  assert.equal(h.outputs.dispatch, 'false');
  assert.equal(h.posted.length, 0);
});
