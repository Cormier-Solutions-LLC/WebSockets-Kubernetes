"""Populate the same caches the workflow setup actions use, as the runner user."""
import hashlib
import json
import os
import sys
from pathlib import Path
import subprocess
import tarfile
import urllib.request
import yaml

state = Path('/tmp/action-runtime')
state.mkdir(exist_ok=True)
manifest = {'schemaVersion': 1, 'actions': json.loads(Path('/tmp/image-build/actions.lock.json').read_text()), 'tools': {}, 'downloads': {}}
env = dict(os.environ, HOME='/home/runner', RUNNER_OS='Linux', RUNNER_ARCH='X64', RUNNER_TEMP=str(state), GITHUB_WORKSPACE=str(state), GITHUB_ACTIONS='true', CI='true')
env['PATH'] = '/opt/hostedtoolcache/node/26.10.0/x64/bin:/home/runner/.dotnet:/home/runner/.cargo/bin:/opt/ci-tools/bin:' + ':'.join(str(p) for p in Path('/opt/hostedtoolcache').rglob('bin')) + ':' + env['PATH']
node = '/opt/hostedtoolcache/node/26.10.0/x64/bin/node' if Path('/opt/hostedtoolcache/node/26.10.0/x64/bin/node').exists() else '/home/runner/externals/node24/bin/node'
if Path('/opt/ci-tools/manifest.json').exists():
    manifest = json.loads(Path('/opt/ci-tools/manifest.json').read_text())

def run(args, **kwargs):
    print('+ ' + ' '.join(args), flush=True)
    return subprocess.run(args, env=env, check=True, **kwargs)

def action(name, inputs):
    global node
    directory = Path('/tmp/setup-actions') / name
    config = yaml.safe_load((directory / 'action.yml').read_text())
    action_env = env.copy()
    for key, value in config.get('inputs', {}).items():
        default = str(value.get('default', ''))
        action_env['INPUT_' + key.replace(' ', '_').upper()] = '' if '${{' in default else default
    for key, value in inputs.items():
        action_env['INPUT_' + key.upper()] = value
    for key in ['GITHUB_PATH', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STATE']:
        path = state / key
        path.write_text('')
        action_env[key] = str(path)
    print(f'Installing {name}: {inputs}', flush=True)
    subprocess.run([node, str(directory / config['runs']['main'])], env=action_env, cwd=state, check=True)
    additions = (state / 'GITHUB_PATH').read_text().splitlines()
    env['PATH'] = ':'.join(reversed(additions)) + ':' + env['PATH']
    lines = iter((state / 'GITHUB_ENV').read_text().splitlines())
    for line in lines:
        if '<<' in line:
            key, delimiter = line.split('<<', 1)
            values = []
            for item in lines:
                if item == delimiter:
                    break
                values.append(item)
            env[key] = '\n'.join(values)
        elif '=' in line:
            key, value = line.split('=', 1)
            env[key] = value
    manifest['tools'][name] = inputs

def download(url, name, expected=None):
    target = state / name
    with urllib.request.urlopen(url, timeout=120) as response, target.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if expected and digest != expected:
        raise RuntimeError(f'Checksum mismatch: {url}')
    manifest['downloads'][name] = {'url': url, 'sha256': digest}
    return target

if sys.argv[1] == 'node':
    action('node', {'node-version': '22.x', 'package-manager-cache': 'false'})
    action('node', {'node-version': '26.10.0', 'package-manager-cache': 'false'})
    node = '/opt/hostedtoolcache/node/26.10.0/x64/bin/node'
    run(['npm', 'install', '--global', 'npm@12.1.0'])

if sys.argv[1] == 'dotnet':
    action('dotnet', {'dotnet-version': '8.0.x\n10.0.x', 'cache': 'false'})

if sys.argv[1] == 'java':
    action('java', {'distribution': 'temurin', 'java-version': '25', 'java-package': 'jdk', 'architecture': 'x64', 'check-latest': 'false'})

if sys.argv[1] == 'go':
    action('go', {'go-version': '1.27.1', 'cache': 'false'})

if sys.argv[1] == 'beam':
    action('beam', {'otp-version': '29.0.6', 'elixir-version': '1.20.4'})

if sys.argv[1] == 'python':
    action('python', {'python-version': '3.11'})
    action('python', {'python-version': '3.13'})

if sys.argv[1] == 'rust':
    rustup_url = 'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init'
    rustup_sha = urllib.request.urlopen(rustup_url + '.sha256', timeout=30).read().decode().split()[0]
    rustup = download(rustup_url, 'rustup-init', rustup_sha)
    rustup.chmod(0o755)
    run([str(rustup), '-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', '1.98.1', '--component', 'clippy', '--component', 'rustfmt'])

if sys.argv[1] == 'powershell':
    version = '7.6.6'
    archive = download(f'https://github.com/PowerShell/PowerShell/releases/download/v{version}/powershell-{version}-linux-x64.tar.gz', 'pwsh.tar.gz', 'ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc')
    pwsh_dir = Path('/opt/ci-tools/powershell')
    pwsh_dir.mkdir(parents=True)
    with tarfile.open(archive) as bundle:
        bundle.extractall(pwsh_dir, filter='data')
    (pwsh_dir / 'pwsh').chmod(0o755)
    bin_dir = Path('/opt/ci-tools/bin')
    bin_dir.mkdir(exist_ok=True)
    (bin_dir / 'pwsh').symlink_to(pwsh_dir / 'pwsh')
    run(['pwsh', '-NoLogo', '-NoProfile', '-Command', "Set-PSRepository PSGallery -InstallationPolicy Trusted; Install-Module Pester -RequiredVersion 5.7.1 -Scope CurrentUser -Force; Install-Module PSScriptAnalyzer -RequiredVersion 1.24.0 -Scope CurrentUser -Force"])

if sys.argv[1] == 'browsers':
    run(['npm', 'install', '--prefix', '/opt/playwright-tools', '--save-exact', 'playwright@1.63.0'])
    run([node, '/opt/playwright-tools/node_modules/playwright/cli.js', 'install', '--with-deps', 'chromium', 'firefox', 'webkit'])
manifest['tools']['powershell'] = '7.6.6'
manifest['tools']['npm'] = '12.1.0'
manifest['tools']['rust'] = '1.98.1 (clippy, rustfmt)'
manifest['tools']['playwright'] = '1.63.0 (chromium, firefox, webkit)'
manifest['installedDotnetSDKs'] = [] if not Path('/home/runner/.dotnet/dotnet').exists() else subprocess.check_output(['/home/runner/.dotnet/dotnet', '--list-sdks'], env=env, text=True).splitlines()
manifest['toolCacheEntries'] = sorted(str(p.relative_to('/opt/hostedtoolcache')) for p in Path('/opt/hostedtoolcache').rglob('*.complete'))
manifest['aptPackages'] = subprocess.check_output(['dpkg-query', '-W', '-f=${Package}=${Version}\n'], text=True).splitlines()
Path('/opt/ci-tools/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Image cache manifest written to /opt/ci-tools/manifest.json', flush=True)
