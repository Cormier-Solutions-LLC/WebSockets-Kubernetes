#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const version = process.env.NPM_VERSION;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  throw new Error('NPM_VERSION must be an exact release version.');
}
function npm(args) {
  // All arguments are fixed strings or the validated numeric version above.
  const result = process.platform === 'win32'
    ? spawnSync(`npm ${args.join(' ')}`, { encoding: 'utf8', shell: true })
    : spawnSync('npm', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? 'npm failed\n');
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}
if (npm(['--version']) !== version) {
  console.log(npm(['install', '--global', `npm@${version}`]));
}
if (npm(['--version']) !== version) throw new Error(`npm ${version} was not installed.`);
console.log(`Using npm ${version}`);
