const MARKER = 'cormier-ci-autofix';
const AGGREGATE_JOB = 'ci-success';
const MAX_EXCERPT_LINES = 15;

// Failures that a code change cannot resolve: credentials, permissions, or runner infrastructure.
const needsInputPatterns = [
  ['missing credentials', /\b(?:username|password|token|secret|credentials?|api[ _-]?key)s?\b[^\n]{0,80}\b(?:required|missing|not (?:set|supplied|provided|found|configured)|is empty)\b/i],
  ['missing credentials', /Input required and not supplied: \S+/i],
  ['authentication failure', /\b(?:unauthorized: authentication required|authentication (?:required|failed)|bad credentials|invalid (?:username or password|credentials)|401 \(Unauthorized\)|status code 401)\b/i],
  ['authorization failure', /\b(?:denied: requested access to the resource is denied|Resource not accessible by integration|permission denied \(publickey\)|403 \(Forbidden\))/i],
  ['runner infrastructure', /\b(?:Cannot connect to the Docker daemon|No space left on device|The runner has received a shutdown signal|lost communication with the server|No runner (?:is )?available)/i],
];
const errorLine = /##\[error\]|\berror\b|\bfatal\b|\bfail(?:ed|ure)?\b|\bdenied\b|\bunauthorized\b|\bInput required\b/i;
const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const infrastructureConclusions = new Set(['cancelled', 'startup_failure', 'action_required', 'stale']);

function stripLogPrefix(line) {
  return line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').trimEnd();
}

function errorLines(log) {
  return String(log ?? '').split(/\r?\n/).map(stripLogPrefix).filter(line => errorLine.test(line));
}

function classifyLog(log) {
  const reasons = new Set();
  for (const line of errorLines(log)) {
    for (const [reason, pattern] of needsInputPatterns) if (pattern.test(line)) reasons.add(reason);
  }
  return [...reasons];
}

function failedJobs(jobs, ownWorkflowJobs = []) {
  const ignored = new Set(ownWorkflowJobs);
  const failed = jobs.filter(job => !ignored.has(job.name)
    && job.conclusion && !['success', 'skipped', 'neutral'].includes(job.conclusion));
  // ci-success only aggregates other results; analyze it alone only if nothing else failed.
  const specific = failed.filter(job => job.name !== AGGREGATE_JOB);
  return specific.length > 0 ? specific : failed;
}

