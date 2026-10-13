$ErrorActionPreference='SilentlyContinue';
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {};
$out = @();
try {
  $raw = netsh wlan show networks mode=bssid 2>&1 | Out-String;
  if ($raw -notmatch 'SSID|Interface|interface') {
    # locale desconhecido: sem redes parseáveis
  } else {
    $cur = $null;
    foreach ($ln in ($raw -split "`r?`n")) {
      if ($ln -match '^\s*SSID \d+\s*: (.*)$') { if ($cur) { $out += $cur }; $cur = [pscustomobject]@{ ssid=$Matches[1].Trim(); bssid=''; signal=0; channel=0; band=''; auth=''; cipher=''; radio='' } }
      elseif ($null -ne $cur) {
        if ($ln -match '^\s*(?:BSSID|Endere.o F.sico) \d+\s*: (.*)$') { $cur.bssid = $Matches[1].Trim() }
        elseif ($ln -match '^\s*(?:Signal|Sinal)\s*: (\d+)%') { $cur.signal = [int]$Matches[1] }
        elseif ($ln -match '^\s*(?:Channel|Canal)\s*: (\d+)') { $cur.channel = [int]$Matches[1] }
        elseif ($ln -match '^\s*(?:Authentication|Autentica..o)\s*: (.*)$') { $cur.auth = $Matches[1].Trim() }
        elseif ($ln -match '^\s*(?:Encryption|Criptografia)\s*: (.*)$') { $cur.cipher = $Matches[1].Trim() }
        elseif ($ln -match '^\s*(?:Radio type|Tipo de r.dio)\s*: (.*)$') { $cur.radio = $Matches[1].Trim() }
      }
    }
    if ($cur) { $out += $cur }
    foreach ($n in $out) { if ($n.channel -ge 1 -and $n.channel -le 14) { $n.band = '2.4GHz' } elseif ($n.channel -ge 32 -and $n.channel -le 177) { $n.band = '5GHz' } elseif ($n.channel -gt 0) { $n.band = '6GHz' } }
  }
} catch {}
$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 5 -Compress }
Write-Output ('__NAW__' + (@{ id='test'; ok=$true; result=$__json } | ConvertTo-Json -Compress -Depth 3))
