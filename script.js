// ================================================================
// ICF COLLECT — DHIS2 FIXES
// Paste this block at the very BOTTOM of script.js. Nothing else to
// add, no extra <script> tag. Function declarations are hoisted, so
// these versions replace the earlier ones even for calls init() makes.
//
// What it changes:
//   1. Proxy URL updated, and the "Direct" proxy removed. A direct
//      browser call to DHIS2 can never work with Basic auth, it only
//      produced net::ERR_FAILED and about 20 seconds of delay before
//      the real attempt.
//   2. fetchOrgUnits pages at 300 instead of paging=false. One big
//      response was coming back truncated through Apps Script, which
//      read as "Invalid response" and then "All proxies failed".
//   3. setupAggregateDataset confirms the dataset by reading it back
//      instead of guessing, so a create that succeeded is reported as
//      created rather than skipped, and a create that failed reports
//      DHIS2's own reason.
//   4. syncAggregateData referenced orgUnitName, which is not defined
//      in that function. It threw a ReferenceError on the first record
//      and stopped the sync.
//   5. addLog can hide log lines you do not want to see.
//   6. Grouping removed. Aggregate rows are one facility and one period,
//      taken from the Org Unit Column in DHIS2 Configuration. The old
//      saved column list, including adm1, is deleted from storage.
// ================================================================

// ---------- 1. Proxy ----------

CONFIG.PROXY_URL = 'https://script.google.com/macros/s/AKfycbyFerPTDjmYuCuBqfKqvdmfQ-ZozR4_wxwt4ScoPwweNHtWm-HZlyqZPzJs7_9XH7GD/exec';

PROXIES.length = 0;
PROXIES.push({
    name: 'GAS Proxy',
    url: CONFIG.PROXY_URL,
    type: 'gas'
});

// ---------- 5. Log filter ----------
// Add a pattern here to keep a line off the screen, e.g. /all proxies failed/i
const HIDE_LOG_PATTERNS = [];

function addLog(type, message) {
    const log = document.getElementById('syncLog');
    if (!log) return;
    for (const pattern of HIDE_LOG_PATTERNS) {
        if (pattern.test(String(message))) return;
    }
    const time = new Date().toLocaleTimeString();
    log.innerHTML += `<div class="log-entry ${type}">[${time}] ${message}</div>`;
    log.scrollTop = log.scrollHeight;
}

// ---------- 2. Paged org unit fetch ----------

async function fetchOrgUnits() {
    const level = state.dhis2.orgUnitLevel;
    addLog('info', `Fetching org units at level ${level}...`);

    const pageSize = 300;
    const all = [];
    let page = 1;
    let pageCount = 1;

    while (page <= pageCount && page <= 60) {
        let result = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
            result = await dhis2Request(
                `organisationUnits.json?fields=id,name,displayName,code` +
                `&filter=level:eq:${level}&pageSize=${pageSize}&page=${page}&order=name:asc`
            );
            if (result.success && result.data && result.data.organisationUnits) break;
            if (attempt < 3) await sleep(1500);
        }

        if (!result || !result.success || !result.data || !result.data.organisationUnits) {
            const why = (result && result.error) || 'no response';
            if (all.length > 0) {
                addLog('warning', `⚠ Loaded ${all.length} org units, stopped at page ${page}: ${why}`);
                break;
            }
            addLog('warning', `⚠ Could not load org units: ${why}`);
            return;
        }

        all.push(...result.data.organisationUnits);
        const pager = result.data.pager || {};
        pageCount = pager.pageCount || 1;
        page++;
    }

    state.dhis2.orgUnits = all;
    state.dhis2.orgUnitMap = {};

    all.forEach(ou => {
        const names = [
            ou.displayName && ou.displayName.toLowerCase().trim(),
            ou.name && ou.name.toLowerCase().trim(),
            ou.code && ou.code.toLowerCase().trim()
        ].filter(Boolean);
        names.forEach(name => { state.dhis2.orgUnitMap[name] = ou.id; });
    });

    addLog('success', `✓ Loaded ${all.length} org units at level ${level}`);
}

