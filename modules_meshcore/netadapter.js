/**
 * NetAdapter — Agente (injetado no meshcore via addMeshCoreModules).
 *
 * ⚠️ O arquivo DEVE se chamar netadapter.js (= shortName do plugin): o dispatcher
 * do core procura o módulo pelo command.plugin e chama require('netadapter').consoleaction.
 *
 * Recebe: { action:'plugin', plugin:'netadapter', pluginaction, reqid, params }
 * Responde: mesh.SendCommand({ action:'plugin', plugin:'netadapter', pluginaction:'agentResult',
 *                              reqid, op, ok, result|error, target })
 *
 * Plumbing PS: idêntico ao Spooler (validado em produção):
 *  - UTF-8 console encoding em todos os scripts
 *  - Handlers JSON usam sentinela __NAJSON__ (isola banners/ruído do stdout)
 *  - Pipeline vazio → '[]' (ConvertTo-Json PS5.1 não imprime nada para @())
 *  - stderr incluído nas mensagens de erro; strings de erro 100% ASCII
 *  - Worker PS persistente (1 processo, stdin JSON, sentinela __NAW__)
 *  - Fila serial de mutações (resposta em 2 fases: started → done)
 *
 * ⚠️ Aviso embutido: disableAdapter/setMac/setNetbios/restart podem DERRUBAR a conexão
 * do agente com o servidor — o resultado nunca chega e o server responde timeout.
 * O frontend avisa o usuário antes de executar essas ops.
 */
"use strict";

var mesh = null;
var naDebugFlag = false;

function nlog(str) {
    if (naDebugFlag !== true) return;
    try {
        var fs = require('fs');
        var logStream = fs.createWriteStream('netadapter-plugin.txt', { flags: 'a' });
        logStream.write('\n' + new Date().toLocaleString() + ': ' + str);
        logStream.end('\n');
    } catch (e) {}
}

// Log de erro: sempre gravado (diagnóstico mínimo em produção)
function nerr(str) {
    try {
        var fs = require('fs');
        var logStream = fs.createWriteStream('netadapter-plugin.txt', { flags: 'a' });
        logStream.write('\n' + new Date().toLocaleString() + ' [ERROR]: ' + str);
        logStream.end('\n');
    } catch (e) {}
}

var SENTINEL = '__NAJSON__';
var WORKER_SENTINEL = '__NAW__';

// ------------------- worker PS persistente (padrão Spooler v1.1.15) -------------------
var wk = {
    child: null, seq: 1, pending: {}, buffer: '', starting: false,
    restarts: 0, lastActivity: 0
};