function sanitize(text) {
  // Prevent log content from closing fences or pinging accounts.
  return String(text).replace(/`{3,}/g, "'''").replace(/@(?=[\w-])/g, '@\u200b').slice(0, 300);
}

function analyzeJob(job, log) {
  const reasons = classifyLog(log);
  if (infrastructureConclusions.has(job.conclusion)) reasons.push(`job ${job.conclusion}`);
  if (log === null) reasons.push('logs unavailable');
  const excerpt = errorLines(log).slice(-MAX_EXCERPT_LINES).map(sanitize);
  return { name: job.name, url: job.html_url, conclusion: job.conclusion, reasons, excerpt };
}

function marker(kind, sha, runId) {
  return `<!-- ${MARKER}:${kind} sha=${sha} run=${runId} -->`;
}

function priorRequests(comments, sha) {
  const pattern = new RegExp(`<!-- ${MARKER}:(copilot|input) sha=([0-9a-f]+) run=\\d+ -->`);
  const copilot = [];
  let handledSha = false;
  for (const comment of comments) {
    // Ignore markers pasted by untrusted commenters so they cannot suppress or exhaust repairs.
    if (comment.user?.type !== 'Bot' && !trustedAssociations.has(comment.author_association)) continue;
    const match = pattern.exec(comment.body ?? '');
    if (!match) continue;
    if (match[1] === 'copilot') copilot.push(match[2]);
    if (match[2] === sha) handledSha = true;
  }
  return { copilotAttempts: copilot.length, handledSha };
}

function jobSection(job) {
  const lines = [`### [${job.name}](${job.url}) — ${job.conclusion}`];
  if (job.reasons.length) lines.push(`Needs input: ${job.reasons.join(', ')}`);
  if (job.excerpt.length) lines.push('```text', ...job.excerpt, '```');
  return lines.join('\n');
}

function buildCopilotRequest({ mention, run, jobs, sha, attempt, maxAttempts }) {
  return [
    `${mention} The [${run.name} run](${run.html_url}) failed its \`${AGGREGATE_JOB}\` gate on \`${sha.slice(0, 12)}\` (automatic fix attempt ${attempt} of ${maxAttempts}).`,
    '',
    'Analyze the failed jobs below, inspect their full logs, and push the smallest change to this branch that makes them pass. '
      + 'Follow the repository agent guidance and run the matching validation. If a failure needs something you cannot provide '
      + '(credentials, secrets, repository settings, runner infrastructure, or a product decision), stop without guessing and reply '
      + 'explaining exactly what input is needed.',
    '',
    ...jobs.map(jobSection),
    '',
    marker('copilot', sha, run.id),
  ].join('\n');
}

function buildInputRequest({ people, run, jobs, sha, summary }) {
  return [
    `${people.map(person => `${person.startsWith('@') ? '' : '@'}${person} `).join('')}Automatic CI repair was **not** started for the [${run.name} run](${run.html_url}) on \`${sha.slice(0, 12)}\`.`,
    '',
    summary,
    '',
    'Resolve the items below (for example, configure the missing secret or variable, or fix runner access), then re-run the failed jobs. '
      + 'To request a code fix anyway, mention the coding agent in a new comment.',
    '',
    ...jobs.map(jobSection),
    '',
    marker('input', sha, run.id),
  ].join('\n');
}

async function findPullRequest(github, context, run) {
  const listed = run.pull_requests?.[0];
  if (listed) return (await github.rest.pulls.get({ ...context.repo, pull_number: listed.number })).data;
  const { data } = await github.rest.pulls.list({
    ...context.repo, state: 'open', head: `${context.repo.owner}:${run.head_branch}`, per_page: 1,
  });
  return data[0] ?? null;
}

async function analyzeCiFailure({ github, context, core }) {
  const run = context.payload.workflow_run;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const maxAttempts = Number.parseInt(process.env.CI_AUTOFIX_MAX_ATTEMPTS || '3', 10) || 3;
  const mention = process.env.CI_AUTOFIX_AGENT_MENTION || '@copilot';
  const tokenConfigured = process.env.CI_AUTOFIX_TOKEN_CONFIGURED === 'true';
  const stop = message => { core.notice(message); core.setOutput('dispatch', 'false'); };

  if (run.name === process.env.CI_AUTOFIX_WORKFLOW_NAME) return stop('Ignoring this workflow to prevent a loop.');
  if (run.event !== 'pull_request' || run.head_repository?.full_name !== repository) {
    return stop('Only same-repository pull request branches are repaired automatically.');
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: run.id, filter: 'latest', per_page: 100,
  });
  if (jobs.find(job => job.name === AGGREGATE_JOB)?.conclusion !== 'failure') {
    return stop(`The ${AGGREGATE_JOB} gate did not fail; nothing to repair.`);
  }
  const pr = await findPullRequest(github, context, run);
  if (!pr || pr.state !== 'open') return stop('No open pull request for this branch.');
  if (pr.head.sha !== run.head_sha) return stop('The branch has newer commits; their CI run decides.');

  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: pr.number, per_page: 100,
  });
  const { copilotAttempts, handledSha } = priorRequests(comments, run.head_sha);
  if (handledSha) return stop(`Commit ${run.head_sha} was already handled.`);

  const analyzed = [];
  for (const job of failedJobs(jobs, (process.env.CI_AUTOFIX_IGNORED_JOBS || '').split(',').filter(Boolean))) {
    let log = null;
    try {
      ({ data: log } = await github.rest.actions.downloadJobLogsForWorkflowRun({ ...context.repo, job_id: job.id }));
    } catch (error) {
      core.warning(`Could not download logs for ${job.name}: ${error.message}`);
    }
    analyzed.push(analyzeJob(job, log));
  }

  const blockers = analyzed.filter(job => job.reasons.length > 0);
  let summary = null;
  if (blockers.length > 0) {
    summary = 'These failures need information or access that an automated code change cannot supply.';
  } else if (copilotAttempts >= maxAttempts) {
    summary = `The automatic repair limit (${maxAttempts} attempts) was reached for this pull request.`;
  } else if (!tokenConfigured) {
    summary = 'The `CI_AUTOFIX_TOKEN` repository secret is not configured, so the coding agent cannot be started.';
  }

  await core.summary.addHeading('CI failure analysis')
    .addTable([['Job', 'Conclusion', 'Needs input'],
      ...analyzed.map(job => [job.name, job.conclusion, job.reasons.join(', ') || 'no'])]).write();

  if (summary) {
    const people = [...new Set([pr.user?.login, run.triggering_actor?.login].filter(login => login && !login.endsWith('[bot]')))];
    if (people.length === 0 && process.env.CI_AUTOFIX_FALLBACK_MENTION) people.push(process.env.CI_AUTOFIX_FALLBACK_MENTION);
    await github.rest.issues.createComment({
      ...context.repo, issue_number: pr.number,
      body: buildInputRequest({ people, run, jobs: analyzed, sha: run.head_sha, summary }),
    });
    return stop(summary);
  }
  core.setOutput('dispatch', 'true');
  core.setOutput('pull_number', String(pr.number));
  core.setOutput('body', buildCopilotRequest({
    mention, run, jobs: analyzed, sha: run.head_sha, attempt: copilotAttempts + 1, maxAttempts,
  }));
}

module.exports = {
  analyzeCiFailure, analyzeJob, buildCopilotRequest, buildInputRequest, classifyLog, failedJobs, priorRequests, sanitize,
};
