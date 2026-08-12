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
    const aggregateColumn = state.settings.aggregateColumn || orgUnitColumn;

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
            f.name !== aggregateColumn &&
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
// 6. GROUPING, DRIVEN BY THE CURRENT FORM
// ----------------------------------------------------------------
// You can still group by one or more columns. What changes:
//
//   - The saved selection is checked against the form every time it is
//     read. A column that no longer exists in the form is dropped. That
//     is what adm1 was: a name left over from an older version of the
//     form, still ticked, matching nothing, so every record grouped as
//     "Unknown".
//   - Nothing is grouped as Unknown any more. A blank value shows as
//     (blank) in the table.
//   - Each aggregate row now carries _orgUnit, the raw value of the
//     Org Unit Column, alongside _group, the display label. The sync
//     matches on _orgUnit, so you can group by whatever you like
//     without the sync losing track of the facility.
//   - The Org Unit Column is always part of the grouping key, so one
//     row can never span two facilities.
// ================================================================

// Columns a form field can be grouped by
function getGroupableFields() {
    return state.fields.filter(f =>
        f.type !== 'section' &&
        ['select', 'radio', 'yesno', 'text'].includes(f.type)
    );
}

// Returns the saved grouping columns, minus any that the form no longer has
function getGroupingColumns() {
    if (!state.settings) return [];

    let cols = state.settings.aggregateColumns;
    if (!Array.isArray(cols)) {
        cols = state.settings.aggregateColumn ? [state.settings.aggregateColumn] : [];
    }

    const valid = new Set(getGroupableFields().map(f => f.name));
    const pruned = cols.filter(c => valid.has(c));

    // Write the pruned list back so a stale name cannot survive a reload
    if (pruned.length !== cols.length) {
        state.settings.aggregateColumns = pruned;
        state.settings.aggregateColumn = pruned[0] || '';
        try { saveToStorage(); } catch (e) {}
    }

    return pruned;
}

window.toggleAggregateColumn = function(columnName) {
    if (!state.settings) return;
    if (!Array.isArray(state.settings.aggregateColumns)) state.settings.aggregateColumns = [];

    const cols = state.settings.aggregateColumns;
    const i = cols.indexOf(columnName);
    if (i >= 0) cols.splice(i, 1);
    else cols.push(columnName);

    state.settings.aggregateColumn = cols[0] || '';
    saveToStorage();
    renderDataContent();
    renderDashboard();
};

window.setAggregateColumn = function(columnName) {
    if (!state.settings) return;
    state.settings.aggregateColumns = columnName ? [columnName] : [];
    state.settings.aggregateColumn = columnName || '';
    saveToStorage();
    renderDataContent();
    renderDashboard();
};

function calculateAggregateData() {
    const periodColumn = state.dhis2.periodColumn;
    const orgUnitColumn = state.dhis2.orgUnitColumn;
    const groupColumns = getGroupingColumns();

    const data = getFilteredData();
    if (data.length === 0) return [];

    // Key columns: whatever is selected, plus the org unit column so a row
    // never covers more than one facility
    const keyColumns = [...groupColumns];
    if (orgUnitColumn && !keyColumns.includes(orgUnitColumn)) keyColumns.push(orgUnitColumn);
    if (keyColumns.length === 0) return [];

    const skipFields = [periodColumn, ...keyColumns].filter(Boolean);
    const skipTypes = ['phone', 'gps', 'email', 'text', 'textarea', 'date', 'time'];

    const cell = v => (v === null || v === undefined ? '' : String(v).trim());
    const grouped = {};

    data.forEach(record => {
        let period;
        if (periodColumn && record[periodColumn]) {
            period = record[periodColumn];
        } else {
            const ts = record._timestamp ? new Date(record._timestamp) : new Date();
            period = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}`;
        }

        const orgUnitValue = orgUnitColumn ? cell(record[orgUnitColumn]) : '';

        // Display label from the selected columns, or the facility if none selected
        const labelColumns = groupColumns.length > 0 ? groupColumns : (orgUnitColumn ? [orgUnitColumn] : []);
        const groupValue = labelColumns
            .map(col => cell(record[col]) || '(blank)')
            .join(' | ');

        const key = keyColumns.map(col => cell(record[col])).join('|||') + '|||' + period;

        if (!grouped[key]) {
            grouped[key] = {
                _group: groupValue,
                _orgUnit: orgUnitValue,
                _period: period,
                _count: 0
            };
            keyColumns.forEach(col => {
                grouped[key]['_grp_' + col] = cell(record[col]);
            });
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
// 7. DATA TAB — GROUP BY PICKER BUILT FROM THE CURRENT FORM
// ================================================================

function renderDataContent() {
    const container = document.getElementById('dataContent');
    if (!container) return;

    try {
        const orderedFilterFields = getOrderedFilterFields();
        const filteredData = getFilteredData();
        const aggregateData = calculateAggregateData();
        const groupColumns = getGroupingColumns();
        const groupableFields = getGroupableFields();

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

        const groupingHtml = `
            <div class="config-section" style="margin-bottom:15px;padding:12px;">
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span class="inline-icon">${getIcon('layers', 14)}</span>
                        <strong style="font-size:11px;">Group by (fields in this form):</strong>
                    </div>
                    ${groupableFields.length === 0 ? `
                        <span style="font-size:10px;color:#868e96;">No groupable fields in this form yet.</span>
                    ` : `
                        <div style="display:flex;flex-wrap:wrap;gap:8px;max-width:600px;">
                            ${groupableFields.map(f => {
                                const on = groupColumns.includes(f.name);
                                return `
                                    <label style="display:flex;align-items:center;gap:4px;padding:4px 8px;background:${on ? '#004080' : '#f1f3f5'};color:${on ? '#fff' : '#333'};border-radius:4px;cursor:pointer;font-size:11px;">
                                        <input type="checkbox" value="${f.name}" ${on ? 'checked' : ''} onchange="toggleAggregateColumn('${f.name}')" style="margin:0;">
                                        ${escapeHtml(f.label)}
                                    </label>
                                `;
                            }).join('')}
                        </div>
                    `}
                    <div style="font-size:10px;">
                        ${groupColumns.length > 0
                            ? `<span style="color:#28a745;"><span class="inline-icon">${getIcon('check-circle', 12)}</span> Grouping by: ${groupColumns.map(c => {
                                   const f = groupableFields.find(x => x.name === c);
                                   return escapeHtml(f ? f.label : c);
                               }).join(' + ')} and period</span>`
                            : (orgUnitColumn
                                ? `<span style="color:#868e96;">Nothing selected, grouping by ${escapeHtml(orgUnitField?.label || orgUnitColumn)} and period</span>`
                                : `<span style="color:#856404;">Nothing selected and no Org Unit Column set, so there is nothing to group on</span>`)}
                    </div>
                    ${orgUnitColumn ? `
                        <div style="font-size:10px;color:#868e96;">
                            Sync matches facilities on <strong>${escapeHtml(orgUnitField?.label || orgUnitColumn)}</strong>, set in DHIS2 Configuration.
                        </div>
                    ` : ''}
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

            ${groupingHtml}

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
