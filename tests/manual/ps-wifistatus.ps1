$ErrorActionPreference='SilentlyContinue';
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {};
$out = $null; $note = '';
try {
  $raw = netsh wlan show interfaces 2>&1 | Out-String;
  if ($raw -notmatch 'SSID|State|Estado|Radio|Tipo de r.dio') {
    $flat = ($raw -replace "`r?`n", ' ').Trim();
    $note = $flat.Substring(0, [Math]::Min(200, $flat.Length));
    $out = [pscustomobject]@{ wifi = $false; note = $note }
  } else {
    $st = ''; $ssid = ''; $bssid = ''; $radio = ''; $auth = ''; $cipher = ''; $sig = 0; $ch = 0; $rx = ''; $tx = '';
    foreach ($ln in ($raw -split "`r?`n")) {
      if ($ln -match '^\s*(?:State|Estado)\s*: (.*)$') { $st = $Matches[1].Trim() }
      elseif ($ln -match '^\s*SSID\s*: (.*)$') { $ssid = $Matches[1].Trim() }
      elseif ($ln -match '^\s*(?:BSSID|Endere.o F.sico)\s*: (.*)$') { $bssid = $Matches[1].Trim() }
      elseif ($ln -match '^\s*(?:Radio type|Tipo de r.dio)\s*: (.*)$') { $radio = $Matches[1].Trim() }
      elseif ($ln -match '^\s*(?:Authentication|Autentica..o)\s*: (.*)$') { $auth = $Matches[1].Trim() }
      elseif ($ln -match '^\s*(?:Cipher|Criptografia)\s*: (.*)$') { $cipher = $Matches[1].Trim() }
      elseif ($ln -match '^\s*(?:Signal|Sinal)\s*: (\d+)%') { $sig = [int]$Matches[1] }
      elseif ($ln -match '^\s*(?:Channel|Canal)\s*: (\d+)') { $ch = [int]$Matches[1] }
      elseif ($ln -match '^\s*(?:Receive rate|Taxa de recep..o)\s*\(.*$') { $rx = ($ln -split ':')[1].Trim() }
      elseif ($ln -match '^\s*(?:Transmit rate|Taxa de transmiss.o)\s*\(.*$') { $tx = ($ln -split ':')[1].Trim() }
    }
    $out = [pscustomobject]@{ wifi = $true; state = $st; ssid = $ssid; bssid = $bssid; radio = $radio; auth = $auth; cipher = $cipher; signal = $sig; channel = $ch; rxRate = $rx; txRate = $tx }
  }
  $prof = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object Name, InterfaceAlias, NetworkCategory);
  if ($out) { $out | Add-Member -NotePropertyName connections -NotePropertyValue $prof -Force }
} catch {}
$__json = 'null'; if ($null -ne $out) { $__json = @($out) | ConvertTo-Json -Depth 6 -Compress }
Write-Output ('__NAW__' + (@{ id='test'; ok=$true; result=$__json } | ConvertTo-Json -Compress -Depth 3))




