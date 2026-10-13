$ErrorActionPreference='SilentlyContinue';
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$raw = netsh wlan show profiles 2>&1 | Out-String;
$lines = $raw -split "`r?`n";
$i = 0;
foreach ($ln in $lines) {
  $i++;
  if ($ln -match 'Perfil') {
    $hit = $ln -match '^\s*(?:All User Profile|Todos os perfis de usu.rio)\s*: (.*)$';
    Write-Output ("L{0}: hit={1} line={2}" -f $i, $hit, $ln.Trim());
    if ($hit) { Write-Output ("   cap={0}" -f $Matches[1]) }
  }
}
# e testa o show profile individual
$p = netsh wlan show profile name="Janio_5G" key=clear 2>&1 | Out-String;
$found = @{};
foreach ($ln in ($p -split "`r?`n")) {
  if ($ln -match '^\s*(?:Authentication|Autentica..o)\s*: (.*)$') { $found['auth'] = $Matches[1].Trim() }
  elseif ($ln -match '^\s*(?:Cipher|Criptografia)\s*: (.*)$') { $found['cipher'] = $Matches[1].Trim() }
  elseif ($ln -match '^\s*(?:Key Content|Conte.do da Chave)\s*: (.*)$') { $found['key'] = 'ENCONTRADA(len=' + $Matches[1].Length + ')' }
  elseif ($ln -match 'Senha|Key') { $found['keyline'] = $ln.Trim() }
}
Write-Output ('profile Janio_5G: ' + ($found | ConvertTo-Json -Compress));
Write-Output '--- linhas com Senha/chave no profile ---';
foreach ($ln in ($p -split "`r?`n")) { if ($ln -match 'Chave|Key|Senha') { Write-Output ('"'+$ln.Trim()+'"') } }
