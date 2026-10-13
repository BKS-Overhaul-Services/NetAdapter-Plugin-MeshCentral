$ErrorActionPreference='SilentlyContinue';
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {};
$out = @();
try {
  $raw = netsh wlan show profiles 2>&1 | Out-String;
  $names = @();
  foreach ($ln in ($raw -split "`r?`n")) { if ($ln -match '^\s*(?:All User Profile|Todos os perfis de usu.rios?)\s*: (.*)$') { $names += $Matches[1].Trim() } }
  foreach ($n in $names) {
    $p = netsh wlan show profile name="$n" key=clear 2>&1 | Out-String;
    $auth = ''; $cipher = ''; $key = '';
    foreach ($ln in ($p -split "`r?`n")) {
      if ($ln -match '^\s*(?:Authentication|Autentica..o)\s*: (.*)$') { $auth = $Matches[1].Trim() }
      elseif ($ln -match '^\s*(?:Cipher|Criptografia)\s*: (.*)$') { $cipher = $Matches[1].Trim() }
      elseif ($ln -match '^\s*(?:Key Content|Conte.do da Chave)\s*: (.*)$') { $key = $Matches[1].Trim() }
    }
    $out += [pscustomobject]@{ name=$n; auth=$auth; cipher=$cipher; hasPassword=($key -ne ''); password=$key }
  }
} catch {}
$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 5 -Compress }
Write-Output ('__NAW__' + (@{ id='test'; ok=$true; result=$__json } | ConvertTo-Json -Compress -Depth 3))

