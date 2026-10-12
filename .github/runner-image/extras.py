"""Warm wrapper/package-manager caches and checksum-verified deployment tools."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request

temporary = Path('/tmp/image-extras')
manifest_path = Path('/opt/ci-tools/manifest.json')
manifest = json.loads(manifest_path.read_text())
env = dict(os.environ, HOME='/home/runner')
env['PATH'] = '/opt/hostedtoolcache/node/26.10.0/x64/bin:/opt/ci-tools/bin:' + env['PATH']
env['JAVA_HOME'] = str(next(Path('/opt/hostedtoolcache').glob('Java_*/*/x64')))
env['PATH'] = env['JAVA_HOME'] + '/bin:' + env['PATH']
for args in [['npm', 'install', '--global', 'corepack@0.36.0'], ['corepack', 'enable'], ['corepack', 'prepare', 'pnpm@10.15.0', '--activate']]:
    subprocess.run(args, env=env, check=True)
for name, script in [('gradle', 'gradlew'), ('maven', 'mvnw')]:
    path = temporary / name / script
    path.write_text(path.read_text().replace('\r\n', '\n'))
    path.chmod(0o755)
    subprocess.run([str(path), '--version'], cwd=path.parent, env=env, check=True)

def get(url, filename, checksum):
    path = temporary / filename
    urllib.request.urlretrieve(url, path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != checksum:
        raise RuntimeError(f'Checksum mismatch: {filename}')
    manifest['downloads'][filename] = {'url': url, 'sha256': digest}
    return path

tools = Path('/opt/ci-tools/bin')
gh = get('https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_amd64.tar.gz', 'gh.tar.gz', '9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8')
with tarfile.open(gh) as archive:
    tools.joinpath('gh').write_bytes(archive.extractfile('gh_2.101.0_linux_amd64/bin/gh').read())
helm = get('https://get.helm.sh/helm-v3.22.0-linux-amd64.tar.gz', 'helm.tar.gz', '1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb')
with tarfile.open(helm) as archive:
    tools.joinpath('helm').write_bytes(archive.extractfile('linux-amd64/helm').read())
# Match the current cluster's minor. CI requesting another version retains its installer fallback.
url = 'https://dl.k8s.io/release/v1.35.7/bin/linux/amd64/kubectl'
checksum = urllib.request.urlopen(url + '.sha256', timeout=30).read().decode().strip()
kubectl = get(url, 'kubectl', checksum)
tools.joinpath('kubectl').write_bytes(kubectl.read_bytes())
for name in ['gh', 'helm', 'kubectl']:
    tools.joinpath(name).chmod(0o755)
manifest['tools'].update({'corepack': '0.36.0', 'pnpm': '10.15.0', 'gradle': '9.7.1 (wrapper cache)', 'maven': '3.9.12 (wrapper cache)', 'gh': '2.101.0', 'helm': '3.22.0', 'kubectl': '1.35.7 (cluster-compatible)'})
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
