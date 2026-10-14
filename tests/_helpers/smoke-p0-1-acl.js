'use strict';
// Smoke P0-1 — valida ACL backport nos 3 plugins com mock do core.
// Rodar: node tests/_helpers/smoke-p0-1-acl.js (a partir da pasta do plugin ou raiz)
const path = require('path');
const NA_ROOT = path.resolve(__dirname, '../..');

function mkParent(opts) {
    const users = {};
    (opts.users || []).forEach(u => { users[u._id] = u; });
    const webserver = {
        wssessions2: {}, wsagents: {}, users: users,
        GetNodeWithRights: opts.GetNodeWithRights || function (domain, user, nodeid, cb) { cb(null, 0, false); }
    };
    const meshServer = {
        debug: function () {}, webserver: webserver,
        parent: { config: { settings: {}, domains: { '': { id: '' }, 'sub': { id: 'sub' } } } },
        db: { Get: function (nid, cb) { cb(null, []); } },
        parentpath: path.join(NA_ROOT, 'node_modules')
    };
    return { parent: meshServer, registerPermissions: function () {}, getAccessPermissions: function () { return Promise.resolve(function () { return false; }); } };
}

function mkWs(user, sid) {
    return { ws: { sessionId: sid || 'sess-1', userid: user ? user._id : null }, user: user || null };
}

function sentTo(sent, sid) { return sent.filter(s => s.sid === sid); }

let failures = 0;
function check(name, cond) {
    if (!cond) { failures++; console.log('FAIL: ' + name); } else { console.log('ok: ' + name); }
}

// ------- fixtures -------
const ADMIN = { _id: 'user/admin', name: 'admin', siteadmin: 0xFFFFFFFF, domain: '' };
const HELPER = { _id: 'user/helper', name: 'helper', siteadmin: 0, domain: '', links: {} };
const NA_USER = { _id: 'user/na', name: 'na', siteadmin: 0, domain: '', links: { 'node//abc': { rights: 0x00100000 } } };            // só DEVICEDETAILS
const FULL_NODE = { _id: 'user/full', name: 'full', siteadmin: 0, domain: '', links: { 'node//abc': { rights: 0xFFFFFFFF } } };      // admin do node
const REMOTE_ONLY = { _id: 'user/ro', name: 'ro', siteadmin: 0, domain: '', links: { 'node//abc': { rights: 0x00000008 } } };        // só REMOTECONTROL

// rights granted pelo "core" simulando GetNodeWithRights via user.links reais:
function grantsFromLinks(domain, user, nodeid, cb) {
    if (!user || !user.links || !user.links[nodeid]) { cb(null, 0, false); return; }
    cb({ _id: nodeid }, user.links[nodeid].rights, true);
}