function workerSpawn() {
    if (wk.starting || wk.child) return;
    wk.starting = true;
    try {
        var child = require('child_process');
        var fs = require('fs');
        var sysnative = process.env['windir'] + '\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe';
        var ps = fs.existsSync(sysnative) ? sysnative : (process.env['windir'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        var p = child.execFile(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {},
            function (code) {
                wk.starting = false;
                nlog('worker exit code=' + code);
                var pend = wk.pending; wk.pending = {};
                for (var id in pend) { try { pend[id]({ ok: false, error: 'worker PS morreu (exit ' + code + ')' }); } catch (e) {} }
                wk.child = null; wk.buffer = '';
                if (wk.restarts < 5) { wk.restarts++; setTimeout(workerSpawn, 3000); }
            });
        if (p.stdout && p.stdout.on) p.stdout.on('data', function (c) { workerFeed(String(c)); });
        if (p.stderr && p.stderr.on) p.stderr.on('data', function (c) { nlog('worker stderr: ' + String(c).substring(0, 200)); });
        try { if (p.stdin && p.stdin.on) p.stdin.on('error', function () {}); } catch (e) {}
        p.stdin.write(
            "$ErrorActionPreference='SilentlyContinue'; " +
            "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; " +
            "while ($true) { " +
            "  $line = [Console]::In.ReadLine(); " +
            "  if ($null -eq $line) { break } " +
            "  $req = $line | ConvertFrom-Json; " +
            "  $out = $null; $err2 = $null; " +
            "  try { Invoke-Expression $req.body } catch { $err2 = $_.Exception.Message } " +
            "  $__j = 'null'; if ($null -ne $out) { $__j = @($out) | ConvertTo-Json -Depth 6 -Compress } " +
            "  $resp = @{ id = $req.id; ok = [bool](-not $err2); result = $__j; error = $err2 }; " +
            "  Write-Output ('" + WORKER_SENTINEL + "' + ($resp | ConvertTo-Json -Compress -Depth 3)) " +
            "} "
        );
        wk.child = p;
        wk.buffer = '';
        wk.lastActivity = Date.now();
        nlog('worker spawned');
    } catch (e) {
        wk.starting = false;
        nerr('worker spawn error: ' + e.message);
    }
}

function workerFeed(chunk) {
    wk.lastActivity = Date.now();
    wk.buffer += chunk;
    var idx;
    while ((idx = wk.buffer.indexOf(WORKER_SENTINEL)) >= 0) {
        var nl = wk.buffer.indexOf('\n', idx);
        var line = (nl >= 0) ? wk.buffer.substring(idx + WORKER_SENTINEL.length, nl) : wk.buffer.substring(idx + WORKER_SENTINEL.length);
        if (nl >= 0) wk.buffer = wk.buffer.substring(nl + 1); else wk.buffer = '';
        var resp = parseJSONSafe(line.trim());
        if (resp && resp.id && wk.pending[resp.id]) {
            var cb = wk.pending[resp.id];
            delete wk.pending[resp.id];
            var result = null;
            if (resp.ok && resp.result != null && resp.result !== 'null') {
                result = parseJSONSafe(String(resp.result));
                if (result === null) result = String(resp.result);
            }
            try { cb({ ok: !!resp.ok, result: result, error: resp.error || null }); } catch (e) { nerr('worker cb: ' + e.message); }
        }
    }
}

function workerRun(body, cb) {
    if (!wk.child || !wk.child.stdin) {
        runJson(body, cb);
        return;
    }
    var id = 'w' + (wk.seq++);
    wk.pending[id] = cb;
    try {
        wk.child.stdin.write(JSON.stringify({ id: id, body: body }) + '\n');
        setTimeout(function () {
            if (wk.pending[id]) {
                delete wk.pending[id];
                nerr('worker watchdog ' + id + ' — matando worker');
                try { wk.child.kill(); } catch (e) {}
            }
        }, 90000);
    } catch (e) {
        delete wk.pending[id];
        nerr('worker write: ' + e.message);
        runJson(body, cb);
    }
}

setInterval(function () {
    try {
        if (!wk.child) { workerSpawn(); return; }
        workerRun("$out = [pscustomobject]@{ ping = 1 }", function (r) {
            if (!r.ok) nlog('worker ping falhou: ' + (r.error || '?'));
        });
    } catch (e) {}
}, 60000);

// Cabeçalho comum: encoding UTF-8 + tolerância a erros não-fatais
var PS_HEAD = "$ErrorActionPreference='SilentlyContinue'; " +
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ";

// Executa PowerShell — COMPATÍVEL com Node real E com o shim Duktape/C do MeshAgent
// (callback do execFile = evento 'exit' com exitCode, SEM stdout/stderr; options.timeout
// ignorado; pipes só via .on('data'); GC mata child vivo → manter referência).
// Padrão do core do MeshCentral (agents/meshcore.js:1512).
function runPS(script, callback) {
    try {
        var child = require('child_process');
        var fs = require('fs');
        var sysnative = process.env['windir'] + '\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe';
        var ps = fs.existsSync(sysnative) ? sysnative : (process.env['windir'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        var stdout = '', stderr = '', done = false, timer = null;
        var p = child.execFile(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {},
            function (err) {
                if (done) return; done = true;
                if (timer) { clearTimeout(timer); timer = null; }
                var code = 0;
                if (err) {
                    if (typeof err === 'number') code = err;                 // shim agente: exitCode puro
                    else if (typeof err.code === 'number') code = err.code;  // Node real: Error.code
                    else code = 1;
                }
                nlog('runPS exit=' + code + ' stdout.len=' + stdout.length + ' stderr.len=' + stderr.length);
                callback(code ? { code: code, message: 'PowerShell exit ' + code + (stderr ? (' stderr=' + stderr.substring(0, 300)) : '') } : null, stdout, stderr);
            });
        if (p.stdout && p.stdout.on) p.stdout.on('data', function (c) { stdout += String(c); });
        if (p.stderr && p.stderr.on) p.stderr.on('data', function (c) { stderr += String(c); });
        try { if (p.stdin && p.stdin.on) p.stdin.on('error', function () {}); } catch (e) {}
        p.stdin.write(script + '\r\nexit\r\n');
        p.stdin.end();
        timer = setTimeout(function () {
            if (done) return; done = true;
            nlog('runPS timeout 150s stdout.len=' + stdout.length + ' stderr.len=' + stderr.length);
            try { p.kill(); } catch (e) {}
            callback({ code: 'TIMEOUT', message: 'PowerShell timeout (150s)' }, stdout, stderr);
        }, 150000);
    } catch (e) {
        callback(e, null, null);
    }
}

function parseJSONSafe(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
}

// Handler JSON padrão: $out (array ou objeto) → sentinela + ConvertTo-Json
function runJson(body, cb) {
    var script = PS_HEAD + body + "\n" +
        "$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 6 -Compress } " +
        "Write-Output ('" + SENTINEL + "' + $__json);";
    runPS(script, function (err, stdout, stderr) {
        nlog('runJson stdout.len=' + (stdout ? String(stdout).length : 0) +
            ' stderr=' + (stderr ? String(stderr).substring(0, 200) : 'null') +
            ' err=' + (err ? String(err.code || err.message) : 'null'));
        if (err) {
            var em = 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message));
            cb({ ok: false, error: em });
            return;
        }
        var s = String(stdout || '');
        var i = s.indexOf(SENTINEL);
        if (i < 0) {
            var e2 = 'sentinela ausente' + (s ? (' stdout=' + s.substring(0, 300)) : ' (stdout vazio)') +
                (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : '');
            nlog('runJson no-sentinel: ' + e2);
            nerr('runJson no-sentinel: ' + e2);
            cb({ ok: false, error: 'PS sem resposta: ' + e2.substring(0, 250) });
            return;
        }
        var json = s.substring(i + SENTINEL.length).trim();
        if (!json || json === '[]' || json === '[{}]') {
            if (json !== '[]' || (stderr && String(stderr).trim())) {
                var e4 = 'resultado vazio do script' + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : '');
                cb({ ok: false, error: e4 });
                return;
            }
            cb({ ok: true, result: [] });
            return;
        }
        var d = parseJSONSafe(json);
        if (d == null) {
            cb({ ok: false, error: 'JSON invalido do agente' + (stderr ? (' stderr=' + String(stderr).substring(0, 200)) : '') });
            return;
        }
        if (!Array.isArray(d)) d = [d];
        cb({ ok: true, result: d });
    });
}

// Handler de comandos com resposta textual OK / OK:... / ERR:...
function runText(script, cb) {
    runPS(PS_HEAD + script, function (err, stdout, stderr) {
        nlog('runText stdout=' + (stdout ? String(stdout).trim().substring(0, 200) : 'null') +
            ' stderr=' + (stderr ? String(stderr).substring(0, 200) : 'null') +
            ' err=' + (err ? String(err.code || '?') : 'null'));
        if (err) {
            cb({ ok: false, error: 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message)) });
            return;
        }
        var s = String(stdout || '').trim();
        if (s.indexOf('ERR:') === 0) { cb({ ok: false, error: s.substring(4) }); return; }
        if (s.indexOf('OK') !== 0) {
            var e3 = 'resposta inesperada' + (s ? (': ' + s.substring(0, 250)) : ' (stdout vazio)') +
                (stderr ? (' stderr=' + String(stderr).substring(0, 200)) : '');
            nlog('runText unexpected: ' + e3);
            cb({ ok: false, error: e3 });
            return;
        }
        cb({ ok: true, result: s.indexOf('OK:') === 0 ? s.substring(3) : null });
    });
}