// ---------- 3. Dataset setup that confirms itself ----------

// Pulls the real reason out of a DHIS2 import reply
function dhis2ErrorMessage(result) {
    const d = result && result.data;
    try {
        const reports = (d && d.response && d.response.typeReports) || [];
        for (const tr of reports) {
            for (const or of (tr.objectReports || [])) {
                if (or.errorReports && or.errorReports[0] && or.errorReports[0].message) {
                    return or.errorReports[0].message;
                }
            }
        }
        if (d && d.response && d.response.description) return d.response.description;
        if (d && d.message) return d.message;
    } catch (e) {}
    return (result && result.error) || '';
}

// Exact name, then code, then loose name. Retried, because a lookup that
// simply failed to answer is what used to be reported as skipped.
async function findDataSetByNameOrCode(name, code) {
    const fields = 'fields=id,name,organisationUnits~size,dataSetElements~size';
    const queries = [
        `dataSets.json?filter=name:eq:${encodeURIComponent(name)}&${fields}`,
        `dataSets.json?filter=code:eq:${code}&${fields}`,
        `dataSets.json?filter=name:ilike:${encodeURIComponent(name)}&${fields}`
    ];

    for (let attempt = 1; attempt <= 3; attempt++) {
        for (const q of queries) {
            const res = await dhis2Request(q);
            if (res.success && res.data && res.data.dataSets && res.data.dataSets.length > 0) {
                return res.data.dataSets[0];
            }
        }
        if (attempt < 3) await sleep(2000);
    }
    return null;
}

// Reads the dataset back, attaches anything missing, and says plainly
// when it has no org units, since that is what blocks data entry later.
async function verifyDatasetContents(datasetId, createdElements) {
    const orgUnitCount = state.dhis2.orgUnits.length;

    const full = await dhis2Request(`dataSets/${datasetId}.json?fields=:owner`);
    if (!full.success || !full.data) {
        addLog('warning', '  ⚠ Could not read the dataset back to check its contents');
        return;
    }

    const existing = new Set(
        (full.data.dataSetElements || []).map(dse => dse.dataElement && dse.dataElement.id).filter(Boolean)
    );
    const wanted = createdElements.map(de => de.id);
    const missing = wanted.filter(id => !existing.has(id));

    if (missing.length > 0) {
        const allIds = [...new Set([...existing, ...wanted])];
        const merged = {
            ...full.data,
            dataSetElements: allIds.map(id => ({
                dataSet: { id: datasetId },
                dataElement: { id: id }
            })),
            organisationUnits: state.dhis2.orgUnits.map(ou => ({ id: ou.id }))
        };

        const upd = await dhis2Request(`dataSets/${datasetId}`, 'PUT', merged);
        if (upd.success) {
            addLog('success', `  ✓ Dataset holds ${allIds.length} data element(s), ${orgUnitCount} org unit(s)`);
        } else {
            addLog('warning', `  ⚠ Could not attach ${missing.length} data element(s): ${dhis2ErrorMessage(upd)}`);
        }
    } else {
        addLog('success', `  ✓ Dataset holds ${existing.size} data element(s), ${orgUnitCount} org unit(s)`);
    }

    if (orgUnitCount === 0) {
        addLog('warning', '  ⚠ No org units assigned. DHIS2 will refuse data entry until facilities are added to this dataset.');
    }
}

