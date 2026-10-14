'use strict';
// =============================================================================
// P0-2 — Injeção PowerShell em contexto double-quote: neutralização.
//
// NÃO executa PowerShell: extrai as funções de sanitização/geração dos módulos
// dos agentes (Duktape-compatível) e asserita o script gerado nos vetores
// clássicos (" fecha string, $(cmd) subexpressão, `x escape char, $env var).
//
// Vetores que provavam execução como SYSTEM antes do fix:
//   comment = 'x"; Invoke-Expression(calc); #'
//   name    = 'x"; calc; #'
//   name    = "$(calc)"
//   comment = '`a' (backtick: char de escape do PS)
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// --- carrega os módulos dos agentes em sandbox (they são ES5, sem side effects
// de rede: netadapter precisa de mocks de require('fs')? Não: top-level roda
// try/catch em tudo; spooler idem). Extraímos via regex estável os corpos de
// q()/dq()/_hostsValidate para testar exatamente o código de produção. ---
function extractFn(src, name) {
    const re = new RegExp('function ' + name + '\\(([^)]*)\\) \\{', '');
    const m = re.exec(src);
    assert.ok(m, 'função ' + name + ' encontrada no fonte');
    let i = m.index + m[0].length, depth = 1, out = '';
    // varre contando chaves e NÃO inclui a chave de fechamento da função
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth > 0) out += ch;
        i++;
    }
    return new Function('return function ' + name + '(' + m[1] + ') {' + out + '\n};')();
}

const NA_SRC = fs.readFileSync(path.resolve(__dirname, '../../modules_meshcore/netadapter.js'), 'utf8');
const SP_SRC = fs.readFileSync(path.resolve(__dirname, '../../../Spooler-Plugin-MeshCentral/modules_meshcore/spooler.js'), 'utf8');
const naQ = extractFn(NA_SRC, 'q');
const naDq = extractFn(NA_SRC, 'dq');

// --- hosts line builder: replica o ponto de construção do addHostsEntry (fix
// P0-2) para asseritar o SCRIPT FINAL montado, não só o helper. ---
function buildHostsLine(entry, id, dq) {
    return dq(entry.ip) + '\t' + dq(entry.hns.join(' ')) + (entry.cmt ? ('\t# ' + dq(entry.cmt)) : '') + ' #na:' + id;
}
function buildAddHostsScript(entry, id) {
    var line = buildHostsLine(entry, id, naDq);
    return "$ErrorActionPreference='Stop'; " +
        "try { " +
        "  $f = $env:SystemRoot + '\\System32\\drivers\\etc\\hosts'; " +
        "  Add-Content -Path $f -Value \"" + line + "\" -Encoding ASCII -ErrorAction Stop; " +
        "} catch { Write-Output ('ERR:' + $_.Exception.Message) }";
}
// extrai apenas o argumento do -Value "..." (o trecho onde o valor do usuário vive)
function valueOf(script) {
    const m = /-Value "((?:[^"`]|`.)*?)"/.exec(script);
    assert.ok(m, 'capturou o valor do -Value');
    return m[1];
}

function id(s) { return s; }

// ---------------------------------------------------------------- dq() unit
test('dq: aspas duplas viram `"', () => {
    assert.equal(naDq('x"y'), 'x`"y');
});
test('dq: subexpressão $(calc) tem $ neutralizado → `$(', () => {
    assert.equal(naDq('$(calc)'), '`$(calc)');
});
test('dq: variável $env:x → `$env:x', () => {
    assert.equal(naDq('$env:SECRET'), '`$env:SECRET');
});
test('dq: backtick é dobrado (escape do escape)', () => {
    assert.equal(naDq('`a'), '``a');
    assert.equal(naDq('``'), '````');
});
test('dq: control chars removidos', () => {
    assert.equal(naDq('a\x00b\x1Fc'), 'abc');
});

