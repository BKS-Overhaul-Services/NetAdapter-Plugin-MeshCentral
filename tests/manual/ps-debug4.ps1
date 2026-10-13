$ErrorActionPreference='SilentlyContinue';
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$p = netsh wlan show profile name="Janio_5G" key=clear 2>&1 | Out-String;
foreach ($ln in ($p -split "`r?`n")) { if ($ln -match 'rip|Ciph|Autent|auth') { Write-Output ('"'+$ln.Trim()+'"') } }
$raw = netsh wlan show interfaces 2>&1 | Out-String;
$tx = '';
foreach ($ln in ($raw -split "`r?`n")) { if ($ln -match '^\s*(?:Transmit rate|Taxa de transmiss.o)\s*\(') { $tx = ($ln -split ':')[1].Trim() } }
Write-Output ("tx com padrao corrigido: " + $tx);
