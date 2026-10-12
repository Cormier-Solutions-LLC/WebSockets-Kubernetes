#!/usr/bin/env bash
set -Eeuo pipefail
node --version
[[ "$(node --version)" == v26.10.0 ]]
[[ "$(npm --version)" == 12.1.0 ]]
dotnet --list-sdks
rustc --version
cargo clippy --version
cargo fmt --version
clang --version
shellcheck --version
docker buildx version
docker compose version
# shellcheck disable=SC2016 # PowerShell expands this expression.
pwsh -NoLogo -NoProfile -Command '
  if ($PSVersionTable.PSVersion.ToString() -ne "7.6.6") { throw "Incorrect PowerShell" }
  Import-Module Pester -RequiredVersion 5.7.1 -ErrorAction Stop
  Import-Module PSScriptAnalyzer -RequiredVersion 1.24.0 -ErrorAction Stop
  Get-Module Pester,PSScriptAnalyzer | Select-Object Name,Version
'
node <<'JS'
const { chromium, firefox, webkit } = require('/opt/playwright-tools/node_modules/playwright');
(async () => {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<title>runner smoke</title>');
    if (await page.title() !== 'runner smoke') throw new Error(name);
    await browser.close();
    console.log(name + ' browser smoke passed');
  }
})().catch(error => { console.error(error); process.exit(1); });
JS
dotnet new console --output /tmp/runner-aot --no-restore
dotnet publish /tmp/runner-aot -c Release -r linux-x64 -p:PublishAot=true -o /tmp/runner-aot-output
/tmp/runner-aot-output/runner-aot
echo 'Linux runner smoke passed'
