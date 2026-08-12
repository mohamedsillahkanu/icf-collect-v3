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
        const orgUnitId = state.dhis2.orgUnitMap[groupValue && groupValue.toLowerCase().trim()];

        if (!orgUnitId) {
            addLog('error', `  ✗ No org unit match: ${groupValue}`);
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
