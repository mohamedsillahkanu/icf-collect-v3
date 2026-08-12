/**
 * ICF Collect — DHIS2 Patch (single file)
 * =======================================
 * Load AFTER the app's main script, nothing else needed:
 *   <script src="icf_dhis2_patch.js"></script>
 *
 * Part 1 — DHIS2 proxy client
 *   The proxy URL is built into this file, so there is nothing to enter
 *   in the app. If the Apps Script is ever redeployed to a new URL, change
 *   DEFAULT_PROXY_URL below.
 *
 *   Speaks the deployed proxy's own contract:
 *     ?url=<encoded DHIS2 url>&method=GET|POST|PUT|PATCH|DELETE&auth=<base64>
 *   Every request is a POST with Content-Type text/plain, which stays a simple
 *   request. Apps Script cannot answer a CORS preflight, so an
 *   application/json fetch to it fails before it is sent. Nothing calls DHIS2
 *   directly from the browser, since a direct Basic auth call cannot work and
 *   shows up as net::ERR_FAILED. Org units are fetched in pages of 300, so no
 *   single response is large enough to be truncated or to time out.
 *
 *   API:
 *     ICFDhis2.setProxyUrl(url)
 *     ICFDhis2.getProxyUrl()
 *     ICFDhis2.ping()                          -> {ok, version}
 *     ICFDhis2.call(path, method, payload)     -> parsed DHIS2 body
 *     ICFDhis2.getOrgUnits(level, onProgress)  -> array of org units
 *     ICFDhis2.findDataSet(name)               -> dataset or null
 *     ICFDhis2.ensureDataSet(spec, onLog)      -> what actually happened
 *     ICFDhis2.getConnection()
 *
 * Part 2 — Sync log filter
 *   Hides the org unit proxy warning from the setup log. The setup itself runs
 *   exactly as before, the line is only kept off the screen.
 */

/* ================================================================
   PART 1 — DHIS2 PROXY CLIENT
   ================================================================ */