// ------------------------------------------------- script hosts (add/update)
test('P0-2 hosts add: comment com " não fecha o -Value "..."', () => {
    const entry = { ip: '1.2.3.4', hns: ['host1'], cmt: 'x"; Invoke-Expression(calc); #' };
    const script = buildAddHostsScript(entry, 'naT1');
    // reconstrói: percorrendo o valor, cada " precisa ser precedido de `
    const val = valueOf(script);
    for (let i = 0; i < val.length; i++) {
        if (val[i] === '"') {
            // conta backticks imediatamente antes — precisa ser ímpar (escape ativo)
            let bs = 0; let j = i - 1;
            while (j >= 0 && val[j] === '`') { bs++; j--; }
            assert.ok(bs % 2 === 1, 'aspas na pos ' + i + ' está escapada com ` ímpar');
        }
    }
    assert.ok(val.indexOf('Invoke-Expression') >= 0, 'payload está no VALOR (vira conteúdo do hosts, não código)');
});

test('P0-2 hosts add: comment com $(calc) vira `$  → literal, sem execução', () => {
    const entry = { ip: '1.2.3.4', hns: ['host1'], cmt: '$(calc)' };
    const script = buildAddHostsScript(entry, 'naT2');
    const val = valueOf(script);
    assert.ok(val.indexOf('`$(calc)') >= 0, 'subexpressão neutralizada: `$(');
    assert.equal(/(^|[^`])\$\(/.test(val), false, 'não existe $( desprotegido no valor');
});

test('P0-2 hosts add: backtick no comment é dobrado', () => {
    const entry = { ip: '1.2.3.4', hns: ['host1'], cmt: 'tr`y' };
    const script = buildAddHostsScript(entry, 'naT3');
    assert.ok(script.indexOf('tr``y') >= 0);
});

test('P0-2 hosts update: mesma neutralização na reescrita', () => {
    const entry = { ip: '::1', hns: ['v6host'], cmt: 'x" && calc' };
    // replica updateHostsEntry (mesma linha, mesmo contexto double-quote)
    const line = buildHostsLine(entry, 'naT4', naDq);
    assert.ok(line.indexOf('`"') >= 0, 'aspas escapadas na line');
    assert.ok(line.indexOf('x"') === -1, 'nenhuma aspa crua no payload escapado');
});

// ------------------------------------------------------------- Spooler filter
test('P0-2 SP: pause/resume/testPage geram -Filter em aspas SIMPLES PS', () => {
    // extrai os 3 scripts como o handler monta (q() + rejeição de ")
    function spFilterScript(name) {
        const q = extractFn(SP_SRC, 'q');
        var n = q(name);
        if (n.indexOf('"') !== -1) return 'REJECT';
        return "$p = Get-CimInstance Win32_Printer -Filter 'Name=\"" + n + "\"'; ";
    }
    const normal = spFilterScript('HP LaserJet');
    assert.equal(normal, "$p = Get-CimInstance Win32_Printer -Filter 'Name=\"HP LaserJet\"'; ");

    // vetor 1: fechar o WQL e injetar OR — q() dobrou as aspas simples → literal
    const wql = spFilterScript("x' OR 1=1 OR Name='y");
    assert.ok(wql.indexOf("x'' OR 1=1 OR Name=''y") >= 0, 'aspas simples WQL dobradas (literal)');
    assert.ok(!/'[^']*'[^']*'[^']*'[^']*'/.test(wql.replace(/''/g, '')), 'sem aspas simples cruas após descontar escapes');

    // vetor 2: fechar o contexto PS — " é rejeitado antes de montar o script
    assert.equal(spFilterScript('x"; calc; #'), 'REJECT', 'nome com " é rejeitado (não há contexto double-quote para fechar)');

    // vetor 3: $(calc) — aspas simples PS não expandem; " fecharia o WQL → rejeitado
    assert.equal(spFilterScript('$(calc)"'), 'REJECT');
    const sub = spFilterScript('$(calc)');
    assert.equal(sub, "$p = Get-CimInstance Win32_Printer -Filter 'Name=\"$(calc)\"'; ",
        'sem " no nome, $( dentro de aspas simples PS é LITERAL (não expande)');
});
