$ErrorActionPreference='SilentlyContinue';
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$raw = netsh wlan show interfaces 2>&1 | Out-String;
foreach ($ln in ($raw -split "`r?`n")) { if ($ln -match 'rate|Taxa|veloc') { Write-Output ('"'+$ln.Trim()+'"') } }
$ln1 = 'Todos os Perfis de Usuários: Janio_5G';
Write-Output ("regex usu.rios? => " + ($ln1 -match '^\s*(?:All User Profile|Todos os perfis de usu.rios?)\s*: (.*)$'));
