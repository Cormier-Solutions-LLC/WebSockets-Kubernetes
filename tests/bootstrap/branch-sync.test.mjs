import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const { createGit, eligibleBranch, mergeMain } = createRequire(import.meta.url)('../../scripts/sync-open-pr-branches.cjs');

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'branch-sync-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = createGit(directory, '', 'https://example.invalid');
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const commit = (file, content) => {
    writeFileSync(join(directory, file), content);
    git('add', '--', file);
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { git, commit };
}

test('only same-repository open PR branches targeting main are eligible', () => {
  const pr = { state: 'open', base: { ref: 'main' }, head: { ref: 'feature', repo: { full_name: 'owner/repo' } } };
  assert.equal(eligibleBranch(pr, 'owner/repo'), true);
  assert.equal(eligibleBranch({ ...pr, draft: true }, 'owner/repo'), true);
  assert.equal(eligibleBranch({ ...pr, state: 'closed' }, 'owner/repo'), false);
  assert.equal(eligibleBranch({ ...pr, base: { ref: 'release' } }, 'owner/repo'), false);
  assert.equal(eligibleBranch(pr, 'other/repo'), false);
  assert.equal(eligibleBranch({ ...pr, head: { ref: 'main', repo: pr.head.repo } }, 'owner/repo'), false);
  assert.equal(eligibleBranch({ ...pr, head: { ref: 'feature', repo: null } }, 'owner/repo'), false);
});

test('content conflicts preserve branch changes and incorporate nonconflicting main changes', t => {
  const { git, commit } = repository(t);
  commit('shared.txt', 'base\n');
  git('checkout', '-b', 'feature');
  const head = commit('shared.txt', 'feature\n');
  git('checkout', 'main');
  commit('shared.txt', 'main\n');
  const main = commit('main-only.txt', 'new\n');
  assert.equal(mergeMain(git, head, main), true);
  assert.equal(git('show', 'HEAD:shared.txt'), 'feature');
  assert.equal(git('show', 'HEAD:main-only.txt'), 'new');
  assert.equal(git('rev-parse', 'HEAD^1'), head);
  assert.equal(git('rev-parse', 'HEAD^2'), main);
  assert.equal(mergeMain(git, git('rev-parse', 'HEAD'), main), false);
});

test('modify/delete conflicts stop instead of fabricating a resolution', t => {
  const { git, commit } = repository(t);
  commit('shared.txt', 'base\n');
  git('checkout', '-b', 'feature');
  const head = commit('shared.txt', 'feature\n');
  git('checkout', 'main');
  git('rm', 'shared.txt');
  git('commit', '-m', 'delete fixture');
  const main = git('rev-parse', 'HEAD');
  assert.throws(() => mergeMain(git, head, main), /Git merge failed/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  git('merge', '--abort');
  assert.equal(git('show', 'HEAD:shared.txt'), 'feature');
});

test('a branch behind main receives a two-parent merge without changing its own ref locally', t => {
  const { git, commit } = repository(t);
  const head = commit('base.txt', 'base\n');
  git('branch', 'feature');
  const main = commit('main-only.txt', 'main\n');
  assert.equal(mergeMain(git, head, main), true);
  assert.equal(git('rev-parse', 'HEAD^1'), head);
  assert.equal(git('rev-parse', 'HEAD^2'), main);
  assert.equal(git('rev-parse', 'feature'), head);
});

test('divergent nonconflicting changes are both retained', t => {
  const { git, commit } = repository(t);
  commit('base.txt', 'base\n');
  git('checkout', '-b', 'feature');
  const head = commit('branch-only.txt', 'feature\n');
  git('checkout', 'main');
  const main = commit('main-only.txt', 'main\n');
  assert.equal(mergeMain(git, head, main), true);
  assert.equal(git('show', 'HEAD:branch-only.txt'), 'feature');
  assert.equal(git('show', 'HEAD:main-only.txt'), 'main');
});
