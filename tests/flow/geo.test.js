'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMock, makeAgentConn } = require('../_helpers/mock-meshcentral');

const factory = require('../../netadapter.js').netadapter;

// =============================================================================
// Flow: enriquecimento GEO via ip-api.com (server-side)
//
// Fluxo: frontend getIpInfo → agente responde publicIp → server:
//   cache hit (NeDB, TTL 6h)  → geoUpdate {cached:true} imediato
//   cache miss                → enfileira → _geoFlush():
//       1 IP  → GET  http://ip-api.com/json/<ip>?fields=...
//       N IPs → POST http://ip-api.com/batch?fields=... (até 100/batch)
//   → putGeo no cache → geoUpdate para todas as sessões esperando
//
// http injetado (obj._geoHttp) — sem rede real nos testes.
// O finish() do http fake é assíncrono (setImmediate) → testes com done().
// =============================================================================

function makeFakeRes(payload) {
    return {
        on: function (ev, cb) { if (ev === 'data') setImmediate(function () { cb(Buffer.from(JSON.stringify(payload))); }); if (ev === 'end') setImmediate(cb); }
    };
}

function makeSetup() {
    const audits = [];
    const geoStore = {};   // ip → {ts, geo}
    const agentConn = makeAgentConn('node//domain/n1');
    const { parent, captured } = buildMock({
        wsagents: { 'node//domain/n1': agentConn },
        wssessions2: { 'sess-1': { user: { _id: 'u', name: 'admin', siteadmin: 0xFFFFFFFF } } }
    });
    const obj = factory(parent);
    obj._geoEnabledOverride = true; // P1-c: estes testes exercitam o fluxo ON (opt-in)
    obj.db = {
        getGeo: function (ip, cb) { cb(geoStore[ip] || null); },
        putGeo: function (ip, geo, cb) { geoStore[ip] = { ts: Date.now(), geo: geo }; if (cb) cb(); },
        addAudit: function (a) { audits.push(a); },
        getAudit: function (q, o, cb) { cb(audits); },
        getAdaptersByNode: function (n, cb) { cb([]); },
        getAllAdapters: function (cb) { cb([]); }
    };
    return { obj, agentConn, captured, audits, geoStore };
}

function fakeHttp() {
    const calls = { get: [], post: [] };
    return {
        calls: calls,
        get: function (opts, cb) {
            calls.get.push(opts);
            setImmediate(function () { cb(makeFakeRes({ status: 'success', query: opts.path.match(/\/json\/([^?]+)/)[1], country: 'Brasil', city: 'São Paulo' })); });
            return { on: function () {}, destroy: function () {} };
        },
        request: function (opts, cb) {
            calls.post.push(opts);
            const req = {
                on: function () { return req; },
                write: function (body) { req.body = body; },
                end: function () {
                    setImmediate(function () {
                        let ips = [];
                        try { ips = JSON.parse(req.body); } catch (e) {}
                        cb(makeFakeRes(ips.map(function (ip) { return { status: 'success', query: ip, country: 'Brasil', city: 'São Paulo' }; })));
                    });
                },
                destroy: function () {}
            };
            return req;
        }
    };
}

test('geo: cache hit responde imediatamente sem tocar no ip-api', (t, done) => {
    const { obj, captured } = makeSetup();
    const http = fakeHttp();
    obj._geoHttp = http;
    obj.db.getGeo = function (ip, cb) { cb({ ts: Date.now(), geo: { status: 'success', query: ip, country: 'Chile', city: 'Santiago' } }); };

    obj._geoLookup('200.1.2.3', 'sess-1', 'node//x');

    setTimeout(function () {
        const geo = captured.sent.filter(function (m) { return m.data.method === 'geoUpdate'; });
        assert.equal(geo.length, 1);
        assert.equal(geo[0].data.cached, true);
        assert.equal(geo[0].data.geo.country, 'Chile');
        assert.equal(http.calls.get.length, 0);
        assert.equal(http.calls.post.length, 0);
        done();
    }, 30);
});

