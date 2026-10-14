'use strict';
// =============================================================================
// P1-a — Senhas Wi-Fi: mascaramento por padrão + revelação gated.
// Testa o SERVER (netadapter.js) com mock do core — sem agente nem PS.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVER_MODULE = path.resolve(__dirname, '../../netadapter.js');

function mkParent(opts) {
    opts = opts || {};
    const registered = {};
    const webserver = {
        wssessions2: {}, wsagents: opts.wsagents || {}, users: {},
        GetNodeWithRights: opts.GetNodeWithRights || function (d, u, nid, cb) {
            if (u && (u.siteadmin === 0xFFFFFFFF || u.siteadmin === -1)) { cb({ _id: nid }, 0xFFFFFFFF, true); return; }
            if (u && u.links && u.links[nid]) { cb({ _id: nid }, u.links[nid].rights, true); return; }
            cb(null, 0, false);
        }
    };
    const meshServer = {
        debug: function () {}, webserver: webserver,
        parent: { config: { settings: {}, domains: { '': { id: '' } } } },
        db: { Get: function (nid, cb) { cb(null, []); } },
        parentpath: path.resolve(__dirname, '../../node_modules'),
        path: require('node:path'),
        datapath: require('node:os').tmpdir(), // CreateDB usa getConfigFilePath → path.join(datapath, name)
        getConfigFilePath: function (name) { return require('node:path').join(require('node:os').tmpdir(), 'na-wifitest-' + name); },
        pluginHandler: {}
    };
    const parent = {
        parent: meshServer,
        registerPermissions: function (pluginName, perms) { registered[pluginName] = perms; },
        getAccessPermissions: opts.getAccessPermissions || function () { return Promise.resolve(function () { return false; }); },
        pluginPermissions: null,
        wrapFunctionCall: function () {}
    };
    return { parent, meshServer, webserver, registered };
}

const ADMIN = { _id: 'user/admin', siteadmin: 0xFFFFFFFF, domain: '', links: {} };
const DETAILS_ONLY = { _id: 'user/det', siteadmin: 0, domain: '', links: { 'node//w': { rights: 0x00100000 } } };

test('P1-a: registerPermissions registra wifi_secrets com default denied', (t) => {
    const { parent, registered, meshServer } = mkParent();
    const inst = require(SERVER_MODULE).netadapter(parent);
    // CreateDB resolve NeDB via path.join(parentpath, 'node_modules')
    // (db.js:13) — parentpath = raiz da instalação do core.
    meshServer.parentpath = 'I:/TI/Projetos/MeshCentral/Server/Open Source/MeshCentral';
    inst.server_startup();
    // [P2-c] cleanup de handles: o autocompaction do NeDB (db.js
    // setAutocompactionInterval) segura o event loop e o processo de teste
    // nunca saía. stopAutocompaction é API pública do NeDB.
    t.after(function () {
        ['adapters', 'audit', 'geo'].forEach(function (n) {
            try {
                if (inst.db && inst.db[n] && typeof inst.db[n].stopAutocompaction === 'function') inst.db[n].stopAutocompaction();
            } catch (_) {}
        });
    });
    assert.ok(registered.netadapter, 'netadapter registrado');
    assert.equal(registered.netadapter.wifi_secrets.default, 'denied');
});

test('P1-a: resposta getWifiProfiles chega MASCARADA (últimos 2 chars) com passwordMasked preservado', () => {
    const { parent } = mkParent();
    const inst = require(SERVER_MODULE).netadapter(parent);
    const sent = [];
    inst.send = function (sid, data) { sent.push(data); };
    // simula resposta do agente: pendente aberto
    inst.pending['r1'] = { sid: 's1', nodeid: 'node//w', op: 'getWifiProfiles', user: 'user/det', ts: Date.now(), mut: false };
    inst.serveraction({
        action: 'plugin', plugin: 'netadapter', pluginaction: 'agentResult',
        reqid: 'r1', op: 'getWifiProfiles', ok: true,
        result: [
            { name: 'NET1', auth: 'WPA2', cipher: 'CCMP', hasPassword: true, password: 'SUPERSECRETA99' },
            { name: 'ABERTA', auth: 'Open', cipher: 'None', hasPassword: false, password: '' },
            { name: 'CURTA', auth: 'WPA2', cipher: 'CCMP', hasPassword: true, password: 'ab' }
        ]
    }, { ws: {}, nodeid: 'node//w' });
    assert.equal(sent.length, 1);
    const rows = sent[0].result;
    assert.equal(rows[0].password, '••••••••99', 'só últimos 2 chars visíveis');
    assert.equal(rows[0].passwordMasked, 'SUPERSECRETA99', 'valor original preservado server-side p/ reveal');
    assert.equal(rows[1].password, undefined || rows[1].password, 'sem senha: intocado');
    assert.equal(rows[1].passwordMasked, undefined);
    assert.equal(rows[2].password, '••', 'senha ≤2 chars: fully masked');
});

