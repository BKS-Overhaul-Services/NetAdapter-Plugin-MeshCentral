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
// v2.1: TRUE durante a homologação (validação Wi-Fi/GEO em produção) —
// desligar para 'false' no merge final.
var NA_DEBUG = false;
var NA_ACL = require(__dirname + '/vendor/plugin-lib/plugin-acl.js'); // plugin-lib v0.3.0 (fonte única; vendor gerado — NÃO EDITAR)

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
    // P0-1 — Envia erro estruturado de volta ao iframe (decisão de design P0-1
    // registrada em memorias-geral: nada executa no agente; o frontend trata
    // method:'pluginError').
    obj._sendPluginError = function (sid, pluginaction, nodeid, error, status) {
        obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'pluginError',
            pluginaction: pluginaction, nodeid: nodeid || null, ok: false,
            error: error, status: status || 403 });
    };

    // P0-1 — Porta de entrada da ACL p/ comandos do frontend. cb(true) → prossegue.
    // Toda leitura de dados do dispositivo (inclusive local-only getCatalog/
    // getAudit) exige MESHRIGHT_DEVICEDETAILS sobre o nodeid; getAllCatalog é
    // multi-node → exige admin full. MUTAÇÕES exigem REMOTECONTROL adicional.
    obj._authorizeFrontend = function (command, sid, myparent, requiredBits, cb) {
        var user = NA_ACL.getUser(myparent, command.userid, obj);
        if (command.pluginaction === 'getAllCatalog') {
            if (!NA_ACL.isAdminFull(user)) {
                NA_LOG.raw('ACL DENIED (getAllCatalog requer admin full) user=' + (user ? user._id : 'null'));
                obj._sendPluginError(sid, command.pluginaction, null, 'access denied', 403);
                return cb(false);
            }
            return cb(true);
        }
        NA_ACL.checkNodeRights(obj, user, command.nodeid, function (ok, rights) {
            if (!ok) {
                NA_LOG.raw('ACL DENIED op=' + command.pluginaction + ' node=' + command.nodeid +
                    ' user=' + (user ? user._id : 'null') + ' rights=0x' + (rights || 0).toString(16));
                obj._sendPluginError(sid, command.pluginaction, command.nodeid, 'access denied', 403);
                return cb(false);
            }
            cb(true);
        }, { requiredBits: requiredBits || NA_ACL.MESHRIGHT_DEVICEDETAILS });
    };
    obj.exports = ['onDeviceRefreshEnd', 'agentResult', 'audit', 'geoUpdate', 'catalog', 'allCatalog'];
    // No-ops para o frame PRINCIPAL do MeshCentral: ele recebe todas as mensagens
    // {action:'plugin', method:...} e chama pluginHandler.netadapter.<method>.
    // Sem o no-op registrado em obj.exports, prepExports não serializa a função
    // e o main frame loga "pluginHandler[...][...] is not a function" a cada msg.
    // As abas (iframes) fazem o trabalho real com os mesmos payloads.
    obj.agentResult = function () {};
    obj.audit = function () {};
    obj.geoUpdate = function () {};
    obj.catalog = function () {};
    obj.allCatalog = function () {};
    obj.db = null;
    obj.pending = {};   // reqid → { sid, nodeid, op, user, ts, mut }
    // P2-c — obj.cache REMOVIDO: era write-only (populado no inventory e
    // invalidado nas mutações, mas JAMAIS lido — nenhum getCatalog do frontend
    // o consultava; o catálogo persistente é o NeDB via db.js).

    obj.server_startup = function () {
        try {
            NA_LOG.info('server_startup: init v' + (require('./config.json').version || '?'));
            obj.meshServer.pluginHandler.netadapter_db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
            obj.db = obj.meshServer.pluginHandler.netadapter_db;
            NA_LOG.info('server_startup: db initialized db=' + (obj.db.adapters ? 'ok' : 'FAIL'));
            // P1-a — permissão dedicada para segredos Wi-Fi (padrão Tracer
            // usertracer.js:126-140). DEFAULT DENIED: ver senha em claro é
            // exceção que o admin concede, não regra.
            if (obj.parent && typeof obj.parent.registerPermissions === 'function') {
                try {
                    obj.parent.registerPermissions('netadapter', {
                        wifi_secrets: {
                            title: 'NetAdapter: revelar senhas Wi-Fi',
                            desc: 'Permite revelar senhas de redes Wi-Fi salvas nos dispositivos (key=clear). Sem isto, as senhas aparecem mascaradas.',
                            default: 'denied'
                        }
                    });
                    NA_LOG.info('registerPermissions: netadapter.wifi_secrets (default denied)');
                } catch (pE) { NA_LOG.error('registerPermissions', pE); }
            }
            // limpeza de pendings antigos
            // [P2-c] .unref() (padrão Tracer usertracer.js:117): timer de housekeeping
            // não deve segurar o event loop (a suite NA saía pendurada — wifi-secrets.
            // test.js chama server_startup; o outro holder era o autocompaction do
            // NeDB, limpo no próprio teste).
            var _pendingTimer = setInterval(function () {
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
            if (_pendingTimer && typeof _pendingTimer.unref === 'function') _pendingTimer.unref();
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

    // P1-c — Enriquecimento GEO via ip-api.com é OPT-IN: config.json do plugin
// {"geoLookup": false} por padrão (não vaza IP público dos devices p/ terceiro).
// ⚠️ ip-api.com free tier é HTTP-ONLY (HTTPS exige tier pago) — mesmo ligado,
// o tráfego vai em claro; documentado no config.json. O admin que liga assume.
// _geoEnabled(): lido em runtime (testes podem sobrescrever _geoEnabledOverride).
obj._geoEnabledOverride = null;
obj._geoEnabled = function () {
    if (obj._geoEnabledOverride !== null) return obj._geoEnabledOverride === true;
    try { return require('./config.json').geoLookup === true; } catch (_) { return false; }
};

    // Campos do ip-api.com (free tier — HTTP only, 45 req/min, batch até 100 IPs)
var GEO_FIELDS = 'status,message,continent,country,countryCode,region,regionName,city,zip,lat,lon,timezone,offset,currency,isp,org,as,asname,reverse,mobile,proxy,hosting,query';

// ---------------- hooks ----------------

    // v2.1 — GEO/IP público: enriquecimento server-side via ip-api.com
    // free tier: HTTP only, 45 req/min, batch até 100 IPs por POST.
    // Fluxo: agente reporta publicIp (getIpInfo) → server consulta cache NeDB →
    // se miss, enfileira e descarrega em batch (1.5s mínimo entre requests),
    // cacheia e entrega {method:'geoUpdate'} para as sessões esperando.
    obj._publicIp = {};        // nodeid → ip público conhecido
    obj._geoWait = {};         // ip → [{sid, nodeid}]
    obj._geoTimer = null;
    obj._geoLastFlush = 0;
    obj._GEO_TTL = 6 * 3600 * 1000;        // cache fresco por 6h (NeDB TTL 7d)
    obj._GEO_MIN_INTERVAL = 1500;          // ~40 req/min < 45 do free tier
    obj._geoHttp = null;                   // injetável p/ testes (default: require('http'))

    obj._geoScheduleFlush = function (delayMs) {
        if (obj._geoTimer) return;
        obj._geoTimer = setTimeout(function () {
            obj._geoTimer = null;
            obj._geoFlush();
        }, delayMs || obj._GEO_MIN_INTERVAL);
    };

    obj._geoLookup = function (ip, sid, nodeid) {
        if (!ip) return;
        if (!obj._geoEnabled()) {
            // P1-c — opt-in off: serve só cache local (se houver), nunca consulta ip-api
            obj.db.getGeo(ip, function (doc) {
                if (doc && doc.ts && (Date.now() - doc.ts) < obj._GEO_TTL) {
                    obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'geoUpdate', nodeid: nodeid, ip: ip, geo: doc.geo, cached: true });
                } else {
                    obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'geoUpdate', nodeid: nodeid, ip: ip, error: 'geoLookup desativado (config.json do plugin: geoLookup:true para habilitar)' });
                }
            });
            return;
        }
        obj.db.getGeo(ip, function (doc) {
            if (doc && doc.ts && (Date.now() - doc.ts) < obj._GEO_TTL) {
                obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'geoUpdate', nodeid: nodeid, ip: ip, geo: doc.geo, cached: true });
                return;
            }
            if (!obj._geoWait[ip]) obj._geoWait[ip] = [];
            obj._geoWait[ip].push({ sid: sid, nodeid: nodeid });
            obj._geoScheduleFlush();
        });
    };

    obj._geoDispatch = function (ip, list, geo, error) {
        (list || []).forEach(function (w) {
            obj.send(w.sid, { action: 'plugin', plugin: 'netadapter', method: 'geoUpdate', nodeid: w.nodeid, ip: ip, geo: geo || null, error: error || null });
        });
    };

    obj._geoFlush = function () {
        if (!obj._geoEnabled()) { obj._geoWait = {}; return; } // P1-c: opt-in off — nada sai do server
        var ips = Object.keys(obj._geoWait);
        if (!ips.length) return;
        var now = Date.now();
        if (now - obj._geoLastFlush < obj._GEO_MIN_INTERVAL) { obj._geoScheduleFlush(); return; }
        obj._geoLastFlush = now;
        var waiters = obj._geoWait;
        obj._geoWait = {};
        var http = obj._geoHttp || require('http');

        function finish(list) {
            ips.forEach(function (ip) {
                var g = (list || []).filter(function (x) { return x && x.query === ip; })[0] || null;
                if (g && g.status === 'success') {
                    obj.db.putGeo(ip, g);
                    obj._geoDispatch(ip, waiters[ip], g, null);
                } else {
                    obj._geoDispatch(ip, waiters[ip], null, (g && g.message) || 'sem resposta do ip-api');
                }
            });
        }

        try {
            if (ips.length === 1) {
                // single GET
                var req = http.get({ host: 'ip-api.com', path: '/json/' + ips[0] + '?fields=' + GEO_FIELDS, timeout: 8000 }, function (res2) {
                    var body = '';
                    res2.on('data', function (c) { body += c; });
                    res2.on('end', function () {
                        var d = null; try { d = JSON.parse(body); } catch (e) {}
                        finish([d]);
                    });
                });
                req.on('error', function () { finish(null); });
                req.on('timeout', function () { req.destroy(); finish(null); });
            } else {
                // BATCH: POST http://ip-api.com/batch (até 100 IPs por request)
                var payload = JSON.stringify(ips.slice(0, 100));
                var req2 = http.request({ host: 'ip-api.com', path: '/batch?fields=' + GEO_FIELDS, method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, function (res3) {
                    var body = '';
                    res3.on('data', function (c) { body += c; });
                    res3.on('end', function () {
                        var d = null; try { d = JSON.parse(body); } catch (e) {}
                        finish(Array.isArray(d) ? d : null);
                    });
                });
                req2.on('error', function () { finish(null); });
                req2.on('timeout', function () { req2.destroy(); finish(null); });
                req2.write(payload);
                req2.end();
            }
        } catch (e) {
            NA_LOG.error('_geoFlush', e);
            finish(null);
        }
    };

    // v2.0 — dedup de audit para resultados de mutação (normal OU recuperado via journal)
    obj._mutAudited = {};
    obj._mutAuditedCap = 5000;
    obj._markMutAudited = function (reqid) {
        obj._mutAudited[reqid] = true;
        var keys = Object.keys(obj._mutAudited);
        if (keys.length > obj._mutAuditedCap) {
            keys.slice(0, keys.length - obj._mutAuditedCap).forEach(function (k) { delete obj._mutAudited[k]; });
        }
    };

    // v2.0 — resultados de mutação recuperados do journal do agente
    // (mutações que derrubaram a conexão: disableAdapter, setIp, setMac...)
    // Envelope: { action:'plugin', plugin:'netadapter', from:'agent', cmd:'mutresults', results:[{id,op,ok,error,target,ts,synthetic?}] }
    obj._handleMutResults = function (command, agentConn) {
        try {
            var results = Array.isArray(command.results) ? command.results : [];
            var ackIds = [];
            var agentNodeid = null;
            try { agentNodeid = agentConn && agentConn.nodeid; } catch (_) {}
            results.forEach(function (r) {
                try {
                    if (!r || !r.id || !r.op) return;
                    ackIds.push(r.id); // acka tudo que processou OU dedupou (agente pode apagar)
                    if (obj._mutAudited[r.id]) return; // já auditado via caminho normal
                    obj._markMutAudited(r.id);
                    var p = obj.pending[r.id];
                    var nodeid, user, sid, op;
                    if (p) {
                        // pendente ainda aberto (timeout ainda não estourou) → fecha com o resultado REAL
                        delete obj.pending[r.id];
                        nodeid = p.nodeid; user = p.user; sid = p.sid; op = p.op;
                    } else {
                        // timeout já respondeu ao browser → auditoria é o que falta
                        nodeid = agentNodeid; user = null; sid = null; op = r.op;
                    }
                    var detail = (r.ok ? 'executado' : (r.error || 'erro')) + ' (recuperado via journal)';
                    if (r.synthetic) detail += ' [agente reiniciou no meio da mutação]';
                    obj.audit(user, nodeid, op, r.target || null, detail, r.ok === true);
                    if (sid) {
                        obj.send(sid, {
                            action: 'plugin', plugin: 'netadapter', method: 'agentResult',
                            op: op, nodeid: nodeid, reqid: r.id,
                            ok: r.ok === true, result: null, error: r.error || null,
                            _journal: true
                        });
                    }
                    NA_LOG.info('mutresults reqid=' + r.id + ' op=' + op + ' ok=' + (r.ok === true) + ' pending=' + (p ? 'fechado' : 'não (timeout/sessão)'));
                } catch (e) {
                    NA_LOG.error('_handleMutResults:item', e, { id: r && r.id });
                }
            });
            // ack de volta ao agente (JSON string — protocolo servidor→agente)
            try {
                if (agentConn && typeof agentConn.send === 'function' && ackIds.length) {
                    agentConn.send(JSON.stringify({ action: 'plugin', plugin: 'netadapter', cmd: 'mutack', ids: ackIds }));
                }
            } catch (e) { NA_LOG.error('_handleMutResults:ack', e); }
        } catch (e) {
            NA_LOG.error('_handleMutResults', e);
        }
    };

    // myparent = conexão (frontend ou agente)
    obj.serveraction = function (command, myparent, gp) {
        try {
            if (command.plugin !== 'netadapter') return;
            // v2.0 — journal drain do agente: agentConn NÃO tem .ws.sessionId;
            // precisa vir antes do branch de sid (mesmo padrão do Tracer v4)
            if (command.from === 'agent' && command.cmd === 'mutresults') {
                return obj._handleMutResults(command, myparent);
            }
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
                if (p.mut) obj._markMutAudited(reqid); // v2.0: journal drain depois não re-audita
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
                    try {
                        if (obj.db && obj.db.upsertAdapters) {
                            obj.db.upsertAdapters(p.nodeid, obj.getNodeName(p.nodeid), adapters);
                            obj.db.markAbsent(p.nodeid, (adapters || []).map(function (a) { return a.name || a.alias; }));
                        }
                    } catch (dbE) { NA_LOG.error('inventory:catalog', dbE); }
                }
                // v2.1 — getIpInfo: registra IP público e dispara enriquecimento GEO
                if ((command.op || p.op) === 'getIpInfo' && command.ok && command.result && command.result.publicIp) {
                    var pip = command.result.publicIp;
                    obj._publicIp[p.nodeid] = pip;
                    obj._geoLookup(pip, p.sid, p.nodeid);
                }
                // P1-a — getWifiProfiles SEMPRE chega mascarado ao browser
                // (últimos 2 chars). Revelação em claro só via revealWifiPassword
                // (pluginaction dedicada, permissão wifi_secrets + audit).
                if ((command.op || p.op) === 'getWifiProfiles' && command.ok && Array.isArray(command.result)) {
                    command.result.forEach(function (w) {
                        if (w && w.hasPassword && typeof w.password === 'string' && w.password.length) {
                            w.passwordMasked = w.password;
                            w.password = w.password.length <= 2 ? '••' : ('••••••••' + w.password.slice(-2));
                        }
                    });
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

            // P0-1 — ACL: mutações exigem DEVICEDETAILS+REMOTECONTROL; demais,
            // DEVICEDETAILS. Admin full bypassa (helper). Nega com pluginError.
            var MUT_REQUIRED = NA_ACL.MESHRIGHT_DEVICEDETAILS | NA_ACL.MESHRIGHT_REMOTECONTROL;
            obj._authorizeFrontend(command, sid, myparent,
                (MUTATION_SERVER_OPS.indexOf(command.pluginaction) !== -1) ? MUT_REQUIRED : NA_ACL.MESHRIGHT_DEVICEDETAILS,
                function (allowed) {
                    if (!allowed) return;
                    naDispatch();
                });

            function naDispatch() {

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

                // ---- v2.1: Wi-Fi + IP/GEO/DNS ----
                case 'getWifiNetworks':
                case 'getWifiStatus':
                case 'getIpInfo':
                    if (command.pluginaction === 'getIpInfo') {
                        command.params = command.params || {};
                        command.params.geoLookup = obj._geoEnabled() ? 'true' : 'false'; // P1-c: alinha agente ao opt-in do server
                    }
                    obj.agentRequest(command, sid, user);
                    break;
                case 'getWifiProfiles':
                    // P1-a: resposta SEMPRE mascarada (ver agentResult); audita a consulta
                    obj.agentRequest(command, sid, user);
                    break;
                case 'revealWifiPassword':
                    // P1-a — revelação em claro: exige DEVICEDETAILS+REMOTECONTROL
                    // (é mutação de exposição de segredo) E permissão dedicada
                    // wifi_secrets (default denied). Audit SEMPRE, com userid.
                    obj._authorizeFrontend(command, sid, myparent,
                        NA_ACL.MESHRIGHT_DEVICEDETAILS | NA_ACL.MESHRIGHT_REMOTECONTROL,
                        function (allowed) {
                            if (!allowed) return;
                            var rlUser = NA_ACL.getUser(myparent, command.userid, obj);
                            if (obj.parent && typeof obj.parent.getAccessPermissions === 'function') {
                                obj.parent.getAccessPermissions('netadapter', rlUser, { nodeid: command.nodeid })
                                    .then(function (has) {
                                        if (!has('wifi_secrets')) {
                                            NA_LOG.raw('revealWifiPassword DENIED (sem wifi_secrets) user=' + (rlUser ? rlUser._id : 'null'));
                                            obj._sendPluginError(sid, 'revealWifiPassword', command.nodeid, 'permission wifi_secrets denied', 403);
                                            return;
                                        }
                                        obj.audit(rlUser ? rlUser._id : user, command.nodeid, 'revealWifiPassword',
                                            'perfil: ' + (command.params && command.params.name || '?'), null, true);
                                        obj.agentRequest(command, sid, user);
                                    })
                                    .catch(function () {
                                        obj._sendPluginError(sid, 'revealWifiPassword', command.nodeid, 'permission check failed', 403);
                                    });
                            } else {
                                // sem API de permissões (core antigo): fail-closed
                                obj._sendPluginError(sid, 'revealWifiPassword', command.nodeid, 'permission API unavailable', 403);
                            }
                        });
                    break;
                case 'getGeo': {
                    // serve geo do cache (NeDB) usando o IP público conhecido do node
                    var gip = obj._publicIp[command.nodeid];
                    if (!gip) { obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'geoUpdate', nodeid: command.nodeid, error: 'IP público desconhecido — execute "Analisar IP/GEO/DNS" primeiro' }); break; }
                    obj.db.getGeo(gip, function (doc) {
                        if (doc && doc.ts && (Date.now() - doc.ts) < obj._GEO_TTL) {
                            obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'geoUpdate', nodeid: command.nodeid, ip: gip, geo: doc.geo, cached: true });
                        } else {
                            if (!obj._geoEnabled()) { obj.send(sid, { action: 'plugin', plugin: 'netadapter', method: 'geoUpdate', nodeid: command.nodeid, ip: gip, error: 'geoLookup desativado (config.json do plugin: geoLookup:true para habilitar)' }); return; } // P1-c (callback: return, não break)
                            obj._geoWait[gip] = obj._geoWait[gip] || [];
                            obj._geoWait[gip].push({ sid: sid, nodeid: command.nodeid });
                            obj._geoScheduleFlush();
                        }
                    });
                    break;
                }

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
                // P0-1 — ACL por node antes do render (padrão Tracer :439-475;
                // não confiar em ?user=1). Fail-closed: 403 sem direito.
                var aclUser = NA_ACL.getUser({ user: user }, user && user._id, obj);
                var aclNid = req.query.nodeid;
                if (!aclNid) { res.sendStatus(400); return; }
                NA_ACL.checkNodeRights(obj, aclUser, aclNid, function (ok) {
                    if (!ok) {
                        NA_LOG.raw('handleAdminReq: 403 device tab node=' + aclNid + ' user=' + (aclUser ? aclUser._id : 'null'));
                        res.sendStatus(403);
                        return;
                    }
                    res.render('device', {
                        nodeid: aclNid,
                        nodeName: obj.getNodeName(aclNid)
                    });
                });
                return;
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