async function setupAggregateDataset(createdElements) {
    if (state.dhis2.orgUnits.length === 0) {
        await fetchOrgUnits();
    }

    if (createdElements.length === 0) {
        addLog('warning', '⚠ No data elements to add to dataset');
        return;
    }

    const datasetName = state.settings.title;
    const datasetCode = datasetName.toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 30);

    addLog('info', `Setting up Dataset: ${datasetName}...`);

    // Already there?
    const existing = await findDataSetByNameOrCode(datasetName, datasetCode);

    if (existing) {
        state.dhis2.datasetId = existing.id;
        addLog('info', `  ↳ Dataset already exists: ${existing.name}`);
        await verifyDatasetContents(existing.id, createdElements);
        return;
    }

    // Create it
    const createPayload = {
        name: datasetName,
        shortName: datasetName.substring(0, 50),
        code: datasetCode,
        periodType: state.dhis2.periodType,
        dataSetElements: createdElements.map(de => ({ dataElement: { id: de.id } })),
        organisationUnits: state.dhis2.orgUnits.map(ou => ({ id: ou.id }))
    };

    addLog('info', `  Creating dataset with ${createdElements.length} elements...`);

    const createResult = await dhis2Request('dataSets', 'POST', createPayload);

    const newId = (createResult.data && createResult.data.response && createResult.data.response.uid) ||
                  (createResult.data && createResult.data.uid) ||
                  (createResult.data && createResult.data.response && createResult.data.response.typeReports &&
                   createResult.data.response.typeReports[0] &&
                   createResult.data.response.typeReports[0].objectReports &&
                   createResult.data.response.typeReports[0].objectReports[0] &&
                   createResult.data.response.typeReports[0].objectReports[0].uid);

    if (createResult.success && newId) {
        state.dhis2.datasetId = newId;
        addLog('success', `  ✓ Dataset created: ${datasetName}`);
        await verifyDatasetContents(newId, createdElements);
        return;
    }

    // The reply was unusable, or the request timed out. The write may still
    // have landed, so confirm on the server before reporting anything.
    const reason = dhis2ErrorMessage(createResult) || 'the create request gave no usable reply';
    addLog('info', '  Confirming dataset on the server...');

    const found = await findDataSetByNameOrCode(datasetName, datasetCode);

    if (found) {
        state.dhis2.datasetId = found.id;
        addLog('success', `  ✓ Dataset created: ${datasetName} (create reply was unclear: ${reason})`);
        await verifyDatasetContents(found.id, createdElements);
    } else {
        addLog('error', `  ✗ Dataset was not created. DHIS2 said: ${reason}`);
    }
}

// ---------- 4. Aggregate sync, undefined variable fixed ----------

async function syncAggregateData() {
    addLog('info', 'Syncing AGGREGATE data to DHIS2...');
    updateDhis2Status('syncing', 'Syncing...');

    if (!state.dhis2.periodColumn || !state.dhis2.orgUnitColumn) {
        addLog('error', 'Period Column and Org Unit Column must be set in DHIS2 settings');
        notify('Set Period Column and Org Unit Column in DHIS2 settings first', 'error');
        updateDhis2Status('disconnected', 'Config needed');
        return;
    }

    const aggregateData = calculateAggregateData();

    if (aggregateData.length === 0) {
        notify('No data to sync', 'info');
        addLog('info', 'No aggregate data to sync');
        return;
    }

    if (state.dhis2.orgUnits.length === 0) {
        await fetchOrgUnits();
    }

    const periodColumn = state.dhis2.periodColumn;
    const orgUnitColumn = state.dhis2.orgUnitColumn;

    let success = 0, failed = 0;

    for (const record of aggregateData) {
        const period = record._period;
        const groupValue = record._group;

        // Match on the org unit column's own value, never the display label.
        // The label can be a composite of several grouping columns.
        const orgUnitValue = record._orgUnit || '';
        const orgUnitId = state.dhis2.orgUnitMap[orgUnitValue.toLowerCase().trim()];

        if (!orgUnitId) {
            addLog('error', `  ✗ No org unit match: ${orgUnitValue || '(blank)'}`);
            failed++;
            continue;
        }

        const dataValues = [];
        const skipTypes = ['phone', 'gps', 'email', 'text', 'textarea', 'date', 'time'];
        const dataFields = state.fields.filter(f =>
            f.type !== 'section' &&
            f.name !== periodColumn &&
            f.name !== orgUnitColumn &&
            !skipTypes.includes(f.type)
        );

        const categoricalTypes = ['select', 'radio', 'yesno', 'checkbox'];

        dataFields.forEach(field => {
            if (categoricalTypes.includes(field.type)) {
                const options = field.type === 'yesno' ? ['Yes', 'No'] : (field.options || []);
                options.forEach(opt => {
                    const colName = `${field.name}_${opt}`;
                    const deId = state.dhis2.dataElements[colName];
                    const value = record[colName];
                    if (deId && value !== undefined && value !== null) {
                        dataValues.push({
                            dataElement: deId,
                            value: String(value),
                            period: period,
                            orgUnit: orgUnitId
                        });
                    }
                });
            } else if (field.type === 'number') {
                const deId = state.dhis2.dataElements[field.name];
                const value = record[field.name];
                if (deId && value !== undefined && value !== null && value !== '') {
                    dataValues.push({
                        dataElement: deId,
                        value: String(value),
                        period: period,
                        orgUnit: orgUnitId
                    });
                }
            }
        });

        if (dataValues.length === 0) continue;

        const result = await dhis2Request('dataValueSets', 'POST', { dataValues });

        if (result.success) {
            success++;
            addLog('success', `  ✓ Synced: ${groupValue} / ${period}`);
        } else {
            failed++;
            addLog('error', `  ✗ Failed: ${groupValue} / ${period} — ${dhis2ErrorMessage(result)}`);
        }

        await sleep(300);
    }

    updateDhis2Status('connected', 'Sync complete');
    addLog('info', `Sync complete: ${success} success, ${failed} failed`);
    notify(`Synced ${success} records to DHIS2!`);
}

