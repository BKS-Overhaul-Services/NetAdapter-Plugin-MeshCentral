/**
 * NetAdapter — Gerenciador de Placas de Rede
 * Server-side. Padrão Spooler: serveraction + wsagents[nodeid].send + NeDB + reqid.
 *
 * Fluxo:
 *   frontend → ms.send({action:'plugin', plugin:'netadapter', pluginaction, nodeid, ...})
 *   serveraction → valida + envia ao agente via wsagents[nodeid].send() com reqid
 *   agente (netadapter.js) executa PowerShell e responde {pluginaction:'agentResult', reqid, ...}
 *   serveraction (msg sem sid = resposta do agente) → devolve ao frontend via wssessions2[sid]
 *
 * Mutação concluída (setIp, enable/disable, setMac...) → invalida o catálogo do node
 * (próximo refresh de inventário re-sincroniza).
 */
"use strict";

// Ops de mutação (mesma lista do agente) — timeout estendido (algumas derrubam a conexão
// ou mexem na pilha de rede; a verificação pós-ação pode levar até 30s)
var MUTATION_SERVER_OPS = ['setIp', 'setIp6', 'setDhcp', 'setDhcp6', 'setDns', 'renameAdapter', 'enableAdapter',
    'disableAdapter', 'setMac', 'resetMac', 'setAdvancedProp', 'setMtu', 'setProfile',
    'setDnsSuffix', 'setNetbios', 'setBindingState', 'installDriver',
    'addHostsEntry', 'updateHostsEntry', 'removeHostsEntry', 'toggleHostsEntry'];

// Ops que tocam na conectividade do próprio agente — timeout maior ainda
var SLOW_OPS = ['setIp', 'setIp6', 'setDhcp', 'setDhcp6', 'enableAdapter', 'disableAdapter', 'setMac', 'resetMac',
    'setNetbios', 'installDriver'];

// Configurável: gate de logs de diagnóstico (error sempre ativo)
var NA_DEBUG = true;

