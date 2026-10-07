# Changelog — NetAdapter Plugin MeshCentral

## 1.0.0 (2026-10-07)
- Primeira versão. Clone estrutural do plugin Spooler (v1.1.16) — plumbing já validado em produção:
  - Server-side: `reqid` com timeouts diferenciados (120s leitura / 360s mutação / 480s mutação lenta), resposta do agente em 2 fases (`started`/`done`), catálogo NeDB atualizado a cada inventário (`upsertAdapters` + `markAbsent`), auditoria de mutações, cache em memória invalidado por mutação, `setDebug` remoto, `obj.exports` com `onDeviceRefreshEnd` (aba "Placas de Rede" só em Windows).
  - Agente (`modules_meshcore/netadapter.js`, nome = shortName, `module.exports = { consoleaction }`, loop-guard de `agentResult`, allow-list):
    - Worker PS persistente (stdin JSON, sentinelas `__NAW__`/`__NAJSON__`, health check 60s, watchdog 90s, restart com backoff, fallback spawn-único).
    - `runPS` compatível com o shim Duktape do MeshAgent (streams `data`, `exit\r\n`, timeout manual 150s, ref viva do child).
    - Fila serial de 15 mutações; leituras paralelas via worker.
  - Handlers: `inventory` (Get-NetAdapter + IP/gateway/DNS/DHCP/MTU/perfil/sufixo/driver), `setIp` (com verificação pós-ação 15s), `setDhcp` (aguarda lease até 20s), `setDns`, `setDnsSuffix`, `enableAdapter`/`disableAdapter` (verificação de Up), `renameAdapter`, `setMac`/`resetMac` (registro NetworkAddress + Restart-NetAdapter, valida 12 hex e rejeita multicast), `setNetbios` (registry NetbiosOptions 0/1/2), `setMtu` (verifica se o driver aceitou a MTU pedida), `setProfile`, `setAdvancedProp` (por RegistryKeyword), `listBindings`/`setBindingState`, `listDrivers` (Win32_PnPSignedDriver NET), `installDriver` (pnputil), `ping`/`getRoutes`/`getNeighbors`, `flushDns`/`registerDns`.
  - Frontend: 6 abas (Placas, IP & DNS, Avançado, Drivers, Diagnóstico, Auditoria), dialogs `<dialog>` nativos, avisos de queda de conexão nas operações destrutivas, audit trail. Admin: catálogo global filtrável + auditoria + navegação `/?viewmode=10&gotonode=`.
