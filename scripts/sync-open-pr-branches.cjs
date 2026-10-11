const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function createGit(directory, token, serverUrl) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${serverUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
  delete env.BRANCH_SYNC_TOKEN;
  return (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory, env, encoding: 'utf8', timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      // Do not log subprocess output: authentication data must remain private.
      throw new Error(`Git ${args[0]} failed (status ${result.status ?? 'unknown'}).`);
    }
    return result.stdout.trim();
  };
}

function mergeMain(git, head, main) {
  git('checkout', '--detach', head);
  git('merge', '--no-edit', '--no-ff', '--strategy=ort', '--strategy-option=ours', main);
  return git('rev-parse', 'HEAD') !== head;
}

function eligibleBranch(pr, repository) {
  return pr.state === 'open' && pr.base.ref === 'main'
    && pr.head.repo?.full_name === repository && pr.head.ref !== 'main';
}

async function syncOpenBranches({ github, context, core }) {
  const directory = mkdtempSync(join(tmpdir(), 'cormier-branch-sync-'));
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const git = createGit(directory, process.env.BRANCH_SYNC_TOKEN, process.env.BRANCH_SYNC_SERVER_URL);
  const results = [];
  let failed = false;
  try {
    git('init');
    git('config', 'user.name', 'github-actions[bot]');
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    git('remote', 'add', 'origin', `${process.env.BRANCH_SYNC_SERVER_URL}/${repository}.git`);
    git('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const main = git('rev-parse', 'refs/remotes/origin/main');
    const prs = await github.paginate(github.rest.pulls.list, {
      ...context.repo, state: 'open', base: 'main', per_page: 100,
    });
    const processed = new Set();
    for (const pr of prs) {
      if (!eligibleBranch(pr, repository)) {
        results.push([`#${pr.number}`, 'Skipped (fork or ineligible branch)']);
        continue;
      }
      if (processed.has(pr.head.ref)) continue;
      processed.add(pr.head.ref);
      try {
        // Recheck state before writing; never execute files from the PR branch.
        const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
        if (!eligibleBranch(current, repository) || current.head.ref !== pr.head.ref) {
          results.push([`#${pr.number}`, 'Skipped (PR changed or closed)']);
          continue;
        }
        git('check-ref-format', `refs/heads/${pr.head.ref}`);
        git('fetch', '--no-tags', 'origin', `+refs/heads/${pr.head.ref}:refs/remotes/origin/sync-head`);
        const head = git('rev-parse', 'refs/remotes/origin/sync-head');
        if (mergeMain(git, head, main)) {
          // A normal push rejects concurrent divergence; never force-push.
          git('push', 'origin', `HEAD:refs/heads/${pr.head.ref}`);
          results.push([`#${pr.number}`, 'Updated (branch wins content conflicts)']);
        } else {
          results.push([`#${pr.number}`, 'Already up to date']);
        }
      } catch (error) {
        failed = true;
        core.warning(`PR #${pr.number}: ${error.message} Resolve structural conflicts, branch protection, or concurrent updates manually.`);
        results.push([`#${pr.number}`, 'Failed; branch left unchanged']);
        try { git('merge', '--abort'); } catch { /* No merge may be in progress. */ }
        git('reset', '--hard');
        git('clean', '-fd');
      }
    }
    await core.summary.addHeading('Main synchronization')
      .addTable([['Pull request', 'Result'], ...results]).write();
    if (failed) core.setFailed('Some PR branches could not be synchronized; see the job summary.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { createGit, eligibleBranch, mergeMain, syncOpenBranches };