// Categorias de log (padrão Tracer/Spooler)
var NA_LOG = {
    error: function (ctx, err, extra) {
        try {
            var msg = '[NA ERROR] ' + ctx + ': ' + (err && err.message ? err.message : String(err));
            if (extra) msg += ' extra=' + JSON.stringify(extra);
            if (NA_DEBUG) msg += ' stack=' + (err && err.stack ? err.stack : '(no stack)');
            console.log(msg);
        } catch (_) {}
    },
    debug: function () {
        if (!NA_DEBUG) return;
        try { console.log('[NA DEBUG] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    },
    info: function () {
        if (!NA_DEBUG) return;
        try { console.log('[NA INFO] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    },
    raw: function () {
        if (!NA_DEBUG) return;
        try { console.log('[NA] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    }
};

module.exports.netadapter = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.debug = obj.meshServer.debug;
    obj.exports = ['onDeviceRefreshEnd'];
    obj.db = null;
    obj.mdb = obj.meshServer.db;
    obj.pending = {};   // reqid → { sid, nodeid, op, user, ts, mut }
    obj.cache = {};     // nodeid → { adapters[], ts } (invalidado em mutação)

    obj.server_startup = function () {
        try {
            NA_LOG.info('server_startup: init v' + (require('./config.json').version || '?'));
            obj.meshServer.pluginHandler.netadapter_db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
            obj.db = obj.meshServer.pluginHandler.netadapter_db;
            NA_LOG.info('server_startup: db initialized db=' + (obj.db.adapters ? 'ok' : 'FAIL'));
            // limpeza de pendings antigos
            setInterval(function () {
                var now = Date.now();
                for (var r in obj.pending) {
                    var p = obj.pending[r];
                    var max = p.mut ? (SLOW_OPS.indexOf(p.op) >= 0 ? 480000 : 360000) : 120000;
                    if (now - p.ts > max) {
                        NA_LOG.raw('reqid timeout op=' + p.op + ' node=' + p.nodeid + (p.mut ? ' (mutação)' : ''));
                        obj.send(p.sid, { action: 'plugin', plugin: 'netadapter', method: 'agentResult', op: p.op, nodeid: p.nodeid, ok: false, error: 'Timeout: agente não concluiu a operação (a conexão pode ter caído se a placa foi desativada?)', reqid: r });
                        delete obj.pending[r];
                    }
                }
            }, 30000);
        } catch (e) { NA_LOG.error('server_startup', e, { step: 'init' }); }
    };

    // ---------------- helpers ----------------

    obj.newReqId = function () {
        return 'na' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    };

    obj.send = function (sid, data) {
        try {
            var wss2 = obj.meshServer.webserver.wssessions2;
            if (wss2 && sid && wss2[sid]) {
                NA_LOG.raw('send method=' + data.method + ' sid=' + sid.substring(0, 40));
                wss2[sid].send(JSON.stringify(data));
                return true;
            }
            NA_LOG.raw('send: session not found sid=' + (sid ? sid.substring(0, 40) : 'null') + ' method=' + data.method);
        } catch (e) { NA_LOG.error('send', e, { sid: sid }); }
        return false;
    };

    obj.sendToAgent = function (nodeid, cmd) {
        try {
            var agent = obj.meshServer.webserver.wsagents ? obj.meshServer.webserver.wsagents[nodeid] : null;
            if (!agent) {
                NA_LOG.raw('sendToAgent: agent offline node=' + nodeid);
                return { ok: false, error: 'Dispositivo offline ou agente não conectado' };
            }
            agent.send(JSON.stringify(cmd));
            NA_LOG.raw('sendToAgent: op=' + cmd.pluginaction + ' reqid=' + cmd.reqid + ' node=' + nodeid);
            return { ok: true };
        } catch (e) {
            NA_LOG.error('sendToAgent', e, { nodeid: nodeid });
            return { ok: false, error: 'Falha ao enviar comando ao agente: ' + e.message };
        }
    };

    obj.getNodeName = function (nid) {
        try {
            if (obj.meshServer.webserver.wsagents && obj.meshServer.webserver.wsagents[nid]) {
                return obj.meshServer.webserver.wsagents[nid].name || nid;
            }
        } catch (e) {}
        return nid;
    };

    obj.audit = function (user, nodeid, op, target, detail, ok) {
        try {
            if (!obj.db) return;
            NA_LOG.raw('audit user=' + user + ' node=' + obj.getNodeName(nodeid) + ' op=' + op + ' target=' + target + ' ok=' + (ok !== false) + (detail ? (' detail=' + detail) : ''));
            obj.db.addAudit({
                user: user || '?',
                nodeid: nodeid || null,
                nodeName: nodeid ? obj.getNodeName(nodeid) : null,
                op: op,
                target: target || null,
                detail: detail || null,
                ok: ok !== false
            });
        } catch (e) { NA_LOG.error('audit', e); }
    };

    // Envia comando ao agente com correlação reqid
    obj.agentRequest = function (command, sid, user) {
        var nodeid = command.nodeid;
        if (!nodeid || typeof nodeid !== 'string') {
            obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'agentResult', op: command.pluginaction, ok: false, error: 'nodeid obrigatório' });
            return;
        }
        var reqid = obj.newReqId();
        var isMut = MUTATION_SERVER_OPS.indexOf(command.pluginaction) !== -1;
        obj.pending[reqid] = { sid: sid, nodeid: nodeid, op: command.pluginaction, user: user, ts: Date.now(), mut: isMut };
        NA_LOG.raw('agentRequest op=' + command.pluginaction + ' node=' + obj.getNodeName(nodeid) + ' reqid=' + reqid + ' params=' + JSON.stringify(command.params || {}).substring(0, 200));
        var r = obj.sendToAgent(nodeid, {
            action: 'plugin',
            plugin: 'netadapter',
            pluginaction: command.pluginaction,
            reqid: reqid,
            params: command.params || {}
        });
        if (!r.ok) {
            delete obj.pending[reqid];
            obj.audit(user, nodeid, command.pluginaction, command.params && (command.params.name || command.params.host || ''), r.error, false);
            obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'agentResult', op: command.pluginaction, nodeid: nodeid, reqid: reqid, ok: false, error: r.error });
        }
    };

    // ---------------- hooks ----------------

    // myparent = conexão (frontend ou agente)
    obj.serveraction = function (command, myparent, gp) {
        try {
            if (command.plugin !== 'netadapter') return;
            var isAgent = false;
            var sid = null;
            try {
                sid = myparent.ws.sessionId;
            } catch (e) {
                // conexão de agente não tem ws.sessionId → é resposta do agente
                isAgent = true;
            }
            NA_LOG.raw('serveraction action=' + command.pluginaction + ' from=' + (isAgent ? 'AGENT' : 'frontend') + ' node=' + (command.nodeid ? obj.getNodeName(command.nodeid) : '-'));

            // ---------- resposta do agente ----------
            if (isAgent || command.pluginaction === 'agentResult') {
                var reqid = command.reqid;
                var p = reqid ? obj.pending[reqid] : null;
                if (!p) {
                    NA_LOG.raw('agentResult sem pending reqid=' + reqid + ' (timeout ou sessão fechada)');
                    return;
                }
                // fase 'started': agente aceitou a mutação (fila) — NÃO consome o pending
                if (command.phase === 'started') {
                    NA_LOG.raw('agentResult STARTED op=' + (command.op || p.op) + ' reqid=' + reqid);
                    obj.send(p.sid, {
                        action: 'plugin', plugin: 'netadapter', method: 'agentResult',
                        op: command.op || p.op, nodeid: p.nodeid, reqid: reqid,
                        ok: true, phase: 'started'
                    });
                    return;
                }
                delete obj.pending[reqid];
                NA_LOG.raw('agentResult op=' + (command.op || p.op) + ' ok=' + (command.ok === true) +
                    (command.error ? (' error=' + String(command.error).substring(0, 300)) : '') +
                    ' result=' + JSON.stringify(command.result == null ? null :
                        (Array.isArray(command.result) ? command.result.slice(0, 3) : command.result)).substring(0, 300));
                if (!command.ok) {
                    obj.audit(p.user, p.nodeid, p.op, command.target || null, command.error || 'erro no agente', false);
                }
                // inventário: atualiza catálogo e invalida cache
                // PS quirk (ConvertTo-Json): array de 1 elemento chega como OBJETO
                // (agent sentou {adapters:[...], hostname} mas adapters com 1 placa
                // vem desserializado como pscustomobject) — normalizar SEMPRE.
                if ((command.op || p.op) === 'inventory' && command.ok && command.result) {
                    var adapters = command.result.adapters || command.result;
                    if (!Array.isArray(adapters)) adapters = (adapters != null) ? [adapters] : [];
                    // PS quirk nível 2: TODOS os campos-array aninhados com 1 elemento
                    // chegam como valor solto (string/número) — ex.: dnsServers com 1
                    // DNS vira string e o frontend lia dnsServers[0] = 1º caractere.
                    var ARR_FIELDS = ['ipv4', 'prefixLengths', 'ip4Origins', 'dnsServers',
                        'ipv6', 'prefix6Lengths', 'ip6Origins', 'ip6Sku', 'dnsServers6'];
                    adapters.forEach(function (ad) {
                        ARR_FIELDS.forEach(function (f) {
                            if (ad[f] != null && !Array.isArray(ad[f])) ad[f] = [ad[f]];
                        });
                    });
                    obj.cache[p.nodeid] = { adapters: adapters, ts: Date.now() };
                    try {
                        if (obj.db && obj.db.upsertAdapters) {
                            obj.db.upsertAdapters(p.nodeid, obj.getNodeName(p.nodeid), adapters);
                            obj.db.markAbsent(p.nodeid, (adapters || []).map(function (a) { return a.name || a.alias; }));
                        }
                    } catch (dbE) { NA_LOG.error('inventory:catalog', dbE); }
                }
                // mutação concluída: invalida cache do node (próximo inventory refetcha)
                if (p.mut && obj.cache[p.nodeid]) {
                    delete obj.cache[p.nodeid];
                    NA_LOG.raw('cache invalidado (mutação) node=' + p.nodeid);
                }
                obj.send(p.sid, {
                    action: 'plugin', plugin: 'netadapter', method: 'agentResult',
                    op: command.op || p.op, nodeid: p.nodeid, reqid: reqid,
                    ok: command.ok, result: command.result, error: command.error
                });
                return;
            }

            // ---------- comandos do frontend ----------
            var user = command.userid || '?';

            switch (command.pluginaction) {

                // ---- inventário / catálogo ----
                case 'inventory':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- IP / DNS / DHCP (IPv4 e IPv6) ----
                case 'setIp':
                case 'setIp6':
                case 'setDhcp':
                case 'setDhcp6':
                case 'setDns':
                case 'setDnsSuffix':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- placas ----
                case 'renameAdapter':
                case 'enableAdapter':
                case 'disableAdapter':
                case 'setMac':
                case 'resetMac':
                case 'setMtu':
                case 'setProfile':
                case 'setNetbios':
                case 'setBindingState':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- propriedades avançadas / bindings ----
                case 'advancedProps':
                case 'listBindings':
                case 'setAdvancedProp':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- drivers ----
                case 'listDrivers':
                case 'installDriver':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- diagnóstico ----
                case 'ping':
                case 'getRoutes':
                case 'getNeighbors':
                case 'flushDns':
                case 'registerDns':
                case 'getHosts':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- arquivo hosts (mutações gerenciadas) ----
                case 'addHostsEntry':
                case 'updateHostsEntry':
                case 'removeHostsEntry':
                case 'toggleHostsEntry':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- debug agent-side ligável remotamente ----
                case 'setDebug':
                    obj.sendToAgent(command.nodeid, {
                        action: 'plugin', plugin: 'netadapter',
                        pluginaction: 'setDebug', params: command.params || {}
                    });
                    obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'agentResult', op: 'setDebug', nodeid: command.nodeid, ok: true, result: { debug: (command.params && command.params.value) === 'true' } });
                    break;

                // ---- dados locais (sem agente) ----
                case 'getCatalog':
                    obj.db.getAdaptersByNode(command.nodeid, function (docs) {
                        obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'catalog', nodeid: command.nodeid, data: docs });
                    });
                    break;

                case 'getAllCatalog':
                    obj.db.getAllAdapters(function (docs) {
                        obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'allCatalog', data: docs });
                    });
                    break;

                case 'getAudit':
                    obj.db.getAudit({}, { nodeid: command.nodeid, limit: command.limit || 200 }, function (docs) {
                        obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'audit', data: docs });
                    });
                    break;

                default: {
                    NA_LOG.error('serveraction: unknown pluginaction=' + command.pluginaction, null);
                    obj.send(sid, {
                        action: 'plugin', plugin: 'netadapter', method: 'agentResult',
                        op: command.pluginaction, nodeid: command.nodeid || null,
                        ok: false, error: 'Ação não suportada pelo servidor (server JS desatualizado? reinstale o plugin): ' + command.pluginaction
                    });
                }
            }
        } catch (e) {
            NA_LOG.error('serveraction', e, { pluginaction: command ? command.pluginaction : 'N/A' });
        }
    };

    obj.handleAdminReq = function (req, res, user) {
        try {
            NA_LOG.raw('handleAdminReq url=' + req.url + ' user=' + (user ? user.name : 'null'));
            if (req.query.user == 1) {
                // aba do dispositivo
                return res.render('device', {
                    nodeid: req.query.nodeid || '',
                    nodeName: req.query.nodeid ? obj.getNodeName(req.query.nodeid) : 'Desconhecido'
                });
            }
            if (!user || (user.siteadmin & 0xFFFFFFFF) == 0) {
                NA_LOG.raw('handleAdminReq: 401 para ' + (user ? user.name : 'anônimo'));
                res.sendStatus(401);
                return;
            }
            res.render('admin', {});
        } catch (e) {
            NA_LOG.error('handleAdminReq', e, { url: req.url });
        }
    };

    obj.onDeviceRefreshEnd = function () {
        try {
            if (typeof currentNode === 'undefined' || !currentNode) return;
            if (currentNode.osdesc && currentNode.osdesc.toLowerCase().indexOf('windows') === -1) return;
            if (typeof pluginHandler === 'undefined' || !pluginHandler) return;
            pluginHandler.registerPluginTab({ tabTitle: 'Placas de Rede', tabId: 'pluginNetAdapterTab' });
            QA('pluginNetAdapterTab', '<iframe id="pluginIframeNetAdapter" style="width:100%;height:600px;overflow:auto" scrolling="yes" frameBorder=0 src="/pluginadmin.ashx?pin=netadapter&nodeid=' + encodeURIComponent(currentNode._id) + '&user=1" />');
        } catch (e) {
            NA_LOG.error('onDeviceRefreshEnd', e);
        }
    };

    return obj;
};