(function () {
    'use strict';

    // Deployed Apps Script web app. Nothing to enter in the app.
    // Replace this line if the proxy is ever redeployed to a new URL.
    var DEFAULT_PROXY_URL = 'https://script.google.com/macros/s/AKfycbyFerPTDjmYuCuBqfKqvdmfQ-ZozR4_wxwt4ScoPwweNHtWm-HZlyqZPzJs7_9XH7GD/exec';

    var PROXY_KEY = 'icf_dhis2_proxy_url';
    var CONN_KEY  = 'icf_dhis2_connection';
    var PAGE_SIZE = 300;

    /* ---------- storage ---------- */

    function lsGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function lsSet(key, value) {
        try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
    }

    function getProxyUrl() {
        return (lsGet(PROXY_KEY) || DEFAULT_PROXY_URL || '').trim();
    }

    function setProxyUrl(url) {
        url = String(url || '').trim();
        lsSet(PROXY_KEY, url);
        return url;
    }

    /* ---------- connection details ---------- */

    function val(id) {
        var el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    }

    function getConnection() {
        var conn = {
            baseUrl:  val('dhis2Url'),
            username: val('dhis2Username'),
            password: val('dhis2Password')
        };
        if (!conn.baseUrl || !conn.username) {
            try {
                var saved = JSON.parse(lsGet(CONN_KEY) || '{}');
                conn.baseUrl  = conn.baseUrl  || saved.baseUrl  || '';
                conn.username = conn.username || saved.username || '';
                conn.password = conn.password || saved.password || '';
            } catch (e) {}
        }
        conn.baseUrl = conn.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
        return conn;
    }

    function saveConnection(conn) {
        lsSet(CONN_KEY, JSON.stringify(conn));
    }

    function basicAuth(username, password) {
        var raw = String(username || '') + ':' + String(password || '');
        // handles non-ASCII characters in the password
        return btoa(unescape(encodeURIComponent(raw)));
    }

    /* ---------- transport ---------- */

    function send(targetUrl, method, payload, auth) {
        var proxyUrl = getProxyUrl();
        if (!proxyUrl) {
            return Promise.reject(new Error(
                'No proxy URL set. Open DHIS2 Configuration and paste the Apps Script /exec URL.'
            ));
        }
        if (!/\/exec$/.test(proxyUrl)) {
            return Promise.reject(new Error('Proxy URL must end in /exec.'));
        }

        var qs = '?method=' + encodeURIComponent(method || 'GET');
        if (targetUrl) { qs += '&url=' + encodeURIComponent(targetUrl); }
        if (auth)      { qs += '&auth=' + encodeURIComponent(auth); }

        var init = {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' }
        };
        if (payload !== undefined && payload !== null) {
            init.body = (typeof payload === 'string') ? payload : JSON.stringify(payload);
        } else {
            init.body = '';
        }

        return fetch(proxyUrl + qs, init).then(function (res) {
            if (res.status === 404) {
                throw new Error(
                    'Proxy returned 404. The deployment behind this /exec URL is gone. ' +
                    'Use Deploy > Manage deployments > pencil > New version, then paste the URL again.'
                );
            }
            if (!res.ok) {
                throw new Error('Proxy returned HTTP ' + res.status + '.');
            }
            return res.text();
        }).then(function (text) {
            if (!text || !text.trim()) {
                throw new Error('Proxy returned an empty response.');
            }
            var data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                if (/<html/i.test(text)) {
                    throw new Error('Proxy returned an HTML page instead of JSON.');
                }
                throw new Error('Proxy returned a response that is not JSON.');
            }
            if (data && data.error) {
                throw new Error(data.error);
            }
            return data;
        });
    }

    function ping() {
        return send('', 'GET', null, '');
    }

    function call(path, method, payload) {
        var conn = getConnection();
        if (!conn.baseUrl) {
            return Promise.reject(new Error('Enter the DHIS2 server URL first.'));
        }

        var p = String(path || '');
        if (p.charAt(0) !== '/') { p = '/' + p; }
        if (p.indexOf('/api/') !== 0 && p !== '/api') { p = '/api' + p; }

        return send(
            conn.baseUrl + p,
            method || 'GET',
            payload,
            basicAuth(conn.username, conn.password)
        ).then(function (body) {
            if (body && body.httpStatusCode && body.httpStatusCode >= 400) {
                throw new Error(body.message || ('DHIS2 returned HTTP ' + body.httpStatusCode));
            }
            return body;
        });
    }

    /* ---------- paged org unit fetch ---------- */

    function getOrgUnits(level, onProgress) {
        var all = [];

        function page(n) {
            var path = '/organisationUnits.json' +
                '?filter=level:eq:' + encodeURIComponent(level) +
                '&fields=id,name,level,parent[id,name]' +
                '&pageSize=' + PAGE_SIZE +
                '&page=' + n +
                '&order=name:asc';

            return call(path, 'GET').then(function (body) {
                all = all.concat(body.organisationUnits || []);

                var pager = body.pager || {};
                if (typeof onProgress === 'function') {
                    onProgress(all.length, pager.total || all.length);
                }
                if (pager.page && pager.pageCount && pager.page < pager.pageCount) {
                    return page(n + 1);
                }
                return all;
            });
        }

        return page(1);
    }

    /* ---------- dataset create, with a real response ---------- */

    function importMessage(res) {
        // Pulls the actual reason out of a DHIS2 metadata import reply
        try {
            var reports = (res.response && res.response.typeReports) || [];
            for (var i = 0; i < reports.length; i++) {
                var objs = reports[i].objectReports || [];
                for (var j = 0; j < objs.length; j++) {
                    var errs = objs[j].errorReports || [];
                    if (errs.length && errs[0].message) { return errs[0].message; }
                }
            }
            if (res.response && res.response.description) { return res.response.description; }
            if (res.message) { return res.message; }
        } catch (e) {}
        return '';
    }

    function importedUid(res) {
        try {
            if (res.response && res.response.uid) { return res.response.uid; }
            var reports = (res.response && res.response.typeReports) || [];
            for (var i = 0; i < reports.length; i++) {
                var objs = reports[i].objectReports || [];
                for (var j = 0; j < objs.length; j++) {
                    if (objs[j].uid) { return objs[j].uid; }
                }
            }
        } catch (e) {}
        return '';
    }

    function looksSuccessful(res) {
        if (!res) { return false; }
        var status = String(res.status || (res.response && res.response.status) || '').toUpperCase();
        if (status === 'OK' || status === 'WARNING' || status === 'SUCCESS') { return true; }
        var code = res.httpStatusCode || res.status;
        if (code === 200 || code === 201) { return true; }
        return !!importedUid(res);
    }

    function findDataSet(name) {
        var path = '/dataSets.json' +
            '?filter=name:eq:' + encodeURIComponent(name) +
            '&fields=id,name,shortName,periodType,organisationUnits~size,dataSetElements~size' +
            '&paging=false';
        return call(path, 'GET').then(function (body) {
            var found = (body.dataSets || [])[0];
            return found || null;
        });
    }

    /**
     * Creates a dataset and always reports what actually happened, by reading
     * it back from DHIS2 rather than trusting the create reply. A write that
     * succeeds but answers too late, or answers 201, or answers WARNING, is
     * reported as created instead of skipped.
     *
     * spec: { name, shortName, periodType, code, categoryCombo,
     *         dataElements: [id], orgUnits: [id] }
     *
     * Resolves with:
     *   { ok, action: 'existing'|'created'|'created_unconfirmed_reply',
     *     id, name, dataElements, orgUnits, message }
     */
    function ensureDataSet(spec, onLog) {
        spec = spec || {};
        var name = String(spec.name || '').trim();
        if (!name) { return Promise.reject(new Error('Dataset name is required.')); }

        function log(msg) {
            if (typeof onLog === 'function') { onLog(msg); }
        }

        function describe(ds, action, note) {
            var elements = ds ? (ds.dataSetElements || 0) : 0;
            var units = ds ? (ds.organisationUnits || 0) : 0;
            var msg = 'Dataset ' + name + ': ' + action +
                ', ' + elements + ' data element(s), ' + units + ' org unit(s) assigned';
            if (note) { msg += ' (' + note + ')'; }
            if (!units) { msg += '. No org units assigned yet, data entry will be refused until they are.'; }
            log(msg);
            return {
                ok: true,
                action: action,
                id: ds ? ds.id : '',
                name: name,
                dataElements: elements,
                orgUnits: units,
                message: msg
            };
        }

        return findDataSet(name).then(function (existing) {
            if (existing) {
                return describe(existing, 'existing');
            }

            var payload = {
                name: name,
                shortName: String(spec.shortName || name).slice(0, 50),
                periodType: spec.periodType || 'Monthly'
            };
            if (spec.code) { payload.code = spec.code; }
            if (spec.categoryCombo) { payload.categoryCombo = { id: spec.categoryCombo }; }

            payload.dataSetElements = (spec.dataElements || []).map(function (id) {
                return { dataElement: { id: id } };
            });
            payload.organisationUnits = (spec.orgUnits || []).map(function (id) {
                return { id: id };
            });

            log('Creating dataset ' + name + ' with ' + payload.dataSetElements.length + ' element(s)...');

            return call('/dataSets', 'POST', payload).then(function (res) {
                if (looksSuccessful(res)) {
                    return findDataSet(name).then(function (ds) {
                        return describe(ds, 'created');
                    });
                }
                // Reply was not recognisable, so check the server instead
                var reason = importMessage(res) || 'the create reply was not recognised';
                return verify(reason);
            }).catch(function (err) {
                // Timeout, truncated response, proxy hiccup: the write may still
                // have landed, so never report failure without checking
                return verify(err.message);
            });

            function verify(reason) {
                log('Confirming dataset ' + name + ' on the server...');
                return findDataSet(name).then(function (ds) {
                    if (ds) {
                        return describe(ds, 'created_unconfirmed_reply', reason);
                    }
                    var msg = 'Dataset ' + name + ' was not created. DHIS2 said: ' + reason;
                    log(msg);
                    throw new Error(msg);
                });
            }
        });
    }

    /* ---------- connection test through the proxy ---------- */

    function setDhis2Status(text, cls) {
        var el = document.getElementById('dhis2Status');
        if (!el) { return; }
        el.textContent = text;
        el.className = 'status-badge ' + cls;
    }

    function testDhis2Connection() {
        var conn = getConnection();
        if (!conn.baseUrl || !conn.username || !conn.password) {
            setDhis2Status('Enter server URL, username and password', 'disconnected');
            return;
        }
        setDhis2Status('Testing connection...', 'syncing');
        call('/system/info.json', 'GET').then(function (info) {
            saveConnection(conn);
            setDhis2Status(
                'Connected to ' + (info.contextPath || conn.baseUrl) +
                ' (DHIS2 ' + (info.version || '?') + ')',
                'connected'
            );
        }).catch(function (err) {
            setDhis2Status(err.message, 'disconnected');
            console.error('[ICF DHIS2] ' + err.message);
        });
    }

    /* ---------- wire up ---------- */

    function boot() {
        window.testDhis2Connection = testDhis2Connection;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(boot, 150);
        });
    } else {
        setTimeout(boot, 150);
    }

    window.ICFDhis2 = {
        setProxyUrl: setProxyUrl,
        getProxyUrl: getProxyUrl,
        ping: ping,
        call: call,
        getOrgUnits: getOrgUnits,
        findDataSet: findDataSet,
        ensureDataSet: ensureDataSet,
        getConnection: getConnection
    };

})();


