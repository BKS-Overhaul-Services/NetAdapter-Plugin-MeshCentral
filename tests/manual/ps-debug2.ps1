$ErrorActionPreference='SilentlyContinue';
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$raw = netsh wlan show profiles 2>&1 | Out-String;
Write-Output ("raw len=" + $raw.Length);
Write-Output ("raw head=" + $raw.Substring(0, [Math]::Min(300, $raw.Length)));
$names = @();
foreach ($ln in ($raw -split "`r?`n")) {
  if ($ln -match '^\s*(?:All User Profile|Todos os perfis de usu.rio)\s*: (.*)$') { $names += $Matches[1].Trim() }
}
Write-Output ("names encontrados=" + $names.Count);
$names | Select-Object -First 5 | ForEach-Object { Write-Output ("  - " + $_) };
# hipotese: acento do ARQUIVO (UTF-8 sem BOM lido como ANSI pelo PS5.1) corrompe o padrao
$pat = 'Todos os perfis de usu.rio';
Write-Output ("pattern bytes ok: " + ($pat -ceq 'Todos os perfis de usu.rio'));
