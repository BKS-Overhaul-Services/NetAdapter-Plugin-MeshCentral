/**
 * NetAdapter — Database module
 * Catálogo de placas de rede (por dispositivo) + log de auditoria de operações.
 * NeDB com fallback chain (padrão Tracer/Spooler).
 */
"use strict";

module.exports.CreateDB = function (meshserver) {
    var obj = {};
    var Datastore = null;

    // Push node_modules path for NeDB resolution
    module.paths.push(require('path').join(meshserver.parentpath, 'node_modules'));

    // NeDB fallback chain
    try { Datastore = require('@seald-io/nedb'); } catch (ex) {}
    if (Datastore == null) {
        try { Datastore = require('@yetzt/nedb'); } catch (ex) {}
        if (Datastore == null) { Datastore = require('nedb'); }
    }

    // -------------------------------------------------------------------
    // Collection: catálogo de placas de rede
    // doc: { _id, nodeid, nodeName, name (InterfaceAlias), ifIndex, guid,
    //        description, mac, status, linkSpeed, ip, gateway, dhcp,
    //        dnsCount, driverVersion, driverProvider, absent, updatedAt }
    // key: nodeid + '\x00' + name
    // -------------------------------------------------------------------
    obj.adapters = new Datastore({
        filename: meshserver.getConfigFilePath('plugin-netadapter-adapters.db'),
        autoload: true
    });
    obj.adapters.setAutocompactionInterval(60000);
    obj.adapters.ensureIndex({ fieldName: 'nodeid' });
    obj.adapters.ensureIndex({ fieldName: 'name' });

    // -------------------------------------------------------------------
    // Collection: log de auditoria
    // doc: { _id, nodeid, nodeName, user, op, target, detail, ok, time }
    // -------------------------------------------------------------------
    obj.audit = new Datastore({
        filename: meshserver.getConfigFilePath('plugin-netadapter-audit.db'),
        autoload: true
    });
    obj.audit.setAutocompactionInterval(60000);
    obj.audit.ensureIndex({ fieldName: 'nodeid' });
    obj.audit.ensureIndex({ fieldName: 'time' });

    // ======================= ADAPTERS (catálogo) =======================

    obj.upsertAdapters = function (nodeid, nodeName, list) {
        var now = new Date();
        (list || []).forEach(function (a) {
            var doc = {
                nodeid: nodeid,
                nodeName: nodeName,
                name: a.name || a.alias || '?',
                ifIndex: a.ifIndex || null,
                guid: a.guid || null,
                description: a.description || a.driverDescription || null,
                mac: a.mac || null,
                status: a.status || null,
                linkSpeed: a.linkSpeed || null,
                ip: Array.isArray(a.ipv4) ? a.ipv4.join(', ') : null,
                gateway: a.gateway || null,
                dhcp: a.dhcpEnabled || null,
                dnsCount: Array.isArray(a.dnsServers) ? a.dnsServers.length : 0,
                driverVersion: a.driverVersion || null,
                driverProvider: a.driverProvider || null,
                updatedAt: now
            };
            obj.adapters.update(
                { nodeid: nodeid, name: doc.name },
                { $set: doc },
                { upsert: true },
                function (err) { if (err) console.log('NETADAPTER DB: upsertAdapters err=' + err.message); }
            );
        });
    };

    obj.markAbsent = function (nodeid, names) {
        // Marca placas que não aparecem mais no inventário
        obj.adapters.find({ nodeid: nodeid }, function (err, docs) {
            if (err || !docs) return;
            docs.forEach(function (d) {
                if (names.indexOf(d.name) === -1) {
                    obj.adapters.update({ _id: d._id }, { $set: { absent: true, updatedAt: new Date() } }, {});
                } else if (d.absent) {
                    obj.adapters.update({ _id: d._id }, { $unset: { absent: true }, $set: { updatedAt: new Date() } }, {});
                }
            });
        });
    };

    obj.getAdaptersByNode = function (nodeid, callback) {
        obj.adapters.find({ nodeid: nodeid }).sort({ name: 1 }).exec(function (err, docs) {
            callback(docs || []);
        });
    };

    obj.getAllAdapters = function (callback) {
        obj.adapters.find({ absent: { $ne: true } }).sort({ nodeName: 1, name: 1 }).exec(function (err, docs) {
            callback(docs || []);
        });
    };

    obj.removeNodeAdapters = function (nodeid) {
        obj.adapters.remove({ nodeid: nodeid }, { multi: true });
    };

    // ======================= AUDIT =======================

    obj.addAudit = function (entry) {
        entry.time = new Date();
        if (obj.audit.insert) obj.audit.insert(entry);
    };

    obj.getAudit = function (query, opts, callback) {
        if (typeof opts === 'function') { callback = opts; opts = {}; }
        var limit = (opts && opts.limit) || 500;
        var q = query || {};
        if (opts && opts.nodeid) q.nodeid = opts.nodeid;
        obj.audit.find(q).sort({ time: -1 }).limit(limit).exec(function (err, docs) {
            callback(docs || []);
        });
    };

    return obj;
};
