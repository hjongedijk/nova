<#
Compatibility launcher for existing JarvisAgent scheduled tasks.
The maintained implementation is nova-agent.ps1. Keep this filename so old
installations can update in place without changing their scheduled task path.
#>
param(
  [int]$Port = 8765,
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'agent.json')
)
$ErrorActionPreference = 'Stop'
$novaAgent = Join-Path $PSScriptRoot 'nova-agent.ps1'
if (-not (Test-Path -LiteralPath $novaAgent -PathType Leaf)) {
  throw 'nova-agent.ps1 is missing; install the complete NOVA Windows agent package.'
}
& $novaAgent -Port $Port -ConfigPath $ConfigPath
