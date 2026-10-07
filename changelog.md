# Changelog — NetAdapter Plugin MeshCentral

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