test('P1-a: revealWifiPassword SEM wifi_secrets → 403 estruturado, nada vai ao agente', () => {
    const sentToAgent = [];
    const { parent } = mkParent({
        wsagents: { 'node//w': { send: function (d) { sentToAgent.push(JSON.parse(d)); } } },
        getAccessPermissions: function () { return Promise.resolve(function (p) { return false; }); }
    });
    const inst = require(SERVER_MODULE).netadapter(parent);
    const sent = [];
    inst.send = function (sid, data) { sent.push(data); };
    inst.serveraction({
        action: 'plugin', plugin: 'netadapter', pluginaction: 'revealWifiPassword',
        nodeid: 'node//w', userid: 'user/admin', params: { name: 'NET1' }
    }, { ws: { sessionId: 's9' }, user: ADMIN });
    setTimeout(() => {
        assert.equal(sentToAgent.length, 0, 'nada enviado ao agente');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].method, 'pluginError');
        assert.equal(sent[0].status, 403);
        assert.ok(String(sent[0].error).indexOf('wifi_secrets') >= 0);
    }, 20);
});

test('P1-a: revealWifiPassword COM wifi_secrets → audita com userid e envia ao agente', () => {
    const sentToAgent = [];
    const audits = [];
    const { parent } = mkParent({
        wsagents: { 'node//w': { send: function (d) { sentToAgent.push(JSON.parse(d)); } } },
        getAccessPermissions: function () { return Promise.resolve(function (p) { return p === 'wifi_secrets'; }); }
    });
    const inst = require(SERVER_MODULE).netadapter(parent);
    inst.db = { addAudit: function (a) { audits.push(a); } };
    const sent = [];
    inst.send = function (sid, data) { sent.push(data); };
    inst.serveraction({
        action: 'plugin', plugin: 'netadapter', pluginaction: 'revealWifiPassword',
        nodeid: 'node//w', userid: 'user/admin', params: { name: 'NET1' }
    }, { ws: { sessionId: 's9' }, user: ADMIN });
    setTimeout(() => {
        assert.equal(sentToAgent.length, 1, 'comando foi ao agente');
        assert.equal(sentToAgent[0].pluginaction, 'revealWifiPassword');
        assert.ok(sentToAgent[0].reqid, 'reqid correlacionado');
        assert.equal(audits.length, 1, 'audit gravado');
        assert.equal(audits[0].user, 'user/admin', 'audit com userid');
        assert.equal(audits[0].op, 'revealWifiPassword');
    }, 20);
});

test('P1-a: getWifiProfiles consulta NÃO audita mais como segredo (só o reveal audita)', () => {
    const audits = [];
    const sentToAgent = [];
    const { parent } = mkParent({
        wsagents: { 'node//w': { send: function (d) { sentToAgent.push(JSON.parse(d)); } } }
    });
    const inst = require(SERVER_MODULE).netadapter(parent);
    inst.db = { addAudit: function (a) { audits.push(a); } };
    inst.serveraction({
        action: 'plugin', plugin: 'netadapter', pluginaction: 'getWifiProfiles',
        nodeid: 'node//w', userid: 'user/det'
    }, { ws: { sessionId: 's9' }, user: DETAILS_ONLY });
    assert.equal(sentToAgent.length, 1, 'consulta segue ao agente (mascarada depois)');
    assert.equal(audits.length, 0, 'sem audit de segredo na listagem');
});
