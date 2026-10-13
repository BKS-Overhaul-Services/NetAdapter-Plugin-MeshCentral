$ErrorActionPreference='SilentlyContinue';
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$raw = netsh wlan show interfaces 2>&1 | Out-String;
foreach ($ln in ($raw -split "`r?`n")) {
  if ($ln -match 'Taxa') {
    $rx = $ln -match '^\s*(?:Receive rate|Taxa de recepc..o)\s*\(';
    $tx = $ln -match '^\s*(?:Transmit rate|Taxa de transmiss.o)\s*\(';
    Write-Output ('"' + $ln.Trim() + '" rx=' + $rx + ' tx=' + $tx);
  }
}