function reply(nodeid, msg) {
    try {
        msg.action = 'plugin';
        msg.plugin = 'netadapter';
        msg.pluginaction = 'agentResult';
        mesh.SendCommand(JSON.stringify(msg));
    } catch (e) { nerr('reply error: ' + e.message); }
}

// Sanitiza string para uso dentro de aspas simples PS
function q(s) {
    return String(s == null ? '' : s).replace(/'/g, "''").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// ------------------- fila de mutações (padrão Spooler v1.1.14) -------------------
// Mutações NÃO podem rodar em paralelo: enable/disable/restart de placa e mudanças de
// IP/DNS competem pela mesma pilha de rede; paralelismo gera estado inconsistente.
var MUTATION_OPS = ['setIp', 'setDhcp', 'setDns', 'renameAdapter', 'enableAdapter',
    'disableAdapter', 'setMac', 'resetMac', 'setAdvancedProp', 'setMtu', 'setProfile',
    'setDnsSuffix', 'setNetbios', 'setBindingState', 'installDriver'];
var mutQueue = [];
var mutRunning = false;

function queueMutation(op, nodeid, reqid, params, res) {
    res({ ok: true, phase: 'started', op: op });
    mutQueue.push({ op: op, nodeid: nodeid, reqid: res._reqid || reqid, params: params, res: res });
    nlog('queue: ' + op + ' len=' + mutQueue.length);
    processQueue();
}

function processQueue() {
    if (mutRunning) return;
    var item = mutQueue.shift();
    if (!item) return;
    mutRunning = true;
    nlog('queue: exec ' + item.op + ' (restantes=' + mutQueue.length + ')');
    try {
        MUTATION_HANDLERS[item.op](item.nodeid, item.reqid, item.params, function (result) {
            mutRunning = false;
            try { item.res(result); } catch (e2) { nerr('queue res: ' + e2.message); }
            processQueue();
        });
    } catch (e) {
        mutRunning = false;
        nerr('queue exec error: ' + e.message);
        try { item.res({ ok: false, error: 'fila: ' + e.message }); } catch (e2) {}
        processQueue();
    }
}

var MUTATION_HANDLERS = {};

// ------------------------- helpers PS -------------------------

// Snippet: acha o objeto NetAdapter pelo alias/nome e falha com ERR: se não existir
var PS_FIND_ADAPTER = "$a = Get-NetAdapter -Name '{NAME}' -ErrorAction SilentlyContinue; " +
    "if (-not $a) { Write-Output 'ERR:placa nao encontrada: {NAME}'; exit } ";

// Snippet: acha a subkey do registro da placa (para MAC/NetBIOS) e falha se não achar
var PS_FIND_REGKEY = "$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4D36E972-E325-11CE-BFC1-08002BE10318}'; " +
    "$sub = Get-ChildItem $base -ErrorAction SilentlyContinue | " +
    "  Where-Object { $_.PSChildName -match '^[0-9]{4}$' } | " +
    "  Where-Object { (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).NetCfgInstanceId -eq $a.InterfaceGuid } | " +
    "  Select-Object -First 1; " +
    "if (-not $sub) { Write-Output 'ERR:chave de registro da placa nao encontrada'; exit } ";

// ------------------------- handlers -------------------------

var handlers = {

    // ================================================================
    // INVENTÁRIO — placas + IP + gateway + DNS + DHCP + perfil + driver
    // ================================================================
    inventory: function (nodeid, reqid, params, res) {
        workerRun(
            "$out = @(); " +
            "$ads = @(Get-NetAdapter -ErrorAction SilentlyContinue); " +
            "foreach ($a in $ads) { " +
            "  $ifi = Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue; " +
            "  $ips = @(Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue); " +
            "  $gw = $null; try { $gw = (Get-NetRoute -InterfaceIndex $a.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1).NextHop } catch {}; " +
            "  $dns = @(); try { $dns = @(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses } catch {}; " +
            "  $prof = $null; try { $prof = Get-NetConnectionProfile -InterfaceIndex $a.ifIndex -ErrorAction Stop } catch {}; " +
            "  $suffix = $null; try { $suffix = (Get-DnsClient -InterfaceIndex $a.ifIndex -ErrorAction Stop).ConnectionSpecificSuffix } catch {}; " +
            "  $out += [pscustomobject]@{ " +
            "    name=$a.Name; alias=$a.InterfaceAlias; ifIndex=$a.ifIndex; guid=$a.InterfaceGuid; " +
            "    description=$a.InterfaceDescription; status=[string]$a.Status; adminStatus=[string]$a.AdminStatus; " +
            "    mac=$a.MacAddress; linkSpeed=[string]$a.LinkSpeed; fullDuplex=[bool]$a.FullDuplex; " +
            "    mediaType=[string]$a.MediaType; virtual=[bool]$a.Virtual; " +
            "    mtu=$(if($ifi){$ifi.NlMtu}else{$null}); " +
            "    dhcp=$(if($ifi){[string]$ifi.Dhcp}else{$null}); " +
            "    ipv4=@($ips | Select-Object -ExpandProperty IPAddress); " +
            "    prefixLengths=@($ips | Select-Object -ExpandProperty PrefixLength); " +
            "    gateway=$gw; dnsServers=$dns; " +
            "    profile=$(if($prof){$prof.NetworkCategory.ToString()}else{$null}); " +
            "    profileName=$(if($prof){$prof.Name}else{$null}); " +
            "    dnsSuffix=$suffix; " +
            "    driverDescription=$a.DriverDescription; driverVersion=$a.DriverVersion; " +
            "    driverDate=[string]$a.DriverDate; driverProvider=$a.DriverProvider; driverInfoString=$a.DriverInformation " +
            "  } " +
            "} " +
            "$out2 = [pscustomobject]@{ adapters=$out; hostname=$env:COMPUTERNAME } ",
            function (r) {
                if (r.ok && (!r.result || !r.result.length || !r.result[0])) { res({ ok: false, error: 'inventario vazio (Get-NetAdapter falhou?)' }); return; }
                if (r.ok) r.result = r.result[0];
                res(r);
            }
        );
    },

    // ================================================================
    // IP / DNS / DHCP
    // ================================================================

    // IP estático: remove IPs/gateway atuais, cria novo, aplica DNS e VERIFICA pós-ação
    setIp: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var ip = q(params.ip);
        var prefix = parseInt(params.prefix || 24, 10);
        var gw = params.gateway ? q(params.gateway) : null;
        var dns = Array.isArray(params.dns) ? params.dns : [];
        if (!name || !ip || isNaN(prefix) || prefix < 1 || prefix > 32) { res({ ok: false, error: 'Parametros invalidos (name, ip, prefix)' }); return; }
        var dnsArr = '';
        if (dns.length) {
            dnsArr = " Set-DnsClientServerAddress -InterfaceAlias '" + name + "' -ServerAddresses @(" + dns.map(function (d) { return "'" + q(d) + "'"; }).join(',') + ") -ErrorAction Stop; ";
        }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            PS_FIND_ADAPTER.replace(/\{NAME\}/g, name) +
            "  Remove-NetIPAddress -InterfaceAlias '" + name + "' -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue; " +
            "  Remove-NetRoute -InterfaceAlias '" + name + "' -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue; " +
            "  New-NetIPAddress -InterfaceAlias '" + name + "' -IPAddress '" + ip + "' -PrefixLength " + prefix + (gw ? (" -DefaultGateway '" + gw + "'") : "") + " -ErrorAction Stop | Out-Null; " +
            dnsArr +
            // verificação pós-ação: IP precisa ficar consultável (poll 1s x 15)
            "  $ok2 = $false; " +
            "  for ($i2 = 0; $i2 -lt 15; $i2++) { " +
            "    if (Get-NetIPAddress -InterfaceAlias '" + name + "' -IPAddress '" + ip + "' -AddressFamily IPv4 -ErrorAction SilentlyContinue) { $ok2 = $true; break } " +
            "    Start-Sleep -Seconds 1 " +
            "  } " +
            "  if (-not $ok2) { Write-Output 'ERR:IP nao ficou visivel apos New-NetIPAddress'; exit } " +
            "  Write-Output ('OK:' + '" + ip + "/" + prefix + "') " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, ip: params.ip, prefix: prefix, gateway: gw }; res(r); }
        );
    },

    // DHCP: remove IPs estáticos, habilita DHCP e reseta DNS
    setDhcp: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            PS_FIND_ADAPTER.replace(/\{NAME\}/g, name) +
            "  Remove-NetIPAddress -InterfaceAlias '" + name + "' -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue; " +
            "  Remove-NetRoute -InterfaceAlias '" + name + "' -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue; " +
            "  Set-NetIPInterface -InterfaceAlias '" + name + "' -AddressFamily IPv4 -Dhcp Enabled -ErrorAction Stop; " +
            "  Set-DnsClientServerAddress -InterfaceAlias '" + name + "' -ResetServerAddresses -ErrorAction Stop; " +
            "  $ok2 = $false; " +
            "  for ($i2 = 0; $i2 -lt 20; $i2++) { " +
            "    $ip2 = Get-NetIPAddress -InterfaceAlias '" + name + "' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -eq 'Dhcp' }; " +
            "    if ($ip2) { $ok2 = $true; break } " +
            "    Start-Sleep -Seconds 1 " +
            "  } " +
            "  if (-not $ok2) { Write-Output 'ERR:DHCP nao concedeu IP em 20s (sem DHCP server no segmento?)'; exit } " +
            "  Write-Output ('OK:' + ($ip2 | Select-Object -First 1).IPAddress) " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, dhcp: true }; res(r); }
        );
    },

    // Só DNS (mantém IP atual)
    setDns: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var dns = Array.isArray(params.dns) ? params.dns : [];
        if (!name || !dns.length) { res({ ok: false, error: 'Parametros invalidos (name, dns[])' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Set-DnsClientServerAddress -InterfaceAlias '" + name + "' -ServerAddresses @(" + dns.map(function (d) { return "'" + q(d) + "'"; }).join(',') + ") -ErrorAction Stop; " +
            "  $c = @(Get-DnsClientServerAddress -InterfaceAlias '" + name + "' -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses.Count; " +
            "  Write-Output ('OK:dns aplicado (' + $c + ')') " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, dns: dns }; res(r); }
        );
    },

    // Sufixo DNS + registro no DNS
    setDnsSuffix: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var suffix = params.suffix ? q(params.suffix) : '';
        var reg = params.register ? '$true' : '$false';
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Set-DnsClient -InterfaceAlias '" + name + "' -ConnectionSpecificSuffix '" + suffix + "' -RegisterThisConnectionsAddress " + reg + " -ErrorAction Stop; " +
            "  Write-Output 'OK' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, suffix: suffix, register: !!params.register }; res(r); }
        );
    },

    // ================================================================
    // PLACAS: ativar/desativar/renomear
    // ================================================================

    enableAdapter: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Enable-NetAdapter -Name '" + name + "' -Confirm:$false -ErrorAction Stop; " +
            "  $ok2 = $false; " +
            "  for ($i2 = 0; $i2 -lt 15; $i2++) { " +
            "    $a2 = Get-NetAdapter -Name '" + name + "' -ErrorAction SilentlyContinue; " +
            "    if ($a2 -and $a2.Status -eq 'Up') { $ok2 = $true; break } " +
            "    Start-Sleep -Seconds 1 " +
            "  } " +
            "  if (-not $ok2) { Write-Output 'OK:habilitada (aguardando link...)' } else { Write-Output 'OK:Up' } " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, enabled: true }; res(r); }
        );
    },

    disableAdapter: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Disable-NetAdapter -Name '" + name + "' -Confirm:$false -ErrorAction Stop; " +
            "  Write-Output 'OK' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, enabled: false }; res(r); }
        );
    },

    renameAdapter: function (nodeid, reqid, params, res) {
        var oldName = q(params.oldName);
        var newName = q(params.newName);
        if (!oldName || !newName) { res({ ok: false, error: 'oldName e newName obrigatorios' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Get-NetAdapter -Name '" + oldName + "' -ErrorAction Stop | Out-Null; " +
            "  Rename-NetAdapter -Name '" + oldName + "' -NewName '" + newName + "' -ErrorAction Stop; " +
            "  Write-Output 'OK' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { oldName: params.oldName, newName: params.newName }; res(r); }
        );
    },

    // ================================================================
    // MAC (spoof) / NetBIOS — via registro da classe de NIC + restart
    // ================================================================

    setMac: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var mac = String(params.mac || '').replace(/[:\-\.]/g, '').toUpperCase();
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        if (!/^[0-9A-F]{12}$/.test(mac)) { res({ ok: false, error: 'MAC invalido (use 12 hex, ex: 00155D8B2A01)' }); return; }
        if (/^(00-00-5E|01-00-5E|33-33|FF)/i.test(params.mac || '')) { res({ ok: false, error: 'MAC multicast/reservado nao permitido' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            PS_FIND_ADAPTER.replace(/\{NAME\}/g, name) +
            PS_FIND_REGKEY +
            "  Set-ItemProperty -Path $sub.PSPath -Name 'NetworkAddress' -Value '" + mac + "' -ErrorAction Stop; " +
            "  Restart-NetAdapter -Name '" + name + "' -Confirm:$false -ErrorAction Stop; " +
            "  Write-Output ('OK:MAC ' + '" + mac + "' + ' aplicado (apos restart da placa)') " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message + ' (alguns drivers nao suportam MAC spoof)') }",
            function (r) { if (r.ok) r.result = { name: params.name, mac: mac }; res(r); }
        );
    },

    resetMac: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            PS_FIND_ADAPTER.replace(/\{NAME\}/g, name) +
            PS_FIND_REGKEY +
            "  Remove-ItemProperty -Path $sub.PSPath -Name 'NetworkAddress' -ErrorAction SilentlyContinue; " +
            "  Restart-NetAdapter -Name '" + name + "' -Confirm:$false -ErrorAction Stop; " +
            "  Write-Output 'OK:MAC original restaurado' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, mac: null }; res(r); }
        );
    },

    // NetBIOS: 0=default(DHCP), 1=habilitado, 2=desabilitado (registry NetbiosOptions)
    setNetbios: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var mode = parseInt(params.mode, 10);
        if (!name || [0, 1, 2].indexOf(mode) === -1) { res({ ok: false, error: 'Parametros invalidos (name, mode: 0|1|2)' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            PS_FIND_ADAPTER.replace(/\{NAME\}/g, name) +
            PS_FIND_REGKEY +
            "  Set-ItemProperty -Path $sub.PSPath -Name 'NetbiosOptions' -Value " + mode + " -Type DWord -ErrorAction Stop; " +
            "  Restart-NetAdapter -Name '" + name + "' -Confirm:$false -ErrorAction Stop; " +
            "  Write-Output ('OK:NetBIOS ' + " + (mode === 0 ? "'default'" : (mode === 1 ? "'habilitado'" : "'desabilitado'")) + ") " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, netbios: mode }; res(r); }
        );
    },

    // ================================================================
    // MTU / perfil de rede
    // ================================================================

    setMtu: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var mtu = parseInt(params.mtu, 10);
        if (!name || isNaN(mtu) || mtu < 576 || mtu > 16384) { res({ ok: false, error: 'Parametros invalidos (name, mtu 576-16384)' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Set-NetIPInterface -InterfaceAlias '" + name + "' -AddressFamily IPv4 -NlMtuBytes " + mtu + " -ErrorAction Stop; " +
            "  $m2 = (Get-NetIPInterface -InterfaceAlias '" + name + "' -AddressFamily IPv4 -ErrorAction Stop).NlMtu; " +
            "  if ($m2 -ne " + mtu + ") { Write-Output ('ERR:MTU pedida ' + " + mtu + " + ' mas driver aceitou ' + $m2 + ' (limitacao do driver/NIC)') } " +
            "  else { Write-Output ('OK:MTU ' + $m2) } " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, mtu: mtu }; res(r); }
        );
    },

    // profile: Public | Private | DomainAuthenticated
    setProfile: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var prof = String(params.profile || '');
        if (['Public', 'Private', 'DomainAuthenticated'].indexOf(prof) === -1) { res({ ok: false, error: 'profile invalido (Public|Private|DomainAuthenticated)' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Set-NetConnectionProfile -InterfaceAlias '" + name + "' -NetworkCategory " + prof + " -ErrorAction Stop; " +
            "  Write-Output ('OK:' + '" + prof + "') " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message + ' (placa sem perfil ativo = sem conectividade?)') }",
            function (r) { if (r.ok) r.result = { name: params.name, profile: prof }; res(r); }
        );
    },

    // ================================================================
    // Propriedades avançadas (jumbo, offloads, speed/duplex...) / bindings
    // ================================================================

    setAdvancedProp: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var kw = q(params.registryKeyword);
        var val = q(params.registryValue);
        if (!name || !kw || val === '') { res({ ok: false, error: 'Parametros invalidos (name, registryKeyword, registryValue)' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Set-NetAdapterAdvancedProperty -Name '" + name + "' -RegistryKeyword '" + kw + "' -RegistryValue '" + val + "' -ErrorAction Stop; " +
            "  $v2 = Get-NetAdapterAdvancedProperty -Name '" + name + "' -RegistryKeyword '" + kw + "' -ErrorAction Stop; " +
            "  Write-Output ('OK:' + $v2.DisplayName + ' = ' + $v2.DisplayValue) " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, registryKeyword: params.registryKeyword, registryValue: params.registryValue }; res(r); }
        );
    },

    // state: 'enable' | 'disable'; componentID ex: ms_tcpip6, ms_lltdio, ms_msclient...
    setBindingState: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var comp = q(params.componentID);
        var enable = (params.state === 'enable');
        if (!name || !comp) { res({ ok: false, error: 'Parametros invalidos (name, componentID)' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            (enable
                ? "  Enable-NetAdapterBinding -Name '" + name + "' -ComponentID '" + comp + "' -ErrorAction Stop; "
                : "  Disable-NetAdapterBinding -Name '" + name + "' -ComponentID '" + comp + "' -ErrorAction Stop; ") +
            "  $b2 = Get-NetAdapterBinding -Name '" + name + "' -ComponentID '" + comp + "' -ErrorAction Stop; " +
            "  Write-Output ('OK:' + $b2.ComponentID + ' = ' + $b2.Enabled) " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, componentID: params.componentID, enabled: enable }; res(r); }
        );
    },

    // ================================================================
    // Drivers
    // ================================================================

    installDriver: function (nodeid, reqid, params, res) {
        var inf = q(params.infPath);
        if (!inf || inf.toLowerCase().indexOf('.inf') < 0) { res({ ok: false, error: 'infPath obrigatorio (caminho do .inf no cliente)' }); return; }
        runText(
            "$ErrorActionPreference='Continue'; " +
            "$o = & pnputil.exe /add-driver '" + inf + "' /install 2>&1 | Out-String; " +
            "if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Write-Output ('ERR:pnputil exit ' + $LASTEXITCODE + ': ' + $o.Substring(0, [Math]::Min(300, $o.Length))) } " +
            "else { Write-Output ('OK:' + $o.Substring(0, [Math]::Min(300, $o.Length)).Trim()) }",
            function (r) { if (r.ok) r.result = { infPath: params.infPath, output: r.result }; res(r); }
        );
    },

    // ================================================================
    // Diagnóstico (mutações leves de cache DNS)
    // ================================================================

    flushDns: function (nodeid, reqid, params, res) {
        runText(
            "try { Clear-DnsClientCache -ErrorAction Stop; Write-Output 'OK:cache DNS limpo' } " +
            "catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            res
        );
    },

    registerDns: function (nodeid, reqid, params, res) {
        runText(
            "try { $o = & ipconfig.exe /registerdns 2>&1 | Out-String; Write-Output ('OK:' + $o.Substring(0, [Math]::Min(200, $o.Length)).Trim()) } " +
            "catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            res
        );
    }
};