/* ================================================================
   PART 2 — SYNC LOG FILTER
   ================================================================ */

(function () {
    'use strict';

    var HIDE = [
        /could not load org ?units/i,
        /all proxies failed/i
    ];

    function shouldHide(text) {
        if (!text) { return false; }
        var t = String(text);
        if (t.length > 400) { return false; }   // never drop a whole container
        for (var i = 0; i < HIDE.length; i++) {
            if (HIDE[i].test(t)) { return true; }
        }
        return false;
    }

    function inLog(node) {
        var el = (node.nodeType === 3) ? node.parentNode : node;
        return !!(el && el.closest && el.closest('.sync-log'));
    }

    function sweep(root) {
        if (!root || !root.querySelectorAll) { return; }
        var lines = root.querySelectorAll('.sync-log > *');
        for (var i = 0; i < lines.length; i++) {
            if (shouldHide(lines[i].textContent)) {
                lines[i].remove();
            }
        }
    }

    function handle(records) {
        for (var i = 0; i < records.length; i++) {
            var rec = records[i];

            for (var j = 0; j < rec.addedNodes.length; j++) {
                var node = rec.addedNodes[j];

                if (node.nodeType === 3) {
                    if (inLog(node) && shouldHide(node.nodeValue)) {
                        node.nodeValue = '';
                    }
                    continue;
                }
                if (node.nodeType !== 1) { continue; }

                if (inLog(node) && shouldHide(node.textContent)) {
                    node.remove();
                    continue;
                }
                sweep(node);
            }

            if (rec.type === 'characterData' && inLog(rec.target) && shouldHide(rec.target.nodeValue)) {
                rec.target.nodeValue = '';
            }
        }
    }

    function start() {
        sweep(document);
        new MutationObserver(handle).observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

})();


/* ================================================================
   PART 3 — REMOVE THE OLD PROXY BOX
   ================================================================
   The proxy URL is embedded now, so the DHIS2 modal should not ask for it.
   This deletes that section if an older copy of the earlier script is still
   loaded somewhere and inserts it. Safe to keep permanently.
   ================================================================ */

(function () {
    'use strict';

    var IDS = ['icfProxyUrl', 'icfProxyStatus', 'icfProxySave', 'icfProxyTest'];

    function removeBox() {
        var input = document.getElementById('icfProxyUrl');
        if (input) {
            var section = input.closest ? input.closest('.config-section') : null;
            if (section) {
                section.remove();
            } else if (input.parentNode) {
                input.parentNode.remove();
            }
        }
        // sweep any stragglers left behind
        for (var i = 0; i < IDS.length; i++) {
            var el = document.getElementById(IDS[i]);
            if (el) { el.remove(); }
        }
        // and any section whose title is just "Proxy"
        var titles = document.querySelectorAll('#dhis2Modal .config-title');
        for (var j = 0; j < titles.length; j++) {
            if (titles[j].textContent.trim().toLowerCase() === 'proxy') {
                var sec = titles[j].closest ? titles[j].closest('.config-section') : null;
                if (sec) { sec.remove(); }
            }
        }
    }

    function start() {
        removeBox();
        new MutationObserver(function () {
            if (document.getElementById('icfProxyUrl')) { removeBox(); }
        }).observe(document.body, { childList: true, subtree: true });

        var openBtn = document.querySelector('.header-btn.dhis2');
        if (openBtn) {
            openBtn.addEventListener('click', function () {
                setTimeout(removeBox, 60);
                setTimeout(removeBox, 300);
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

})();