// ================= NetAdapter =================
(function () {
    const na = require(path.join(NA_ROOT, 'netadapter.js')).netadapter;
    const parent = mkParent({ GetNodeWithRights: grantsFromLinks });
    const inst = na(parent);
    // DB fake: getCatalog/getAllCatalog/getAudit respondem (smoke não depende de NeDB)
    inst.db = {
        getAdaptersByNode: function (n, cb) { cb([{ name: 'eth0' }]); },
        getAllAdapters: function (cb) { cb([{ nodeid: 'node//abc', name: 'eth0' }]); },
        getAudit: function (q, o, cb) { cb([{ op: 'x' }]); }
    };
    const captured = [];
    inst.send = function (sid, data) { captured.push({ sid: sid, data: data }); };

    // 1. usuário sem link → inventory NEGADO
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'inventory', nodeid: 'node//abc', userid: HELPER._id }, mkWs(HELPER));
    check('NA: sem link → pluginError 403',
        captured.length === 1 && captured[0].data.method === 'pluginError' && captured[0].data.status === 403);

    // 2. usuário com só DEVICEDETAILS → inventory OK (segue p/ agenteRequest; offline → erro de agente, não 403)
    parent.parent.webserver.wsagents = {}; // agente offline
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'inventory', nodeid: 'node//abc', userid: NA_USER._id }, mkWs(NA_USER));
    check('NA: DEVICEDETAILS → inventory passa ACL (erro de agente offline, não 403)',
        captured.length === 1 && captured[0].data.method === 'agentResult' && captured[0].data.ok === false &&
        String(captured[0].data.error).indexOf('offline') >= 0);

    // 3. usuário com só DEVICEDETAILS → setIp (mutação) NEGADO (falta REMOTECONTROL)
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'setIp', nodeid: 'node//abc', userid: NA_USER._id, params: {} }, mkWs(NA_USER));
    check('NA: DEVICEDETAILS sem REMOTECONTROL → mutação 403',
        captured.length === 1 && captured[0].data.method === 'pluginError' && captured[0].data.status === 403);

    // 4. REMOTEONLY (só REMOTECONTROL, sem DEVICEDETAILS) → leitura NEGADA
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'inventory', nodeid: 'node//abc', userid: REMOTE_ONLY._id }, mkWs(REMOTE_ONLY));
    check('NA: só REMOTECONTROL → leitura 403',
        captured.length === 1 && captured[0].data.method === 'pluginError' && captured[0].data.status === 403);

    // 5. admin do node (0xFFFFFFFF) → mutação passa ACL
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'setIp', nodeid: 'node//abc', userid: FULL_NODE._id, params: {} }, mkWs(FULL_NODE));
    check('NA: admin do node → mutação passa ACL (offline ≠ 403)',
        captured.length === 1 && captured[0].data.method === 'agentResult' && captured[0].data.ok === false);

    // 6. admin full do site bypassa tudo
    parent.parent.webserver.wsagents = {}; // agente offline p/ rotas de agente
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'getAllCatalog', userid: ADMIN._id }, mkWs(ADMIN));
    check('NA: admin full → getAllCatalog passa (resposta catalog/allCatalog)',
        captured.length === 1 && captured[0].data.method === 'allCatalog');

    // 7. não-admin → getAllCatalog NEGADO
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'getAllCatalog', userid: NA_USER._id }, mkWs(NA_USER));
    check('NA: não-admin → getAllCatalog 403',
        captured.length === 1 && captured[0].data.method === 'pluginError' && captured[0].data.status === 403);

    // 8. getAudit local exige DEVICEDETAILS
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'getAudit', nodeid: 'node//abc', userid: NA_USER._id }, mkWs(NA_USER));
    check('NA: DEVICEDETAILS → getAudit local passa', captured.length === 1 && captured[0].data.method === 'audit');
    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'getAudit', nodeid: 'node//abc', userid: HELPER._id }, mkWs(HELPER));
    check('NA: sem direito → getAudit 403',
        captured.length === 1 && captured[0].data.method === 'pluginError' && captured[0].data.status === 403);

    // 9. handleAdminReq device tab: sem direito → 403
    let status = null;
    const res403 = { sendStatus: function (s) { status = s; }, render: function () { status = 'render'; } };
    inst.handleAdminReq({ query: { user: 1, nodeid: 'node//abc' } }, res403, HELPER);
    check('NA: device tab sem direito → 403', status === 403);
    status = null;
    inst.handleAdminReq({ query: { user: 1, nodeid: 'node//abc' } }, res403, NA_USER);
    check('NA: device tab com direito → render', status === 'render');
    status = null;
    inst.handleAdminReq({ query: { user: 1, nodeid: 'node//abc' } }, res403, ADMIN);
    check('NA: device tab admin full → render', status === 'render');
})();

// ================= Spooler =================
(function () {
    const sp = require(path.join(NA_ROOT, '../Spooler-Plugin-MeshCentral/spooler.js')).spooler;
    const parent = mkParent({ GetNodeWithRights: grantsFromLinks });
    const inst = sp(parent);
    const captured = [];
    inst.send = function (sid, data) { captured.push({ sid: sid, data: data }); };
    parent.parent.webserver.wsagents = {};

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'spooler', pluginaction: 'summary', nodeid: 'node//abc', userid: HELPER._id }, mkWs(HELPER));
    check('SP: sem link → pluginError 403',
        captured.length === 1 && captured[0].data.method === 'pluginError' && captured[0].data.status === 403);

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'spooler', pluginaction: 'summary', nodeid: 'node//abc', userid: NA_USER._id }, mkWs(NA_USER));
    check('SP: DEVICEDETAILS → leitura passa ACL (offline ≠ 403)',
        captured.length === 1 && captured[0].data.method === 'agentResult' && String(captured[0].data.error).indexOf('offline') >= 0);

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'spooler', pluginaction: 'deletePrinter', nodeid: 'node//abc', userid: NA_USER._id, params: { name: 'p1' } }, mkWs(NA_USER));
    check('SP: DEVICEDETAILS sem REMOTECONTROL → mutação 403',
        captured.length === 1 && captured[0].data.method === 'pluginError' && captured[0].data.status === 403);

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'spooler', pluginaction: 'deletePrinter', nodeid: 'node//abc', userid: FULL_NODE._id, params: { name: 'p1' } }, mkWs(FULL_NODE));
    check('SP: admin do node → mutação passa ACL',
        captured.length === 1 && captured[0].data.method === 'agentResult' && String(captured[0].data.error).indexOf('offline') >= 0);

    let status = null;
    const res = { sendStatus: function (s) { status = s; }, render: function () { status = 'render'; } };
    inst.handleAdminReq({ query: { user: 1, nodeid: 'node//abc' } }, res, HELPER);
    check('SP: device tab sem direito → 403', status === 403);
    status = null;
    inst.handleAdminReq({ query: { user: 1, nodeid: 'node//abc' } }, res, NA_USER);
    check('SP: device tab com direito → render', status === 'render');
})();