// ================================================================
// 6. GROUPING REMOVED
// ----------------------------------------------------------------
// One aggregate row per facility per period, and the facility comes
// from the Org Unit Column in DHIS2 Configuration, the same field the
// sync matches on. There is no separate column list to fall out of
// step with the form.
//
// adm1 came from that separate list. It survived in saved settings
// after the form changed, matched no field, produced a group called
// Unknown, and the sync then had nothing to look up. The purge below
// deletes that list from the current form, from icfCollectForm and
// from every entry in icfCollectForms, so it cannot come back on the
// next load.
// ================================================================

function purgeGroupingSettings() {
    let touched = false;

    if (state.settings) {
        if (state.settings.aggregateColumn) { state.settings.aggregateColumn = ''; touched = true; }
        if (state.settings.aggregateColumns && state.settings.aggregateColumns.length) {
            state.settings.aggregateColumns = [];
            touched = true;
        }
    }

    // Current form in storage
    try {
        const raw = safeStorage.getItem('icfCollectForm');
        if (raw) {
            const obj = JSON.parse(raw);
            if (obj.settings && (obj.settings.aggregateColumn || (obj.settings.aggregateColumns || []).length)) {
                obj.settings.aggregateColumn = '';
                obj.settings.aggregateColumns = [];
                safeStorage.setItem('icfCollectForm', JSON.stringify(obj));
            }
        }
    } catch (e) {}

    // Every saved form
    try {
        const forms = JSON.parse(safeStorage.getItem('icfCollectForms') || '[]');
        let changed = false;
        forms.forEach(f => {
            if (f.settings && (f.settings.aggregateColumn || (f.settings.aggregateColumns || []).length)) {
                f.settings.aggregateColumn = '';
                f.settings.aggregateColumns = [];
                changed = true;
            }
        });
        if (changed) safeStorage.setItem('icfCollectForms', JSON.stringify(forms));
    } catch (e) {}

    if (touched) {
        try { saveToStorage(); } catch (e) {}
    }
}

// The picker is gone. These stay defined so any leftover onclick in the
// page cannot throw.
window.toggleAggregateColumn = function() { purgeGroupingSettings(); };
window.setAggregateColumn = function() { purgeGroupingSettings(); };

