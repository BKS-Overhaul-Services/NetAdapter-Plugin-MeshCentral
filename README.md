# NetAdapter — Gerenciador de Placas de Rede para MeshCentral

Plugin MeshCentral para controle centralizado de placas de rede Windows dos clientes via agente MeshCentral. Estrutura e plumbing herdados do plugin **Spooler** (validado em produção): server-side `reqid` + agente `consoleaction` + worker PowerShell persistente + fila serial de mutações + NeDB.

## Funcionalidades

| Área | Recursos |
|------|----------|
| Inventário | Placas (físicas e virtuais) com status, MAC, link/duplex, MTU, DHCP, IPs/máscaras, gateway, DNS, perfil de rede, sufixo DNS e driver |
| IP / DNS | IP estático (com verificação pós-ação), volta a DHCP, DNS manual, sufixo DNS + registro no DNS, flush e register DNS |
| Placas | Ativar/desativar (com aviso de queda de conexão), renomear, MAC spoof via registro + reset para original (restart da placa) |
| Avançado | Propriedades avançadas do driver (jumbo frames, offloads, speed/duplex…) com valores válidos, MTU, perfil (Público/Privado/Domain), NetBIOS (0/1/2 via registro), bindings (IPv6, LLTD, QoS…) liga/desliga |
| Drivers | Listagem de drivers NET assinados (Win32_PnPSignedDriver), instalação via `pnputil /add-driver <inf> /install` |
| Diagnóstico | Ping a partir do cliente, tabela de rotas IPv4, vizinhança ARP |
| Auditoria | Todas as operações logadas em NeDB, por dispositivo e global; catálogo consolidado no painel admin |

## Instalação

1. Copie a pasta `netadapter` para `C:\Program Files\Open Source\MeshCentral\meshcentral-data\plugins\netadapter` no bks-server.
2. No `config.json` do MeshCentral:
   ```json
   "settings": { "plugins": { "enabled": true, "list": ["netadapter"] } }
   ```
3. Reinicie o serviço do MeshCentral.
4. No painel do MeshCentral: **Meu Servidor → Plugins** deve listar o plugin ativo.

> ⚠️ Mudanças em `modules_meshcore/` exigem **restart do MeshCentral + reconexão dos agentes** (o módulo é embutido no core do agente). A linha `netadapter module loaded` em `netadapter-plugin.txt` no cliente confirma que o agente pegou o core novo.

## Como funciona

```
[Browser] --ws--> [netadapter.js (server)] --wsagents[nid].send--> [netadapter.js (agente)]
                         |                                              |
                    NeDB (catálogo +                          PowerShell 64-bit (worker
                    auditoria)                                persistente): Get-NetAdapter,
                                                              New-NetIPAddress, Set-DnsClient*,
                                                              registry MAC/NetBIOS, pnputil...
                         ^                                              |
                         +------------ resposta via serveraction -------+
```

- O módulo `modules_meshcore/netadapter.js` é injetado automaticamente nos cores pelo `pluginHandler.addMeshCoreModules()` — o arquivo **DEVE** se chamar `netadapter.js` (= `shortName`), sem prefixo `win-`, e exportar `consoleaction`.
- Toda execução no agente é via PowerShell com parâmetros sanitizados (`q()`), PS 5.1-safe (sem `&&`/ternário), sentinela `__NAJSON__` e timeout manual (o shim `child_process` do MeshAgent não é Node).
- Mutações (IP, MAC, ativar/desativar, avançado, drivers…) passam por **fila serial** no agente com resposta em 2 fases (`started` → `done`); leituras são paralelas.
- Correlação por `reqid` com timeout: 2 min leituras, 6 min mutações, 8 min mutações lentas (IP/MAC/driver — podem reiniciar a placa usada pelo agente).
- Operações destrutivas avisam o usuário antes (desativar placa/MAC/binding podem derrubar a conexão do agente; nesse caso o server responde timeout).

## Requisitos

- MeshCentral >= 1.0.0 com plugins habilitados
- Agentes Windows (módulo com guard `process.platform === 'win32'`)
- PowerShell 5.1+ (padrão no Windows 10/11/Server) e cmdlets `NetAdapter`/`DnsClient`/`NetTCPIP` (todos Windows 8+/Server 2012+)
- Agente rodando como SYSTEM/admin (padrão do MeshCentral) para Enable/Disable e registro

## Estrutura

```
netadapter/
├── config.json                 # metadados do plugin
├── netadapter.js               # server-side (hooks do pluginHandler)
├── db.js                       # NeDB: catálogo de placas + auditoria
├── modules_meshcore/
│   └── netadapter.js           # módulo do agente (injetado nos cores)
├── views/
│   ├── admin.handlebars        # painel global (catálogo consolidado + auditoria)
│   └── device.handlebars       # aba do dispositivo (Placas, IP & DNS, Avançado, Drivers, Diagnóstico, Auditoria)
└── changelog.md
```

## Notas de segurança

- MAC spoof: aplicado via `HKLM\SYSTEM\...\Class\{4D36E972-...}` → `NetworkAddress` (valida 12 hex, rejeita multicast/reservado) + `Restart-NetAdapter`. Nem todo driver suporta.
- `setAdvancedProp` usa `Set-NetAdapterAdvancedProperty` por `RegistryKeyword` (nunca input direto em flags).
- Binding/NetBIOS/MTU errados podem isolar o dispositivo — todas as operações ficam na auditoria com usuário, alvo e resultado.
