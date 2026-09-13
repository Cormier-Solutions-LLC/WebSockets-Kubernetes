BeforeAll {
    $script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $script:EntryPoint = Join-Path $script:RepositoryRoot 'scripts/Realtime-Bootstrap.ps1'
    $script:Config = Join-Path $script:RepositoryRoot 'bootstrap/config.example.json'
}

Describe 'Realtime-Bootstrap PowerShell entry point' {
    It 'parses as a complete PowerShell file' {
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($script:EntryPoint, [ref]$null, [ref]$errors) | Out-Null
        $errors | Should -BeNullOrEmpty
    }

    It 'emits the shared normalized non-HA plan' {
        $output = & pwsh -NoLogo -NoProfile -File $script:EntryPoint -Action plan -Config $script:Config -Profile non-ha
        $LASTEXITCODE | Should -Be 0
        $event = $output | ConvertFrom-Json | Where-Object message -eq 'Normalized execution plan.'
        $event.phase | Should -Be 'plan'
        $event.topology.selected | Should -Be 'non-ha'
        $event.topology.gatewayReplicas | Should -Be 1
        $event.safety.secretValuesAccepted | Should -BeFalse
    }

    It 'returns a non-zero exit when the asserted profile conflicts with configuration' {
        $null = & pwsh -NoLogo -NoProfile -File $script:EntryPoint -Action plan -Config $script:Config -Profile ha
        $LASTEXITCODE | Should -Be 2
    }
}
