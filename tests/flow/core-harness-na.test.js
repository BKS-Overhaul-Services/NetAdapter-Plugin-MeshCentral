'use strict';
// =============================================================================
// PORT NA — harness core-real: fluxos de domínio do NetAdapter.
// user resolution: fallback REAL webserver.users[command.userid] (wrapper injeta
// userid como o core faz, meshuser.js:4909).
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const H = require('../_helpers/core-harness.js');
const NID = 'node/domain/na1';
const MESH = 'mesh/domain/mesh1';
const ADMIN = { _id: 'user/admin', siteadmin: 0xFFFFFFFF, domain: 'domain', consent: 0, links: { [MESH]: { rights: 0xFFFFFFFF } } };

async function makeNA(opts) {
    const h = H.create(opts || {});
    delete require.cache[path.resolve(__dirname, '../../netadapter.js')];
    const obj = require(path.resolve(__dirname, '../../netadapter.js')).netadapter(h.serverParent);
    h.pluginHandler.plugins.netadapter = obj;
    // wrapper: injeta userid (meshuser.js:4909) antes do serveraction
    const orig = obj.serveraction.bind(obj);
    obj.serveraction = function (command, myparent, gp) {
        if (myparent && myparent.ws && myparent.ws.sessionId && command.userid === undefined) {
            const u = h.serverParent.wssessions2[myparent.ws.sessionId];
            if (u && u.user) command.userid = u.user._id; else if (h.userWs) command.userid = h.userWs.userid;
        }
        return orig(command, myparent, gp);
    };
    const agent = h.addAgent(NID, MESH);
    return { h, obj, agent };
}

test('PORT NA: serveraction direto chega ao plugin REAL (erro estruturado de op desconhecida)', async () => {
    const { h, obj } = await makeNA();
    await h.login(ADMIN);
    h.sendUser({ action: 'plugin', plugin: 'netadapter', pluginaction: 'opQueNaoExiste', nodeid: NID });
    await pollUntil(() => h.sent.some(m => m.method === 'agentResult' || m.method === 'pluginError'), 2000);
    const resp = h.sent.filter(m => m.method === 'agentResult' || m.method === 'pluginError').pop();
    assert.ok(resp, 'plugin REAL respondeu');
    assert.equal(resp.ok === undefined ? false : resp.ok, false);
    h.stop();
});

test('PORT NA: journal drain com sid morto — audit feita, pending consumido, entrega não lança', async () => {
    const { h, obj, agent } = await makeNA();
    await h.login(ADMIN);
    // dispatch real de uma mutação pelo core (routeToNode) para criar pending
    h.sendUser({ action: 'plugin', plugin: 'netadapter', pluginaction: 'setIp', nodeid: NID, routeToNode: true, params: { name: 'Ethernet' } });
    await pollUntil(() => (h.agentSent[NID] || []).length === 1, 2000);
    const reqid = h.agentSent[NID][0].reqid;
    // sessão do browser morre ANTES da resposta
    delete h.serverParent.wssessions2[h.userWs.sessionId];
    // journal drain do agente (netadapter.js:433): resultado real recuperado
    assert.doesNotThrow(function () {
        obj.serveraction({ plugin: 'netadapter', from: 'agent', cmd: 'mutresults', results: [
            { id: reqid, op: 'setIp', ok: true, target: 'Ethernet' }
        ] }, { nodeid: NID, dbNodeKey: NID }, null);
    }, 'drain lançou com sid morto');
    assert.equal(obj.pending[reqid], undefined, 'pending consumido pelo drain');
    h.stop();
});

test('PORT NA: hosts add com sessão fechada — timeout da varredura não lança (entrega p/ sid morta)', async () => {
    const { h, obj } = await makeNA();
    await h.login(ADMIN);
    // padrão NA: SEM routeToNode — serveraction cria pending e manda ao agente pelo próprio envelope (netadapter.js:221-239)
    h.sendUser({ action: 'plugin', plugin: 'netadapter', pluginaction: 'addHostsEntry', nodeid: NID, params: { ip: '10.0.0.9', hostnames: 'test.local', comment: 't' } });
    await pollUntil(() => Object.keys(obj.pending).length === 1, 2000);
    const reqid = Object.keys(obj.pending)[0];
    delete h.serverParent.wssessions2[h.userWs.sessionId]; // sessão cai
    // entrega do timeout exatamente como a varredura faz (netadapter.js:141-149)
    assert.doesNotThrow(function () {
        var p = obj.pending[reqid];
        obj.send(p.sid, { action: 'plugin', plugin: 'netadapter', method: 'agentResult', op: p.op, nodeid: p.nodeid, ok: false, error: 'Timeout: agente não concluiu a operação', reqid: reqid });
        delete obj.pending[reqid];
    }, 'timeout lançou p/ sid fechada');
    assert.equal(obj.pending[reqid], undefined);
    h.stop();
});

test('PORT NA: revealWifiPassword sem wifi_secrets → 403 estruturado, nada ao agente', async () => {
    const { h, obj, agent } = await makeNA();
    // usuário com direitos de node mas SEM a permissão wifi_secrets (getAccessPermissions deny)
    const user = { _id: 'user/semwifi', name: 'semwifi', domain: 'domain', siteadmin: 0,
        links: { [MESH]: { rights: 0xFFFFFFFF } }, consent: 0 };
    h.users[user._id] = user;
    // registra permissão (o harness não roda server_startup; o plugin espera registerPermissions)
    h.serverParent.registerPermissions = function () {};
    h.serverParent.getAccessPermissions = function () {
        return Promise.resolve(function () { return false; }); // tudo denied
    };
    await h.login(user);
    h.sendUser({ action: 'plugin', plugin: 'netadapter', pluginaction: 'revealWifiPassword', nodeid: NID, params: { name: 'Rede' } });
    await pollUntil(() => h.sent.some(m => m.method === 'result' || m.method === 'pluginError' || m.method === 'agentResult'), 2500);
    const resp = h.sent.filter(m => m.method === 'result' || m.method === 'pluginError' || m.method === 'agentResult').pop();
    assert.ok(resp, 'plugin respondeu');
    const ok = resp.ok === undefined ? false : resp.ok;
    assert.equal(ok, false, 'reveal negado sem permissão');
    assert.equal((h.agentSent[NID] || []).filter(m => m.pluginaction === 'revealWifiPassword').length, 0, 'nada ao agente');
    h.stop();
});

test('PORT NA: geoLookup OFF — getGeo não faz HTTP, erro estruturado', async () => {
    const { h, obj, agent } = await makeNA();
    await h.login(ADMIN);
    h.sendUser({ action: 'plugin', plugin: 'netadapter', pluginaction: 'getGeo', nodeid: NID });
    // getGeo sem IP público responde method:'geoUpdate' com error (netadapter.js:634-638)
    await pollUntil(() => h.sent.some(m => m.method === 'geoUpdate' || m.method === 'agentResult'), 2500);
    const resp = h.sent.filter(m => m.method === 'geoUpdate' || m.method === 'agentResult').pop();
    assert.ok(resp, 'getGeo respondeu');
    assert.ok(resp.error, 'geo off → erro estruturado: ' + JSON.stringify(resp));
    assert.equal((h.agentSent[NID] || []).filter(m => m.pluginaction === 'getGeo').length, 0, 'agente não foi consultado');
    h.stop();
});

function pollUntil(cond, timeoutMs) {
    const start = Date.now();
    return new Promise(function (resolve) {
        const iv = setInterval(function () {
            if (cond() || Date.now() - start > (timeoutMs || 2000)) { clearInterval(iv); resolve(cond()); }
        }, 10);
    });
}
