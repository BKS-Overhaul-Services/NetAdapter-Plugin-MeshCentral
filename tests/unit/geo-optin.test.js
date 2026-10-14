'use strict';
// =============================================================================
// P1-c — ip-api opt-in: com geoLookup:false (default) NADA sai para ip-api.com
// (server e agente). Testa o server com _geoHttp injetado: http.request NÃO é
// chamado; erro estruturado volta ao browser; agente recebe params.geoLookup.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const SERVER_MODULE = path.resolve(__dirname, '../../netadapter.js');
const CFG_MODULE = path.resolve(__dirname, '../../config.json');

const ADMIN = { _id: 'user/admin', siteadmin: 0xFFFFFFFF, domain: '', links: {} };

function mkParent(opts) {
    opts = opts || {};
    const webserver = {
        wssessions2: {}, wsagents: opts.wsagents || {}, users: {},
        GetNodeWithRights: function (d, u, nid, cb) {
            if (u && (u.siteadmin === 0xFFFFFFFF || u.siteadmin === -1)) { cb({ _id: nid }, 0xFFFFFFFF, true); return; }
            cb(null, 0, false);
        }
    };
    const meshServer = {
        debug: function () {}, webserver: webserver,
        parent: { config: { settings: {}, domains: { '': { id: '' } } } },
        db: { Get: function (nid, cb) { cb(null, []); } },
        parentpath: path.resolve(__dirname, '../../node_modules'),
        getConfigFilePath: function (n) { return path.join(os.tmpdir(), 'na-geo-' + n); },
        pluginHandler: {}
    };
    const parent = {
        parent: meshServer, registerPermissions: function () {},
        getAccessPermissions: function () { return Promise.resolve(function () { return false; }); },
        pluginPermissions: null, wrapFunctionCall: function () {}
    };
    return { parent, meshServer, webserver };
}

test('P1-c: config.json default é geoLookup:false com documentação HTTP-only', () => {
    const cfg = JSON.parse(require('fs').readFileSync(CFG_MODULE, 'utf8'));
    assert.equal(cfg.geoLookup, false, 'default OFF');
    assert.ok(cfg._geoLookup_doc && /HTTP-ONLY/.test(cfg._geoLookup_doc), 'doc menciona HTTP-only');
});

test('P1-c: com opt-in OFF, getGeo responde erro estruturado e NUNCA chama http', () => {
    const { parent } = mkParent();
    const inst = require(SERVER_MODULE).netadapter(parent);
    const sent = [];
    inst.send = function (sid, data) { sent.push(data); };
    let httpCalls = 0;
    inst._geoHttp = { get: function () { httpCalls++; }, request: function () { httpCalls++; } };
    inst.db = { getGeo: function (ip, cb) { cb(null); }, addAudit: function () {}, adapters: true };
    inst.server_startup();
    inst._publicIp['node//w'] = '203.0.113.7';

    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'getGeo', nodeid: 'node//w', userid: 'user/admin' }, { ws: { sessionId: 's1' }, user: ADMIN });

    assert.equal(httpCalls, 0, 'nenhuma chamada HTTP saiu');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'geoUpdate');
    assert.ok(/geoLookup desativado/.test(sent[0].error || ''), 'erro explica como habilitar');
});

test('P1-c: com opt-in ON (override), getGeo enfileira e flush usa http injetado', () => {
    const { parent } = mkParent();
    const inst = require(SERVER_MODULE).netadapter(parent);
    const sent = [];
    inst.send = function (sid, data) { sent.push(data); };
    let httpCalls = 0;
    inst._geoHttp = {
        get: function (opts, cb) { httpCalls++; cb({ on: function (ev, cb2) { if (ev === 'end') setImmediate(cb2); if (ev === 'data') setImmediate(function () { cb2(Buffer.from(JSON.stringify({ status: 'success', query: '203.0.113.7' }))); }); }, destroy: function () {} }); },
        request: function () { httpCalls++; }
    };
    inst.db = { getGeo: function (ip, cb) { cb(null); }, putGeo: function () {}, addAudit: function () {}, adapters: true };
    inst._geoEnabledOverride = true; // fluxo ON
    inst.server_startup();
    inst._publicIp['node//w'] = '203.0.113.7';
    inst.serveraction({ action: 'plugin', plugin: 'netadapter', pluginaction: 'getGeo', nodeid: 'node//w', userid: 'user/admin' }, { ws: { sessionId: 's1' }, user: ADMIN });
    setTimeout(function () {
        inst._geoFlush();
        assert.equal(httpCalls, 1, 'ON: 1 GET para ip-api');
    }, 30);
});

test('P1-c: com opt-in OFF, _geoLookup (pós getIpInfo) não agenda flush e não chama http', () => {
    const { parent } = mkParent();
    const inst = require(SERVER_MODULE).netadapter(parent);
    const sent = [];
    inst.send = function (sid, data) { sent.push(data); };
    let httpCalls = 0;
    inst._geoHttp = { get: function () { httpCalls++; }, request: function () { httpCalls++; } };
    inst.db = { getGeo: function (ip, cb) { cb(null); }, addAudit: function () {}, adapters: true };
    inst.server_startup();

    inst._geoLookup('198.51.100.9', 's1', 'node//w');
    assert.equal(httpCalls, 0, 'nenhuma chamada HTTP');
    // resposta de erro estruturada chegou ao browser
    assert.ok(sent.some(s => s.method === 'geoUpdate' && /geoLookup desativado/.test(s.error || '')));
    // e o timer de flush não fica pendente com waiters
    assert.equal(Object.keys(inst._geoWait).length, 0);
});

test('P1-c: getIpInfo repassa params.geoLookup ao agente conforme opt-in (OFF)', () => {
    const sentToAgent = [];
    const { parent } = mkParent({
        wsagents: { 'node//w': { send: function (d) { sentToAgent.push(JSON.parse(d)); } } }
    });
    const inst = require(SERVER_MODULE).netadapter(parent);
    inst.db = { addAudit: function () {}, adapters: true };
    inst.serveraction({
        action: 'plugin', plugin: 'netadapter', pluginaction: 'getIpInfo',
        nodeid: 'node//w', userid: 'user/admin'
    }, { ws: { sessionId: 's1' }, user: ADMIN });
    assert.equal(sentToAgent.length, 1);
    assert.equal(sentToAgent[0].params.geoLookup, 'false', 'agente informado do opt-in OFF');
});
