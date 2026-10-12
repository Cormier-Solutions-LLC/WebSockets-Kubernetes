# Linux CI runner image

Extends the exact Ubuntu 24.04 x64 Actions runner digest currently used by ARC.
The runner entrypoint and Docker-in-Docker wiring stay compatible with ARC 0.14.2.

The image supplies the current CI requirements: Node 26.10.0 with npm 12.1.0,
.NET 8 and 10 SDKs, Temurin JDK 25, Go 1.27.1, Rust 1.98.1 with Clippy and
rustfmt, Erlang/OTP 29.0.6, Elixir 1.20.4, PowerShell 7.6.6, Pester 5.7.1,
PSScriptAnalyzer 1.24.0, native build/AOT dependencies, ShellCheck, Docker CLI,
Buildx and Compose, and Playwright 1.63.0 with Chromium, Firefox and WebKit.
Node 22 and Python 3.11/3.13 are also cached for the other audited Linux jobs.
Those repositories continue using their existing runner selections.

The Maven 3.9.12 and Gradle 9.7.1 wrapper archives are cached with the checksums
declared by the current example projects. Corepack 0.36.0 and pnpm 10.15.0 are
available. Deployment tools include gh 2.101.0 and Helm 3.22.0. kubectl 1.35.7
matches the current cluster; workflows requesting 1.37.1 still use their
existing installer. That existing workflow default needs a separate compatibility
correction before using it against Kubernetes 1.35.

SDKs are installed through the same setup actions as the workflows, using
immutable action commits in `actions.lock.json`. `prepare.py` verifies the
locked archive hashes when reconstructing the build context. Wildcard SDK
patches resolve when building the image; `/opt/ci-tools/manifest.json` records
the resulting SDK/cache entries and installed Ubuntu package versions. Promote
and deploy an image by its content digest, so existing runners never change
silently when a tag or upstream version advances.

```powershell
python .github/runner-image/prepare.py
$RunnerImage = "$env:CI_RUNNER_REPOSITORY`:2026.10.11-1"
docker build --tag $RunnerImage .github/runner-image
docker push $RunnerImage
docker buildx imagetools inspect $RunnerImage
```

The image build needs Linux x64 Docker, Python and `gh` for the initial action
lock only. A populated action lock can be rebuilt without GitHub credentials.
Registry authentication is supplied to Docker outside the build. Credentials,
application source, repository dependencies and job workspaces are not baked
into the image. Application dependency restores and Docker build caches remain
job-specific.

ARC mounts a fresh workspace and starts a fresh runner after each job. Tool
caches live outside that workspace at `/opt/hostedtoolcache`; .NET lives at
`/home/runner/.dotnet`; browser engines live at `/opt/playwright-browsers`.
The matching CI changes verify requested versions before reusing npm,
PowerShell, its modules, or browser system dependencies. Version changes retain
the normal install path.

Before rollout, run the setup contract tests, launch all three browser engines,
publish/run a Native AOT smoke application, and verify a Kubernetes canary
using the existing Docker sidecar and shared workspace. Pre-pull the digest on
all worker nodes. Back up Helm values, then replace only the runner container
image in the values; preserve the original small `init-dind-externals` image.
The 16-runner capacity and one-hour idle policy are separate from the image.

For rollback, restore the previous runner image through Helm. Keep the idle
policy and quota in place. The CI setup changes work with the original image
because they fall back to installing missing tools.
