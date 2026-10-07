# Changelog — NetAdapter Plugin MeshCentral

## 1.0.6 (2026-10-07)
### Fixed
- **Dialog de IP mostrava lixo nos campos DNS** ("2" e "6"): terceiro nível do quirk do `ConvertTo-Json` — os campos-array **aninhados** de cada placa (ipv4, prefixLengths, dnsServers, ipv6, dnsServers6...) com **1 elemento** chegam como valor solto (string/número), e `dnsServers[0]` em string devolve o primeiro caractere do IP. Fix: normalização centralizada no server (9 campos por placa no handler do `agentResult`) + `asArr()` defensivo na view (`renderAdapters`, `ipListHtml`, `showIpDlgFor`).

### Notes
- Server + view apenas — **reload** do plugin (sem restart, sem reconexão de agentes). Lição consolidada: no PS 5.1, `ConvertTo-Json` desembrulha arrays de 1 elemento em TODOS os níveis; normalizar sempre na fronteira de entrada.

## 1.0.5 (2026-10-07)
### Added
- **Gestão do arquivo hosts** (`C:\Windows\System32\drivers\etc\hosts`): nova aba Hosts com leitura estruturada (`getHosts`: ip, hostnames, comentário, origem, estado) e 4 mutações — `addHostsEntry`, `updateHostsEntry`, `removeHostsEntry` e `toggleHostsEntry` (ativa/desativa comentando a linha). Segurança: só edita entradas com tag gerenciada `#na:<id>` (entradas manuais = somente leitura), validação estrita de IP (v4 octeto a octeto, v6 hex/::) e hostname, rejeita hostname duplicado, backup `hosts.netadapter.bak` antes da primeira gravação, gravação ASCII (encoding do hosts) e verificação pós-gravação.

## 1.0.4 (2026-10-07)
### Added
- **Configuração IPv6 completa por placa**: novos handlers `setIp6` (endereço/prefixo 1-128/gateway/DNS v6 estáticos, preservando o link-local fe80::, com verificação pós-ação de 15s) e `setDhcp6` (remove estáticos v6, habilita DHCPv6 + RouterDiscovery Managed, aguarda RA/DHCPv6 até 20s). `setDns` agora aceita `family: IPv4|IPv6` (Set-DnsClientServerAddress -AddressFamily). Inventário expõe: IPs v6 + prefixos + origem (Dhcp/RouterAdvertisement/Manual), gateway v6 (`::/0`), DNS v6, estado DHCPv6 e RouterDiscovery.
- **Frontend**: painel IP & DNS reescrito — tabela por família (IPv4/IPv6) com endereços + badges de origem/link-local, gateway, DNS e modo; dialogs "Estático…" e "Automático" por família; novo dialog "DNS…" por família (aplica sem tocar no IP); atalho para desativar IPv6 via binding ms_tcpip6 na aba Avançado.

### Notes
- `setDhcp6` reseta o DNS manual das **duas famílias** (limitação do `Set-DnsClientServerAddress -ResetServerAddresses`, que não tem -AddressFamily).
- Mudança em `modules_meshcore/` — requer restart do MeshCentral + reconexão dos agentes.

## 1.0.3 (2026-10-07)
### Fixed
- **21 placas no inventário**: `-IncludeHidden` fixo trouxe os ~18 WAN Miniports (IKEv2, L2TP, PPTP, SSTP, IP, IPv6, PPPOE...), loopback, Kernel Debug e Bluetooth PAN que todo Windows esconde — ruído puro. Agora o padrão é `Get-NetAdapter` normal (já inclui virtuais como vEthernet), e as ocultas entram só com o novo toggle "incluir placas ocultas" na aba Placas (`params.hidden='true'`).

### Notes
- Mudança em `modules_meshcore/` — requer restart do MeshCentral + reconexão dos agentes.

