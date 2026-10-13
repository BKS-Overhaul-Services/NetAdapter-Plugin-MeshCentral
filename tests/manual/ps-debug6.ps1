$ErrorActionPreference='SilentlyContinue';
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$raw = netsh wlan show interfaces 2>&1 | Out-String;
foreach ($ln in ($raw -split "`r?`n")) {
  if ($ln -match 'Taxa de recep') {
    Write-Output ('linha: "' + $ln.Trim() + '"');
    Write-Output ('  chars após "recep": ' + (($ln -split 'recep')[1].ToCharArray() | ForEach-Object { [int]$_ }) -join ',');
    Write-Output ('  m1 recepc..o: ' + ($ln -match 'Taxa de recepc..o\s*\('));
    Write-Output ('  m2 recep...o: ' + ($ln -match 'Taxa de recep...o\s*\('));
    Write-Output ('  m3 recepc\w+o: ' + ($ln -match 'Taxa de recepc\w+o\s*\('));
    Write-Output ('  m4 recep.ao : ' + ($ln -match 'Taxa de recep.ao\s*\('));
  }
}
