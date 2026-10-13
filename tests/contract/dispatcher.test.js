'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// =============================================================================
// Contract: dispatcher do módulo agente — ALLOWED × handlers × readHandlers
//
// Bugs que este teste pina (ambos ocorreram em produção):
//   1. op em ALLOWED mas SEM handler → "handler inexistente: getWifiStatus"
//      (op novo adicionado no ALLOWED e em readHandlers, mas não na lista
//       de mapeamento readHandlers→handlers)
//   2. handler existente mas op FORA do ALLOWED → "acao nao permitida:
//      advancedProps" (handler mapeado, dispatcher recusava)
//
// RAW: extrai ALLOWED, a lista de mapeamento e as chaves de handlers/
// readHandlers por regex do próprio arquivo — sem executar o módulo.
// =============================================================================

const SRC = fs.readFileSync(path.resolve(__dirname, '../../modules_meshcore/netadapter.js'), 'utf8');

function extractArrayLit(re) {
    const m = SRC.match(re);
    if (!m) return null;
    // remove comentários de linha antes do split (ex.: "// v2.1 — Wi-Fi ...")
    const clean = m[1].split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
    return clean.split(',').map(function (s) { return s.trim().replace(/^'|'$/g, '').replace(/^"/, '').replace(/"$/, ''); }).filter(Boolean);
}

const allowed = extractArrayLit(/var ALLOWED = \[([\s\S]*?)\];/);
const mapped = extractArrayLit(/\[('listBindings'[\s\S]*?)\]\.forEach/);

function extractObjectKeys(header) {
    const i = SRC.indexOf(header);
    if (i < 0) return [];
    // varre até a chave de fechamento no nível 0 ("};")
    let depth = 0, j = SRC.indexOf('{', i), start = j;
    for (; j < SRC.length; j++) {
        if (SRC[j] === '{') depth++;
        else if (SRC[j] === '}') { depth--; if (depth === 0) break; }
    }
    const body = SRC.substring(start, j);
    const keys = [];
    const re = /^\s{4}(\w+): function/gm;
    let m2;
    while ((m2 = re.exec(body))) keys.push(m2[1]);
    return keys;
}

const handlerKeys = extractObjectKeys('var handlers = {');
const readKeys = extractObjectKeys('var readHandlers = {');
const mutationOps = extractArrayLit(/var MUTATION_OPS = \[([\s\S]*?)\];/);

// ops que o dispatcher trata ANTES da lookup de handler
const SPECIAL = ['setDebug'];

test('dispatcher: todo op em ALLOWED tem handler (handlers ∪ readHandlers ∪ mutações ∪ especial)', () => {
    assert.ok(Array.isArray(allowed) && allowed.length > 20, 'ALLOWED extraído: ' + allowed);
    allowed.forEach(function (op) {
        if (SPECIAL.indexOf(op) >= 0) return;
        const has = handlerKeys.indexOf(op) >= 0 || readKeys.indexOf(op) >= 0 || (mutationOps || []).indexOf(op) >= 0;
        assert.ok(has, 'ALLOWED tem "' + op + '" mas não existe handler — produziria "handler inexistente"');
    });
});

test('dispatcher: todo handler mapeado (forEach readHandlers→handlers) está em ALLOWED', () => {
    assert.ok(Array.isArray(mapped) && mapped.length >= 10, 'lista de mapeamento extraída: ' + mapped);
    mapped.forEach(function (op) {
        assert.ok(allowed.indexOf(op) >= 0, '"' + op + '" tem handler mas NÃO está em ALLOWED — produziria "acao nao permitida"');
        assert.ok(readKeys.indexOf(op) >= 0, '"' + op + '" mapeado mas não existe em readHandlers');
    });
});

test('dispatcher: readHandlers não tem chave órfã (definida mas nunca exposta)', () => {
    // readHandlers deve estar integralmente mapeado ou em ALLOWED
    readKeys.forEach(function (op) {
        const exposed = (mapped || []).indexOf(op) >= 0 || allowed.indexOf(op) >= 0;
        assert.ok(exposed, 'readHandlers."' + op + '" definido mas nunca exposto (sem mapping/ALLOWED)');
    });
});

test('dispatcher: ops Wi-Fi/IP v2.1 estão em ALLOWED + mapeados', () => {
    ['getWifiNetworks', 'getWifiProfiles', 'getWifiStatus', 'getIpInfo'].forEach(function (op) {
        assert.ok(allowed.indexOf(op) >= 0, op + ' em ALLOWED');
        assert.ok((mapped || []).indexOf(op) >= 0, op + ' mapeado readHandlers→handlers');
        assert.ok(readKeys.indexOf(op) >= 0, op + ' existe em readHandlers');
    });
});