## 1.0.2 (2026-10-07)
### Fixed
- **Inventário devolvia só 1 placa (a primeira)** (`modules_meshcore/netadapter.js`): o worker PS serializa sempre a variável `$out`, mas o wrapper `{adapters, hostname}` era montado em `$out2` — que nunca era serializado. O agente devolvia o array de placas cru, o handler fazia `result[0]` e entregava apenas a 1ª placa ao server. Fix: wrapper reatribuído a `$out` (RHS avaliado antes da reatribuição) + normalização defensiva de `adapters` no callback do handler (unwrap de 1 elemento pelo ConvertTo-Json). Versão server-side do mesmo bug era mascarada pela v1.0.1.
- **Placas ocultas não apareciam**: `Get-NetAdapter -IncludeHidden` no inventário (WAN Miniports, bridges e outros adapters ocultos agora aparecem, marcados quando virtuais).

### Notes
- Mudança em `modules_meshcore/` — requer **restart do MeshCentral + reconexão dos agentes**.
- Deploy parcial v1.0.1: a correção do catálogo funcionou no server (erro sumiu), mas o bug do `$out2` só aparece no agente — por isso "1 placa" persistiu após o reload. Os dois bugs se mascaravam mutuamente.

## 1.0.1 (2026-10-07)
### Fixed
- **Catálogo explodia com 1 única placa** (`netadapter.js` + `views/device.handlebars`): quirk do `ConvertTo-Json` do PS — array de 1 elemento chega desserializado como **objeto** (não array). Com uma só placa (ex: apenas `Ethernet` na BR-25005), `result.adapters` não era array e `upsertAdapters`/`renderAdapters` falhavam com `(list || []).forEach is not a function` em todo inventário. Fix: normalização `if (!Array.isArray(x)) x = [x]` nos 3 pontos de entrada (server no handler do `agentResult`, frontend no `handleResult` e dentro do próprio `renderAdapters` — defesa em profundidade). Lição já conhecida do Spooler (§6.3) aplicada ao campo aninhado.

## 1.0.0 (2026-10-07)
- Primeira versão. Clone estrutural do plugin Spooler (v1.1.16) — plumbing já validado em produção:
  - Server-side: `reqid` com timeouts diferenciados (120s leitura / 360s mutação / 480s mutação lenta), resposta do agente em 2 fases (`started`/`done`), catálogo NeDB atualizado a cada inventário (`upsertAdapters` + `markAbsent`), auditoria de mutações, cache em memória invalidado por mutação, `setDebug` remoto, `obj.exports` com `onDeviceRefreshEnd` (aba "Placas de Rede" só em Windows).
  - Agente (`modules_meshcore/netadapter.js`, nome = shortName, `module.exports = { consoleaction }`, loop-guard de `agentResult`, allow-list):
    - Worker PS persistente (stdin JSON, sentinelas `__NAW__`/`__NAJSON__`, health check 60s, watchdog 90s, restart com backoff, fallback spawn-único).
    - `runPS` compatível com o shim Duktape do MeshAgent (streams `data`, `exit\r\n`, timeout manual 150s, ref viva do child).
    - Fila serial de 15 mutações; leituras paralelas via worker.
  - Handlers: `inventory` (Get-NetAdapter + IP/gateway/DNS/DHCP/MTU/perfil/sufixo/driver), `setIp` (com verificação pós-ação 15s), `setDhcp` (aguarda lease até 20s), `setDns`, `setDnsSuffix`, `enableAdapter`/`disableAdapter` (verificação de Up), `renameAdapter`, `setMac`/`resetMac` (registro NetworkAddress + Restart-NetAdapter, valida 12 hex e rejeita multicast), `setNetbios` (registry NetbiosOptions 0/1/2), `setMtu` (verifica se o driver aceitou a MTU pedida), `setProfile`, `setAdvancedProp` (por RegistryKeyword), `listBindings`/`setBindingState`, `listDrivers` (Win32_PnPSignedDriver NET), `installDriver` (pnputil), `ping`/`getRoutes`/`getNeighbors`, `flushDns`/`registerDns`.
  - Frontend: 6 abas (Placas, IP & DNS, Avançado, Drivers, Diagnóstico, Auditoria), dialogs `<dialog>` nativos, avisos de queda de conexão nas operações destrutivas, audit trail. Admin: catálogo global filtrável + auditoria + navegação `/?viewmode=10&gotonode=`.