// ---- handlers de leitura (fora da fila, paralelos, via worker) ----

var readHandlers = {

    // Bindings de uma placa (IPv6, LLTD, Client for MS Networks, QoS...)
    listBindings: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        workerRun(
            "$out = @(Get-NetAdapterBinding -Name '" + name + "' -ErrorAction SilentlyContinue | Select-Object ComponentID, DisplayName, Enabled)",
            res
        );
    },

    // Propriedades avançadas do driver (RegistryKeyword = chave p/ setAdvancedProp)
    advancedProps: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        workerRun(
            "$out = @(); " +
            "$ps = @(Get-NetAdapterAdvancedProperty -Name '" + name + "' -ErrorAction SilentlyContinue); " +
            "foreach ($p in $ps) { " +
            "  $out += [pscustomobject]@{ " +
            "    displayName=$p.DisplayName; displayValue=$p.DisplayValue; " +
            "    registryKeyword=$p.RegistryKeyword; registryValue=($p.RegistryValue -join ','); " +
            "    validValues=($p.ValidDisplayValues -join '|'); " +
            "    validRegistryValues=($p.ValidRegistryValues -join '|') " +
            "  } " +
            "} ",
            res
        );
    },

    // Drivers NET instalados (Win32_PnPSignedDriver)
    listDrivers: function (nodeid, reqid, params, res) {
        workerRun(
            "$out = @(Get-CimInstance -ClassName Win32_PnPSignedDriver -ErrorAction SilentlyContinue | " +
            "  Where-Object { $_.DeviceClass -eq 'NET' } | " +
            "  Select-Object DeviceName, DriverVersion, DriverDate, DriverProviderName, InfName, IsSigned | " +
            "  Sort-Object DeviceName)",
            res
        );
    },

    // ping do cliente para um host
    ping: function (nodeid, reqid, params, res) {
        var host = q(params.host);
        var count = parseInt(params.count || 4, 10);
        if (!host) { res({ ok: false, error: 'host obrigatorio' }); return; }
        if (!/^[\w\.\-]+$/.test(host)) { res({ ok: false, error: 'host invalido' }); return; }
        if (isNaN(count) || count < 1) count = 4;
        if (count > 10) count = 10;
        workerRun(
            "$out = $null; " +
            "try { " +
            "  $o = & ping.exe -n " + count + " '" + host + "' 2>&1 | Out-String; " +
            "  $out = [pscustomobject]@{ host='" + host + "'; output=$o } " +
            "} catch {} ",
            function (r) {
                if (r.ok && (!r.result || !r.result.length || !r.result[0])) { res({ ok: false, error: 'ping sem resposta' }); return; }
                if (r.ok) r.result = r.result[0];
                res(r);
            }
        );
    },

    // tabela de rotas (IPv4, não loopback/multicast)
    getRoutes: function (nodeid, reqid, params, res) {
        workerRun(
            "$out = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | " +
            "  Where-Object { $_.DestinationPrefix -notlike '224.*' -and $_.DestinationPrefix -ne '255.255.255.255/32' } | " +
            "  Sort-Object RouteMetric | " +
            "  Select-Object -First 50 InterfaceAlias, DestinationPrefix, NextHop, RouteMetric, Protocol)",
            res
        );
    },

    // vizinhança ARP
    getNeighbors: function (nodeid, reqid, params, res) {
        workerRun(
            "$out = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | " +
            "  Where-Object { $_.State -in @('Reachable','Stale','Permanent') -and $_.IPAddress -ne '224.0.0.2' } | " +
            "  Select-Object -First 50 InterfaceAlias, IPAddress, LinkLayerAddress, State)",
            res
        );
    }
};