test('geo: cache miss com 1 IP → GET single + putGeo + dispatch', (t, done) => {
    const { obj, captured, geoStore } = makeSetup();
    const http = fakeHttp();
    obj._geoHttp = http;

    obj._geoLookup('200.1.2.3', 'sess-1', 'node//x');
    obj._geoFlush(); // dreno manual (sem esperar o timer)

    setTimeout(function () {
        assert.equal(http.calls.get.length, 1);
        assert.match(http.calls.get[0].path, /\/json\/200\.1\.2\.3\?fields=/);
        assert.ok(http.calls.get[0].path.indexOf('isp') > 0 && http.calls.get[0].path.indexOf('proxy') > 0);
        const geo = captured.sent.filter(function (m) { return m.data.method === 'geoUpdate'; });
        assert.equal(geo.length, 1);
        assert.equal(geo[0].data.geo.query, '200.1.2.3');
        assert.ok(geoStore['200.1.2.3'], 'resultado cacheado via putGeo');
        done();
    }, 30);
});

test('geo: N IPs na fila → 1 POST batch com todos + dispatch individual', (t, done) => {
    const { obj, captured } = makeSetup();
    const http = fakeHttp();
    obj._geoHttp = http;

    obj._geoLookup('10.0.0.1', 'sess-1', 'node//x');
    obj._geoLookup('10.0.0.2', 'sess-1', 'node//x');
    obj._geoLookup('10.0.0.3', 'sess-1', 'node//x');
    obj._geoFlush();

    setTimeout(function () {
        assert.equal(http.calls.get.length, 0);      // não usa GET com fila
        assert.equal(http.calls.post.length, 1);     // 1 request batch
        assert.equal(http.calls.post[0].method, 'POST');
        assert.match(http.calls.post[0].path, /\/batch\?fields=/);
        const geo = captured.sent.filter(function (m) { return m.data.method === 'geoUpdate'; });
        assert.equal(geo.length, 3);
        const gotIps = geo.map(function (m) { return m.data.ip; }).sort();
        assert.deepEqual(gotIps, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
        assert.equal(geo[0].data.geo.status, 'success');
        done();
    }, 30);
});

test('geo: ip-api falha (status fail) → dispatch com erro, sem cache', (t, done) => {
    const { obj, captured, geoStore } = makeSetup();
    obj._geoHttp = {
        get: function (opts, cb) {
            setImmediate(function () { cb(makeFakeRes({ status: 'fail', message: 'reserved range', query: opts.path.match(/\/json\/([^?]+)/)[1] })); });
            return { on: function () {}, destroy: function () {} };
        },
        request: function () { return { on: function () { return this; }, write: function () {}, end: function () {}, destroy: function () {} }; }
    };

    obj._geoLookup('10.10.10.10', 'sess-1', 'node//x');
    obj._geoFlush();

    setTimeout(function () {
        const geo = captured.sent.filter(function (m) { return m.data.method === 'geoUpdate'; });
        assert.equal(geo.length, 1);
        assert.equal(geo[0].data.geo, null);
        assert.equal(geo[0].data.error, 'reserved range');
        assert.ok(!geoStore['10.10.10.10'], 'falha NÃO é cacheada');
        done();
    }, 30);
});

test('geo: hook do getIpInfo registra publicIp e dispara lookup', (t, done) => {
    const { obj, agentConn, captured } = makeSetup();
    const http = fakeHttp();
    obj._geoHttp = http;

    // caminho normal do agentResult exige pending
    obj.pending['ip-1'] = { sid: 'sess-1', nodeid: 'node//domain/n1', op: 'getIpInfo', user: null, ts: Date.now(), mut: false };
    obj.serveraction({
        action: 'plugin', plugin: 'netadapter', pluginaction: 'agentResult', reqid: 'ip-1',
        op: 'getIpInfo', ok: true, result: { publicIp: '189.5.5.5', adapters: [], dns: [] }
    }, agentConn, null);

    assert.equal(obj._publicIp['node//domain/n1'], '189.5.5.5');
    obj._geoFlush();

    setTimeout(function () {
        const geo = captured.sent.filter(function (m) { return m.data.method === 'geoUpdate'; });
        assert.equal(geo.length, 1);
        assert.equal(geo[0].data.ip, '189.5.5.5');
        // e o browser também recebeu o agentResult normal do getIpInfo
        assert.ok(captured.sent.some(function (m) { return m.data.method === 'agentResult' && m.data.op === 'getIpInfo'; }));
        done();
    }, 30);
});