// ================= NodeBridge =================
(function () {
    const nb = require(path.join(NA_ROOT, '../NodeBridge-Plugin-MeshCentral/nodebridge.js')).nodebridge;
    const parent = mkParent({ GetNodeWithRights: grantsFromLinks });
    const inst = nb(parent);
    const captured = [];
    inst.send = function (sid, data) { captured.push({ sid: sid, data: data }); };
    parent.parent.webserver.wsagents = { 'node//abc': { send: function () {} } };

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'nodebridge', pluginaction: 'call', nodeid: 'node//abc', userid: HELPER._id, module: 'os', fn: 'hostname', args: [] }, mkWs(HELPER));
    check('NB: sem link → result access denied 403',
        captured.length === 1 && captured[0].data.ok === false && captured[0].data.error === 'access denied' && captured[0].data.status === 403);

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'nodebridge', pluginaction: 'call', nodeid: 'node//abc', userid: NA_USER._id, module: 'os', fn: 'hostname', args: [] }, mkWs(NA_USER));
    check('NB: só DEVICEDETAILS → call (mutação) 403',
        captured.length === 1 && captured[0].data.ok === false && captured[0].data.status === 403);

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'nodebridge', pluginaction: 'call', nodeid: 'node//abc', userid: FULL_NODE._id, module: 'os', fn: 'hostname', args: [] }, mkWs(FULL_NODE));
    check('NB: admin do node → call encaminhado ao agente (sem 403)',
        captured.length === 0); // wsagents fake: resposta não volta ao browser; nada de deny

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'nodebridge', pluginaction: 'status', nodeid: 'node//abc', userid: NA_USER._id }, mkWs(NA_USER));
    check('NB: DEVICEDETAILS → status encaminhado (sem deny)',
        captured.length === 0);

    captured.length = 0;
    inst.serveraction({ action: 'plugin', plugin: 'nodebridge', pluginaction: 'status', nodeid: 'node//abc', userid: HELPER._id }, mkWs(HELPER));
    check('NB: sem link → status denied',
        captured.length === 1 && captured[0].data.method === 'status' && captured[0].data.error === 'access denied');
})();

// ================= helper: fail-closed e domínio =================
(function () {
    const ACL = require(path.join(NA_ROOT, 'vendor/plugin-lib/plugin-acl.js')); // plugin-lib v0.3.0
    // fail-closed sem API
    const FAILCLOSED_ADMIN = { _id: 'user/fc', name: 'fc', siteadmin: 0, domain: '', links: {} };
    ACL.checkNodeRights({ meshServer: { webserver: {} } }, FAILCLOSED_ADMIN, 'node//abc', function (ok) {
        check('ACL: sem GetNodeWithRights → deny (fail-closed)', ok === false);
    }, { requiredBits: ACL.MESHRIGHT_DEVICEDETAILS });
    // domain object derivado do nodeid
    const plugin = { meshServer: { parent: { config: { domains: { 'sub': { id: 'sub' } } } }, webserver: {
        GetNodeWithRights: function (domain, user, nodeid, cb) {
            check('ACL: domain resolvido do nodeid sub', domain && domain.id === 'sub');
            cb({ _id: nodeid }, 0x00100000, true);
        }
    } } };
    ACL.checkNodeRights(plugin, { siteadmin: 0, domain: '', links: {} }, 'node/sub/abc', function (ok) {
        check('ACL: rights DEVICEDETAILS → ok', ok === true);
    });
})();

console.log(failures === 0 ? '\nTODOS OS CHECKS PASSARAM' : '\n' + failures + ' FALHAS');
process.exit(failures === 0 ? 0 : 1);