// Handlers JSON de leitura expostos como "handlers" também (dispatcher único)
['listBindings', 'advancedProps', 'listDrivers', 'ping', 'getRoutes', 'getNeighbors'].forEach(function (op) {
    handlers[op] = readHandlers[op];
});

// Popula a fila de mutações com os handlers reais
MUTATION_OPS.forEach(function (op) { MUTATION_HANDLERS[op] = handlers[op]; });

// ------------------------- dispatcher -------------------------

var ALLOWED = ['inventory', 'setIp', 'setDhcp', 'setDns', 'setDnsSuffix',
    'renameAdapter', 'enableAdapter', 'disableAdapter', 'setMac', 'resetMac',
    'setMtu', 'setProfile', 'setNetbios',
    'setAdvancedProp', 'listBindings', 'setBindingState',
    'listDrivers', 'installDriver',
    'ping', 'getRoutes', 'getNeighbors', 'flushDns', 'registerDns', 'setDebug'];

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    try {
        if (args.pluginaction === 'agentResult') return 'OK'; // loop guard: nunca processar própria resposta
        if (!args || args.plugin !== 'netadapter') return 'OK';
        if (args.pluginaction === 'setDebug') {
            naDebugFlag = (String(args.params && args.params.value) === 'true');
            nlog('debug=' + naDebugFlag);
            return 'OK';
        }
        var op = args.pluginaction;
        if (ALLOWED.indexOf(op) === -1) {
            nlog('acao nao permitida: ' + op);
            return 'DENIED';
        }
        var h = handlers[op];
        if (!h) { nlog('handler inexistente: ' + op); return 'NOHANDLER'; }
        var reqid = args.reqid;
        var params = args.params || {};

        // Mutação → fila serial (fase 'started' imediata; resultado final quando concluir)
        if (MUTATION_OPS.indexOf(op) !== -1) {
            nlog('exec(mut): ' + op + ' reqid=' + reqid);
            queueMutation(op, null, reqid, params, function (result) {
                nlog('result(mut): ' + op + ' reqid=' + reqid + ' ok=' + result.ok + (result.error ? (' err=' + result.error) : ''));
                reply(null, {
                    reqid: reqid, op: op, ok: result.ok,
                    phase: result.phase || 'done',
                    result: result.result || null, error: result.error || null,
                    target: params.name || params.host || params.infPath || null
                });
            });
            return 'OK';
        }

        // Leitura → execução direta (paralela OK)
        nlog('exec: ' + op + ' reqid=' + reqid + ' params=' + JSON.stringify(params).substring(0, 200));
        h(null, reqid, params, function (result) {
            nlog('result: ' + op + ' reqid=' + reqid + ' ok=' + result.ok + (result.error ? (' err=' + result.error) : ''));
            reply(null, {
                reqid: reqid, op: op, ok: result.ok,
                result: result.result || null, error: result.error || null,
                target: params.name || params.host || null
            });
        });
        return 'OK';
    } catch (e) {
        nerr('consoleaction error: ' + e.message + ' stack=' + e.stack);
        return 'ERR';
    }
}

// O dispatcher do core chama require('netadapter').consoleaction(...) — EXPORT obrigatório
module.exports = { consoleaction: consoleaction };

// Auto-teste ao carregar (log apenas, sempre gravado — 1 linha no boot)
if (typeof require !== 'undefined') {
    try {
        if (process.platform === 'win32') nerr('netadapter module loaded (debug=' + naDebugFlag + ')');
    } catch (e) {}
}
