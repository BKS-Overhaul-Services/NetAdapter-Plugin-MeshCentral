$ErrorActionPreference='SilentlyContinue';
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {};
$out = $null;
try {
  $pub = $null;
  try { $pub = (Invoke-RestMethod -Uri 'http://ip-api.com/json/?fields=query' -TimeoutSec 6 -UseBasicParsing).query } catch {}
  $dns = @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses } | Select-Object InterfaceAlias, @{n='servers';e={($_.ServerAddresses -join ',')}});
  $cfg = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
    [pscustomobject]@{ name=$_.InterfaceAlias; ip4=$_.IPv4Address.IPAddress; gw4=($_.IPv4DefaultGateway.NextHop -join ','); dns=(($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | Select-Object -ExpandProperty ServerAddresses) -join ','); mac=$_.NetAdapter.MacAddress; linkSpeed=$_.NetAdapter.LinkSpeed }
  });
  $prof = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object Name, InterfaceAlias, NetworkCategory);
  $out = [pscustomobject]@{ publicIp=$pub; adapters=$cfg; dns=$dns; connections=$prof }
} catch {}
$__json = 'null'; if ($null -ne $out) { $__json = @($out) | ConvertTo-Json -Depth 6 -Compress }
Write-Output ('__NAW__' + (@{ id='test'; ok=$true; result=$__json } | ConvertTo-Json -Compress -Depth 3))