function calculateAggregateData() {
    purgeGroupingSettings();

    const periodColumn = state.dhis2.periodColumn;
    const orgUnitColumn = state.dhis2.orgUnitColumn;

    const data = getFilteredData();
    if (data.length === 0) return [];

    // Without an Org Unit Column there is nothing to aggregate to
    if (!orgUnitColumn) return [];

    const skipFields = [periodColumn, orgUnitColumn].filter(Boolean);
    const skipTypes = ['phone', 'gps', 'email', 'text', 'textarea', 'date', 'time'];

    const grouped = {};

    data.forEach(record => {
        const raw = record[orgUnitColumn];
        const orgUnitValue = raw === null || raw === undefined ? '' : String(raw).trim();

        // No facility value means nowhere to send it. Skipped rather than
        // collected into a row that would fail at sync time.
        if (!orgUnitValue) return;

        let period;
        if (periodColumn && record[periodColumn]) {
            period = record[periodColumn];
        } else {
            const ts = record._timestamp ? new Date(record._timestamp) : new Date();
            period = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}`;
        }

        const key = `${orgUnitValue}|||${period}`;

        if (!grouped[key]) {
            grouped[key] = {
                _group: orgUnitValue,
                _orgUnit: orgUnitValue,
                _period: period,
                _count: 0
            };
        }
        grouped[key]._count++;

        state.fields.forEach(field => {
            if (field.type === 'section') return;
            if (skipFields.includes(field.name)) return;
            if (skipTypes.includes(field.type)) return;

            const value = record[field.name];
            const def = fieldDefs[field.type];

            if (def?.category === 'numeric' || field.type === 'number') {
                grouped[key][field.name] = (grouped[key][field.name] || 0) + (parseFloat(value) || 0);
            } else if ((def?.category === 'categorical' || field.type === 'yesno') && field.type !== 'text') {
                const options = field.type === 'yesno' ? ['Yes', 'No'] : (field.options || []);
                options.forEach(opt => {
                    const colName = `${field.name}_${opt}`;
                    if (grouped[key][colName] === undefined) grouped[key][colName] = 0;
                });
                if (value && options.includes(value)) {
                    const colName = `${field.name}_${value}`;
                    grouped[key][colName] = (grouped[key][colName] || 0) + 1;
                }
            }
        });
    });

    return Object.values(grouped);
}

// ================================================================
// 7. DATA TAB WITHOUT THE GROUP BY PICKER
// ================================================================

function renderDataContent() {
    const container = document.getElementById('dataContent');
    if (!container) return;

    try {
        purgeGroupingSettings();

        const orderedFilterFields = getOrderedFilterFields();
        const filteredData = getFilteredData();
        const aggregateData = calculateAggregateData();

        const orgUnitColumn = state.dhis2.orgUnitColumn;
        const orgUnitField = state.fields.find(f => f.name === orgUnitColumn);

        const activeFilterCount = Object.keys(state.filters).filter(k => state.filters[k]).length +
                                 (state.dateFilter.start || state.dateFilter.end ? 1 : 0);

        let filtersHtml = `
            <div class="filter-group">
                <label class="filter-label"><span class="inline-icon">${getIcon('calendar', 12)}</span> From</label>
                <input type="date" class="filter-input" value="${state.dateFilter.start}" onchange="updateDateFilter('start', this.value)">
            </div>
            <div class="filter-group">
                <label class="filter-label"><span class="inline-icon">${getIcon('calendar', 12)}</span> To</label>
                <input type="date" class="filter-input" value="${state.dateFilter.end}" onchange="updateDateFilter('end', this.value)">
            </div>
        `;

        orderedFilterFields.forEach(field => {
            const uniqueValues = [...new Set(state.collectedData.map(d => d[field.name]).filter(Boolean))];
            filtersHtml += `
                <div class="filter-group with-arrows">
                    <button class="filter-arrow-btn left" onclick="moveFilter('${field.name}','up')" title="Move Left">◀</button>
                    <label class="filter-label">${escapeHtml(field.label)}</label>
                    <select class="filter-select" onchange="updateFilter('${field.name}', this.value)">
                        <option value="">All</option>
                        ${uniqueValues.map(v => `<option value="${escapeHtml(v)}" ${state.filters[field.name] === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                    </select>
                    <button class="filter-arrow-btn right" onclick="moveFilter('${field.name}','down')" title="Move Right">▶</button>
                </div>
            `;
        });

        const noteHtml = `
            <div class="config-section" style="margin-bottom:15px;padding:10px 12px;">
                <div style="display:flex;align-items:center;gap:8px;font-size:11px;">
                    <span class="inline-icon">${getIcon('layers', 14)}</span>
                    ${orgUnitColumn
                        ? `<span>One row per <strong>${escapeHtml(orgUnitField?.label || orgUnitColumn)}</strong> per period. Change the column in DHIS2 Configuration.</span>`
                        : `<span style="color:#856404;">No Org Unit Column set. Choose one in DHIS2 Configuration to see aggregate rows.</span>`}
                </div>
            </div>
        `;

        container.innerHTML = `
            <div class="filter-panel">
                <div class="filter-header">
                    <div class="filter-title"><span class="inline-icon">${getIcon('filter', 14)}</span> Filters ${activeFilterCount > 0 ? `<span class="filter-count">${activeFilterCount} active</span>` : ''}</div>
                    <button class="filter-btn clear" onclick="clearAllFilters()"><span class="inline-icon">${getIcon('trash-2', 12)}</span> Clear</button>
                </div>
                <div class="filter-controls">${filtersHtml}</div>
            </div>

            ${noteHtml}

            <div class="data-view-tabs">
                <div class="data-view-tab ${state.currentDataView === 'case' ? 'active' : ''}" onclick="switchDataView('case')"><span class="inline-icon">${getIcon('list', 14)}</span> Case-Based (${filteredData.length})</div>
                <div class="data-view-tab ${state.currentDataView === 'aggregate' ? 'active aggregate' : ''}" onclick="switchDataView('aggregate')"><span class="inline-icon">${getIcon('bar-chart-3', 14)}</span> Aggregate (${aggregateData.length})</div>
            </div>

            <div id="dataTableContainer">${state.currentDataView === 'case' ? renderCaseTable(filteredData) : renderAggregateTable(aggregateData)}</div>

            <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap;">
                <button class="modal-btn primary" onclick="refreshData()"><span class="inline-icon">${getIcon('refresh-cw', 14)}</span> Refresh</button>
                <button class="modal-btn success" onclick="downloadCSV()"><span class="inline-icon">${getIcon('download', 14)}</span> Download CSV</button>
                ${getOfflineCount() > 0 ? `<button class="modal-btn" style="background:#ffc107;color:#000;" onclick="syncOfflineData()"><span class="inline-icon">${getIcon('upload', 14)}</span> Sync Offline (${getOfflineCount()})</button>` : ''}
                ${state.dhis2.url ? `<button class="modal-btn" style="background:#6f42c1;color:#fff;" onclick="syncCaseBased()"><span class="inline-icon">${getIcon('list', 14)}</span> Sync Case-Based</button>` : ''}
                ${state.dhis2.url ? `<button class="modal-btn" style="background:#17a2b8;color:#fff;" onclick="syncAggregate()"><span class="inline-icon">${getIcon('bar-chart-3', 14)}</span> Sync Aggregate</button>` : ''}
            </div>
        `;
        initIcons();

    } catch (err) {
        console.error('Error in renderDataContent:', err);
        container.innerHTML = `<div style="text-align:center;padding:40px;color:#dc3545;"><p>Error loading data</p><p style="font-size:12px;">${escapeHtml(err.message)}</p></div>`;
    }
}

// Run the purge as soon as this file loads, so adm1 is gone before
// anything reads the settings.
try { purgeGroupingSettings(); } catch (e) {}
