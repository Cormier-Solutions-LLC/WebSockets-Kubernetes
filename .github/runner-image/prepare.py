"""Resolve the workflow's setup actions to immutable commits for the image build."""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request
import zipfile
import io

root = Path(__file__).resolve().parent
actions = {
    "node": ("actions/setup-node", "v7"),
    "dotnet": ("actions/setup-dotnet", "v6"),
    "java": ("actions/setup-java", "v5"),
    "go": ("actions/setup-go", "v7"),
    "beam": ("erlef/setup-beam", "v1"),
    "python": ("actions/setup-python", "v6"),
}
lock_path = root / 'actions.lock.json'
previous = json.loads(lock_path.read_text()) if lock_path.exists() else {}
lock = {}
for name, (repo, ref) in actions.items():
    commit = previous[name]['commit'] if name in previous else subprocess.check_output(["gh", "api", f"repos/{repo}/commits/{ref}", "--jq", ".sha"], text=True).strip()
    url = f"https://codeload.github.com/{repo}/zip/{commit}"
    data = urllib.request.urlopen(url, timeout=120).read()
    if name in previous and hashlib.sha256(data).hexdigest() != previous[name]['sha256']:
        raise RuntimeError(f'Action archive checksum changed: {repo}@{commit}')
    destination = root / "vendor" / name
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            relative = Path(*Path(member.filename).parts[1:])
            if not relative.parts or ".." in relative.parts or member.is_dir():
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))
    lock[name] = {"repository": repo, "ref": ref, "commit": commit, "url": url, "sha256": hashlib.sha256(data).hexdigest()}
    print(f"Locked {repo}@{commit}", flush=True)
(root / "actions.lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
