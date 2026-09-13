var equipment  = JSON.parse(localStorage.getItem('equipment')  || '[]');
var equipLogs  = JSON.parse(localStorage.getItem('equipLogs')  || '[]');
var equipDup   = {};
var _eqPendingReturnRef = null;
var _eqQrCurrent = null;

function saveEquipData(){
    eqSyncAllStatuses();
    localStorage.setItem('equipment', JSON.stringify(equipment));
    localStorage.setItem('equipLogs', JSON.stringify(equipLogs));
    try{ if(window.QLogCentral && typeof window.QLogCentral.syncDatasets === 'function'){ window.QLogCentral.syncDatasets(['equipment','equipLogs']); } }catch(e){}
}

/* ---------- Role / visibility detection ---------- */
var EQ_GUARD_RE   = /(^|\b)(guard|guards|guardhouse|guard\s*house|guard\s*post|security|securities|security\s*guard|security\s*office|security\s*officer|security\s*personnel|watchman|watch\s*man|watchmen|sentry|gate\s*keeper|gatekeeper|guard\s*on\s*duty|sg\b)/i;
var EQ_LIBRARY_RE = /(^|\b)(librar(y|ian|ies)|library\s*(office|unit|staff|aide|assistant|clerk)|book\s*keeper\s*of\s*library)/i;

function _eqSessionText(){
    var s = currentSession || {};
    return [s.facility, s.inCharge, s.designation, s.role, s.office, s.department, s.unit, s.assignment, s.position]
        .filter(function(v){ return !!v; }).join(' | ');
}
function isLibraryPersonnel(){
    var s = currentSession || {};
    if (s.role === 'librarian') return true;
    return EQ_LIBRARY_RE.test(_eqSessionText());
}
function isSecurityPersonnel(){
    return EQ_GUARD_RE.test(_eqSessionText());
}
function canAccessEquipmentModule(){
    if (!currentSession || !currentSession.facility) return false;
    if (isLibraryPersonnel()) return false;
    if (isSecurityPersonnel()) return false;
    return true;
}
function applyEquipmentTabVisibility(){
    var btn = document.getElementById('equipBtn');
    if(!btn) return;
    var allowed = canAccessEquipmentModule();
    btn.style.display = allowed ? 'inline-block' : 'none';
    var tabEl = document.getElementById('equipment');
    if(!allowed && tabEl && tabEl.classList.contains('active')){
        showTab('live', document.querySelector('.nav button:nth-child(1)'));
    }
    if(allowed){
        var lbl = document.getElementById('equipUnitLabel');
        if(lbl) lbl.textContent = (currentSession.facility || '--') + ' — ' + (currentSession.inCharge || '') + ' (' + (currentSession.designation || '') + ')';
        refreshEquipmentUI();
    }
}

/* ---------- Helpers ---------- */
function eqEsc(v){
    return String(v === undefined || v === null ? '' : v)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function eqFmt(ms){
    if(!ms) return '--';
    var d = new Date(ms);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function eqDateInputToMs(v){
    if(!v) return 0;
    var t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
}
function eqLocalInputValue(ms){
    var d = new Date(ms);
    var pad = function(n){ return (n<10?'0':'') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function findEquipment(id){
    var m = equipment.filter(function(e){ return String(e.id).toLowerCase() === String(id).trim().toLowerCase(); });
    return m.length ? m[0] : null;
}
function findPerson(id){
    var m = people.filter(function(p){ return String(p.id).toLowerCase() === String(id).trim().toLowerCase(); });
    return m.length ? m[0] : null;
}
function eqActiveLogFor(eqId){
    var m = equipLogs.filter(function(l){ return l.eqId === eqId && (l.s === 'BORROWED' || l.s === 'OVERDUE'); });
    return m.length ? m[m.length-1] : null;
}
function eqQty(item){
    var q = parseInt(item && item.qty, 10);
    return Number.isFinite(q) && q > 0 ? q : 1;
}
function eqBorrowedQty(eqId){
    return equipLogs.reduce(function(sum,l){
        return sum + (sameUnit(l.unit,(findEquipment(eqId)||{}).unit) && l.eqId === eqId && (l.s === 'BORROWED' || l.s === 'OVERDUE') ? Math.max(1,parseInt(l.qty,10)||1) : 0);
    },0);
}
function eqHasOverdue(eqId){
    return equipLogs.some(function(l){return l.eqId === eqId && l.s === 'OVERDUE';});
}
function eqAvailableQty(item){
    if(!item) return 0;
    var q=eqQty(item), borrowed=eqBorrowedQty(item.id);
    if(item.status === 'DAMAGED' || item.status === 'MAINTENANCE') return 0;
    return Math.max(0,q-borrowed);
}
function eqNormalizeItemState(item){
    if(!item) return;
    var hasOverdue = eqHasOverdue(item.id);
    var borrowed = eqBorrowedQty(item.id);
    if(item.condition === 'Damaged' || item.status === 'DAMAGED'){ item.status='DAMAGED'; return; }
    if(item.condition === 'For Maintenance' || item.status === 'MAINTENANCE'){ item.status='MAINTENANCE'; return; }
    item.status = hasOverdue ? 'OVERDUE' : (borrowed > 0 ? 'BORROWED' : 'AVAILABLE');
}
function eqSyncAllStatuses(){
    equipment.forEach(function(item){ eqNormalizeItemState(item); });
}
function sameUnit(a, b){
    return String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase();
}
function eqAudit(action, details){
    try { if (typeof logAudit === 'function') logAudit(action, details); } catch(e){}
}

/* ---------- Overdue engine ---------- */
function checkOverdueEquipment(){
    var now = Date.now(), changed = false;
    equipLogs.forEach(function(l){
        if((l.s === 'BORROWED' || l.s === 'OVERDUE') && l.expectedMs && l.expectedMs < now){
            var days = Math.ceil((now - l.expectedMs) / 86400000);
            if(l.s !== 'OVERDUE' || l.overdueDays !== days){
                l.s = 'OVERDUE'; l.overdueDays = days; changed = true;
                var it = findEquipment(l.eqId);
                if(it && it.status !== 'DAMAGED' && it.status !== 'MAINTENANCE'){ it.status = 'OVERDUE'; }
            }
        }
    });
    eqSyncAllStatuses();
    if(changed){ saveEquipData(); }
    return changed;
}

/* ---------- Registry ---------- */
function openEquipRegistryModal(){
    if(!canAccessEquipmentModule()) return;
    populateDatalist('eqUnitList', configData.facilities);
    var cats = [];
    equipment.forEach(function(e){ if(e.category && cats.indexOf(e.category) === -1) cats.push(e.category); });
    populateDatalist('eqCategoryList', cats);
    var unitField = document.getElementById('eqNewUnit');
    if(unitField && !unitField.value) unitField.value = currentSession.facility || '';
    renderEquipRegistry();
    document.getElementById('equipRegistryModal').style.display = 'flex';
}
function closeEquipRegistryModal(){ document.getElementById('equipRegistryModal').style.display = 'none'; }

async function saveEquipmentItem(){
    var id   = document.getElementById('eqNewId').value.trim();
    var name = document.getElementById('eqNewName').value.trim();
    var cat  = document.getElementById('eqNewCategory').value.trim();
    var unit = document.getElementById('eqNewUnit').value.trim() || (currentSession.facility || '');
    var cond = document.getElementById('eqNewCondition').value;
    var qty  = Math.max(1, parseInt(document.getElementById('eqNewQty').value || '1', 10) || 1);
    if(!id || !name){ toast('⚠️ Equipment ID and Name are required.','red'); return; }
    if(!unit){ toast('⚠️ Assigned unit is required.','red'); return; }

    try {
        if(window.QLogCentral && typeof window.QLogCentral.checkInventoryBatch === 'function'){
            var check = await window.QLogCentral.checkInventoryBatch('equipment',[{
                id:id, name:name, category:cat || 'General', unit:unit, qty:qty, condition:cond || 'Good'
            }]);
            var conflict = check && check.conflicts && check.conflicts.length ? check.conflicts[0] : null;
            if(conflict && conflict.reason === 'ALREADY_ASSIGNED_TO_OTHER_PROFILE'){
                var owner = conflict.existingFacility || 'another office/laboratory';
                var person = conflict.existingInCharge ? ' under ' + conflict.existingInCharge : '';
                toast('⛔ Already registered in ' + owner + person + '. It remains owned by that unit; nothing was added here.','red',5000);
                return;
            }
            if(conflict && conflict.reason === 'DUPLICATE_IN_IMPORT'){
                toast('⛔ This equipment identity is already present in the Central inventory.','red',5000);
                return;
            }
        }
    } catch(e) {
        toast('⚠️ Could not verify equipment ownership with Central. Nothing was added.','red',4500);
        return;
    }

    var ex = findEquipment(id);
    if(ex){
        if(!sameUnit(ex.unit, currentSession.facility)){
            toast('⛔ ' + ex.id + ' is assigned to ' + ex.unit + '. Only that unit can update it.','red'); return;
        }
        var borrowedQty = eqBorrowedQty(ex.id);
        if(qty < borrowedQty){
            toast('⛔ Quantity cannot be reduced below the ' + borrowedQty + ' unit(s) currently borrowed.','red',5000); return;
        }
        ex.name = name; ex.category = cat || ex.category || 'General'; ex.unit = unit; ex.condition = cond; ex.qty = qty;
        if(cond === 'Damaged') ex.status='DAMAGED'; else if(cond === 'For Maintenance') ex.status='MAINTENANCE'; else eqNormalizeItemState(ex);
        toast('✅ Equipment updated: ' + ex.id + ' • Qty ' + qty, 'green');
        eqAudit('EQUIPMENT_UPDATE', ex.id + ' - ' + name + ' @ ' + unit + ' | qty=' + qty);
    } else {
        equipment.push({
            id: id, name: name, category: cat || 'General', unit: unit, condition: cond,
            qty: qty, status: 'AVAILABLE', addedAt: Date.now(), addedBy: currentSession.inCharge || '', remarks: ''
        });
        toast('✅ Equipment registered: ' + id + ' • Qty ' + qty, 'green');
        eqAudit('EQUIPMENT_ADD', id + ' - ' + name + ' @ ' + unit + ' | qty=' + qty);
    }
    saveEquipData();
    document.getElementById('eqNewId').value = '';
    document.getElementById('eqNewName').value = '';
    document.getElementById('eqNewCategory').value = '';
    document.getElementById('eqNewQty').value = '1';
    refreshEquipmentUI();
}
function editEquipmentItem(id){
    var it = findEquipment(id); if(!it) return;
    document.getElementById('eqNewId').value = it.id;
    document.getElementById('eqNewName').value = it.name;
    document.getElementById('eqNewCategory').value = it.category || '';
    document.getElementById('eqNewUnit').value = it.unit || '';
    document.getElementById('eqNewCondition').value = it.condition || 'Good';
    document.getElementById('eqNewQty').value = eqQty(it);
    toast('✏️ Loaded ' + it.id + ' for editing.','yellow');
}
function deleteEquipmentItem(id){
    var it = findEquipment(id); if(!it) return;
    if(!sameUnit(it.unit, currentSession.facility)){ toast('⛔ Only ' + it.unit + ' can delete this item.','red'); return; }
    if(eqActiveLogFor(it.id)){ toast('⛔ Cannot delete — the item is currently borrowed.','red'); return; }
    if(!confirm('Delete equipment ' + it.id + ' (' + it.name + ')? Transaction history is retained.')) return;
    equipment = equipment.filter(function(e){ return e.id !== it.id; });
    saveEquipData(); refreshEquipmentUI();
    eqAudit('EQUIPMENT_DELETE', it.id);
    toast('🗑 Equipment removed.','green');
}
function setEquipmentStatus(id, status){
    var it = findEquipment(id); if(!it) return;
    if(!sameUnit(it.unit, currentSession.facility)){ toast('⛔ Only ' + it.unit + ' can change this item.','red'); return; }
    if(eqActiveLogFor(it.id)){ toast('⛔ Item is currently borrowed. Record the return first.','red'); return; }
    it.status = status;
    if(status === 'AVAILABLE' && (it.condition === 'Damaged' || it.condition === 'For Maintenance')) it.condition = 'Good';
    if(status === 'DAMAGED') it.condition = 'Damaged';
    if(status === 'MAINTENANCE') it.condition = 'For Maintenance';
    saveEquipData(); refreshEquipmentUI();
    eqAudit('EQUIPMENT_STATUS', it.id + ' -> ' + status);
    toast('✅ ' + it.id + ' marked ' + status + '.','green');
}

function eqStatusBadge(status){
    var colors = { AVAILABLE:'#16a34a', BORROWED:'#d97706', OVERDUE:'#dc2626', RETURNED:'#16a34a', DAMAGED:'#b91c1c', MAINTENANCE:'#475569' };
    var c = colors[status] || '#475569';
    return '<span style="font-weight:700;color:' + c + ';">' + eqEsc(status) + '</span>';
}

var editingEquipmentId = null;

function renderEquipRegistry(){
    var q = (document.getElementById('eqRegistrySearch') || {}).value || '';
    var st = (document.getElementById('eqRegistryStatus') || {}).value || 'ALL';
    var onlyMine = document.getElementById('eqRegistryOnlyMine') ? document.getElementById('eqRegistryOnlyMine').checked : true;
    q = q.trim().toLowerCase();
    var list = equipment.slice().filter(function(e){
        if(onlyMine && !sameUnit(e.unit, currentSession.facility)) return false;
        if(st !== 'ALL' && e.status !== st) return false;
        if(q){
            var hay = [e.id, e.name, e.category, e.unit, e.condition].join(' ').toLowerCase();
            if(hay.indexOf(q) === -1) return false;
        }
        return true;
    });
    list.sort(function(a,b){ return String(a.name).localeCompare(String(b.name)); });
    var html = '';
    list.forEach(function(e){
        var act = eqActiveLogFor(e.id);
        var qty = eqQty(e), availableQty = eqAvailableQty(e);
        var mine = sameUnit(e.unit, currentSession.facility);
        var editing = editingEquipmentId === e.id && mine;
        var actions = '';

        if(editing){
            actions =
                '<button style="background:#16a34a;padding:4px 8px;font-size:12px;" onclick="saveEquipmentInline(\'' + eqEsc(e.id) + '\')">Save</button> ' +
                '<button style="background:#64748b;padding:4px 8px;font-size:12px;" onclick="cancelEquipmentInline()">Cancel</button>';
        }else if(mine){
            actions += '<button style="background:#3b82f6;padding:4px 8px;font-size:12px;" onclick="editEquipmentItem(\'' + eqEsc(e.id) + '\')">Edit</button> ';
            if(!act){
                if(e.status !== 'AVAILABLE') actions += '<button style="background:#16a34a;padding:4px 8px;font-size:12px;" onclick="setEquipmentStatus(\'' + eqEsc(e.id) + '\',\'AVAILABLE\')">Available</button> ';
                if(e.status !== 'MAINTENANCE') actions += '<button style="background:#475569;padding:4px 8px;font-size:12px;" onclick="setEquipmentStatus(\'' + eqEsc(e.id) + '\',\'MAINTENANCE\')">Maintenance</button> ';
                if(e.status !== 'DAMAGED') actions += '<button style="background:#b91c1c;padding:4px 8px;font-size:12px;" onclick="setEquipmentStatus(\'' + eqEsc(e.id) + '\',\'DAMAGED\')">Damaged</button> ';
                actions += '<button style="background:#dc2626;padding:4px 8px;font-size:12px;" onclick="deleteEquipmentItem(\'' + eqEsc(e.id) + '\')">Delete</button>';
            }
        } else {
            actions = '<span style="font-size:12px;color:#94a3b8;">Other unit</span>';
        }

        var rowClass = editing ? ' style="background:#ecfeff;"' : '';
        var nameCell = editing
            ? '<input id="eqInlineName-' + eqEsc(e.id) + '" value="' + eqEsc(e.name) + '" style="width:180px;padding:5px;border:1px solid #94a3b8;border-radius:7px;">'
            : eqEsc(e.name);
        var catCell = editing
            ? '<input id="eqInlineCat-' + eqEsc(e.id) + '" value="' + eqEsc(e.category||'') + '" style="width:130px;padding:5px;border:1px solid #94a3b8;border-radius:7px;">'
            : eqEsc(e.category||'');
        var qtyCell = editing
            ? '<input id="eqInlineQty-' + eqEsc(e.id) + '" type="number" min="1" value="' + qty + '" style="width:72px;padding:5px;border:1px solid #94a3b8;border-radius:7px;">'
            : qty;
        var unitCell = editing
            ? '<span style="font-weight:700;">' + eqEsc(e.unit) + '</span>'
            : eqEsc(e.unit);
        var conditionCell = editing
            ? '<select id="eqInlineCond-' + eqEsc(e.id) + '" style="padding:5px;border:1px solid #94a3b8;border-radius:7px;"><option>Good</option><option>Damaged</option><option>For Maintenance</option></select>'
            : eqEsc(e.condition||'');

        html += '<tr' + rowClass + '><td>' + eqEsc(e.id) + '</td><td>' + nameCell + '</td><td>' + catCell + '</td><td>' + qtyCell + '</td><td>' + availableQty + '</td><td>' + unitCell + '</td><td>' + conditionCell + '</td><td>' + eqStatusBadge(e.status) + '</td><td>' + (act ? eqEsc(act.borrowerName) + '<br><span style="font-size:11px;color:#64748b;">' + eqEsc(act.borrowerId) + '</span>' : '--') + '</td>' +
            '<td><button style="background:#0f172a;padding:4px 8px;font-size:12px;" onclick="showEquipmentQr(\'' + eqEsc(e.id) + '\')">QR</button> ' +
            '<button style="background:#7c3aed;padding:4px 8px;font-size:12px;" onclick="openEquipmentHistory(\'' + eqEsc(e.id) + '\')">History</button></td>' +
            '<td>' + actions + '</td></tr>';
    });
    document.getElementById('eqRegistryTbl').innerHTML = html || '<tr><td colspan="11">No equipment registered yet. Add items using the form above.</td></tr>';

    // Apply the current condition selection to any inline editor.
    if(editingEquipmentId){
        var editItem = findEquipment(editingEquipmentId);
        var sel = document.getElementById('eqInlineCond-' + editingEquipmentId);
        if(sel && editItem) sel.value = editItem.condition || 'Good';
    }
}

function editEquipmentItem(id){
    var it = findEquipment(id);
    if(!it) return;
    if(!sameUnit(it.unit, currentSession.facility)){
        toast('⛔ Only ' + it.unit + ' can edit this equipment.','red',3500);
        return;
    }
    editingEquipmentId = id;
    renderEquipRegistry();
    var rowInput = document.getElementById('eqInlineName-' + id);
    if(rowInput){ rowInput.focus(); try{ rowInput.select(); }catch(e){} }
}

function cancelEquipmentInline(){
    editingEquipmentId = null;
    renderEquipRegistry();
}

async function saveEquipmentInline(id){
    var it = findEquipment(id);
    if(!it) return;
    if(!sameUnit(it.unit, currentSession.facility)){
        toast('⛔ Only ' + it.unit + ' can edit this equipment.','red',3500);
        return;
    }

    var nameEl = document.getElementById('eqInlineName-' + id);
    var catEl = document.getElementById('eqInlineCat-' + id);
    var qtyEl = document.getElementById('eqInlineQty-' + id);
    var condEl = document.getElementById('eqInlineCond-' + id);

    var name = nameEl ? nameEl.value.trim() : it.name;
    var category = catEl ? catEl.value.trim() : it.category;
    var qty = Math.max(1, parseInt(qtyEl ? qtyEl.value : eqQty(it), 10) || 1);
    var condition = condEl ? condEl.value : (it.condition || 'Good');

    if(!name){
        toast('⚠️ Equipment name is required.','red',3500);
        return;
    }

    var borrowedQty = eqBorrowedQty(it.id);
    if(qty < borrowedQty){
        toast('⛔ Quantity cannot be lower than the ' + borrowedQty + ' unit(s) currently borrowed.','red',4500);
        return;
    }

    try{
        if(window.QLogCentral && typeof window.QLogCentral.checkInventoryBatch === 'function'){
            var check = await window.QLogCentral.checkInventoryBatch('equipment',[{
                id:it.id,
                name:name,
                category:category || 'General',
                unit:it.unit,
                qty:qty,
                condition:condition
            }]);
            var conflict = check && check.conflicts && check.conflicts.length ? check.conflicts[0] : null;
            if(conflict && conflict.reason === 'ALREADY_ASSIGNED_TO_OTHER_PROFILE'){
                var owner = conflict.existingFacility || 'another office/laboratory';
                var person = conflict.existingInCharge ? ' under ' + conflict.existingInCharge : '';
                toast('⛔ Already registered in ' + owner + person + '.','red',5000);
                return;
            }
        }

        it.name = name;
        it.category = category || it.category || 'General';
        it.condition = condition;
        it.qty = qty;
        if(condition === 'Damaged'){ it.status = 'DAMAGED'; }
        else if(condition === 'For Maintenance'){ it.status = 'MAINTENANCE'; }
        else { eqNormalizeItemState(it); }

        saveEquipData();
        editingEquipmentId = null;
        refreshEquipmentUI();
        eqAudit('EQUIPMENT_UPDATE_INLINE', it.id + ' - ' + it.name + ' @ ' + it.unit + ' | qty=' + qty + ' | condition=' + condition);
        toast('✅ Equipment updated: ' + it.id + ' • Qty ' + qty + ' • Central sync queued.','green',3200);
    }catch(e){
        toast('⛔ Equipment update was not saved — Central verification failed.','red',4500);
    }
}

function exportEquipRegistry(){
    if(equipment.length === 0){ alert('No equipment registered yet.'); return; }
    if(typeof XLSX === 'undefined') return;
    var rows = equipment.map(function(e){
        return { ID:e.id, Name:e.name, Category:e.category||'', Qty:eqQty(e), AvailableQty:eqAvailableQty(e), AssignedUnit:e.unit, Condition:e.condition||'', Status:e.status, RegisteredBy:e.addedBy||'', RegisteredOn:eqFmt(e.addedAt) };
    });
    var ws = XLSX.utils.json_to_sheet(rows);
    if(typeof addSignatureToExcel === 'function') addSignatureToExcel(ws);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Equipment Registry');
    XLSX.writeFile(wb, 'Equipment_Registry.xlsx');
}

/* ---------- Registry template + bulk import ---------- */
var EQ_IMPORT_STATUSES = ['AVAILABLE','MAINTENANCE','DAMAGED'];

/* Template columns match the registry fields and the bulk importer below. */
function downloadEquipmentTemplate(){
    if(typeof XLSX === 'undefined'){ alert('Local Excel library not loaded.'); return; }
    var rows = [
        {
            ID: 'SCI-MICRO-001',
            Name: 'Compound Microscope',
            Category: 'Laboratory Apparatus',
            Qty: 1,
            AssignedUnit: (currentSession && currentSession.facility) ? currentSession.facility : 'Science Laboratory',
            Condition: 'Good',
            Status: 'AVAILABLE',
            Remarks: 'Sample row - replace with real equipment'
        }
    ];
    var ws = XLSX.utils.json_to_sheet(rows, { header: ['ID','Name','Qty','Category','AssignedUnit','Condition','Status','Remarks'] });
    ws['!cols'] = [{wch:18},{wch:32},{wch:24},{wch:26},{wch:18},{wch:14},{wch:40}];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Equipment Registry');
    XLSX.writeFile(wb, 'QLOG_Equipment_Registry_Template.xlsx');
    eqAudit('TEMPLATE_DOWNLOAD', 'Equipment Registry import template downloaded');
    toast('⬇ Equipment Registry template downloaded (sample row included).','green');
}

function _eqPick(row, keys){
    for(var k in row){
        if(!Object.prototype.hasOwnProperty.call(row, k)) continue;
        var norm = String(k).replace(/[^a-z]/gi,'').toLowerCase();
        if(keys.indexOf(norm) !== -1){
            var v = row[k];
            if(v === undefined || v === null) return '';
            return String(v).trim();
        }
    }
    return '';
}

/* Bulk import. Existing Equipment IDs are UPDATED in place (never duplicated)
   and only when the current unit is authorized to touch them; active
   borrowing status and history are always preserved. */
async function importEquipmentExcel(){
    if(!canAccessEquipmentModule()){ toast('⛔ Not authorized for the Equipment module.','red'); return; }
    var fileInput = document.getElementById('eqImportFile');
    var resEl = document.getElementById('eqImportResult');
    if(!fileInput || !fileInput.files || !fileInput.files.length){
        if(resEl){ resEl.style.color = '#dc2626'; resEl.textContent = 'Choose an .xlsx file first.'; }
        return;
    }
    if(typeof XLSX === 'undefined'){ alert('Local Excel library not loaded.'); return; }
    var f = fileInput.files[0];
    var r = new FileReader();
    r.onload = async function(ev){
        var added = 0, updated = 0, skipped = 0, invalid = 0, crossOffice = 0;
        var problems = [];
        var candidates = [];
        try {
            var wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
            var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
            rows.forEach(function(row, idx){
                var id     = _eqPick(row, ['id','equipmentid','eqid','qrcode','code']);
                var name   = _eqPick(row, ['name','equipmentname','itemname','description']);
                var cat    = _eqPick(row, ['category','type']);
                var unit   = _eqPick(row, ['assignedunit','unit','office','facility','department']);
                var cond   = _eqPick(row, ['condition','itemcondition']);
                var status = _eqPick(row, ['status','state']).toUpperCase();
                var qtyRaw = _eqPick(row, ['qty','quantity','copies','copycount','stock','count']);
                var qty = Math.max(1, parseInt(qtyRaw || '1', 10) || 1);
                var remarks= _eqPick(row, ['remarks','notes','note']);

                if(!id || !name){
                    invalid++;
                    problems.push('Row ' + (idx + 2) + ': Equipment ID and Equipment Name are both required.');
                    return;
                }
                if(!unit) unit = currentSession.facility || '';
                if(!unit){
                    invalid++;
                    problems.push('Row ' + (idx + 2) + ' (' + id + '): no assigned unit available.');
                    return;
                }
                if(EQ_IMPORT_STATUSES.indexOf(status) === -1) status = '';

                candidates.push({
                    rowIndex:idx,
                    id:id,
                    name:name,
                    category:cat || 'General',
                    unit:unit,
                    condition:cond || 'Good',
                    status:status,
                    qty:qty,
                    remarks:remarks || ''
                });
            });

            if(window.QLogCentral && typeof window.QLogCentral.checkInventoryBatch === 'function' && candidates.length){
                var check = await window.QLogCentral.checkInventoryBatch('equipment', candidates);
                var conflictsByIndex = {};
                (check.conflicts || []).forEach(function(c){ conflictsByIndex[c.index] = c; });

                candidates = candidates.filter(function(item, idx){
                    var c = conflictsByIndex[idx];
                    if(!c) return true;
                    skipped++;
                    if(c.reason === 'ALREADY_ASSIGNED_TO_OTHER_PROFILE'){
                        crossOffice++;
                        var owner = c.existingFacility || 'another office/laboratory';
                        var person = c.existingInCharge ? ' under ' + c.existingInCharge : '';
                        problems.push(item.id + ': already added in ' + owner + person + '.');
                    } else if(c.reason === 'DUPLICATE_IN_IMPORT'){
                        problems.push(item.id + ': duplicate in this import.');
                    } else {
                        problems.push(item.id + ': duplicate inventory record.');
                    }
                    return false;
                });
            }

            candidates.forEach(function(item){
                var id=item.id, name=item.name, cat=item.category, unit=item.unit, cond=item.condition, status=item.status, qty=item.qty, remarks=item.remarks;
                var ex = findEquipment(id);
                if(ex){
                    if(!sameUnit(ex.unit, currentSession.facility)){
                        skipped++;
                        crossOffice++;
                        problems.push(id + ': assigned to ' + ex.unit + ' - only that unit may update it.');
                        return;
                    }
                    var act = eqActiveLogFor(ex.id);
                    ex.name      = name;
                    ex.category  = cat || ex.category || 'General';
                    ex.unit      = unit;
                    ex.condition = cond || ex.condition || 'Good';
                    var borrowedQty = eqBorrowedQty(ex.id);
                    if(qty < borrowedQty){
                        skipped++;
                        problems.push(id + ': cannot reduce qty below currently borrowed quantity (' + borrowedQty + ').');
                        return;
                    }
                    ex.qty = qty;
                    eqNormalizeItemState(ex);
                    if(remarks) ex.remarks = remarks;
                    if(!act && status) ex.status = status;
                    updated++;
                } else {
                    equipment.push({
                        id: id,
                        name: name,
                        category: cat || 'General',
                        unit: unit,
                        qty: qty,
                        condition: cond || 'Good',
                        status: status || 'AVAILABLE',
                        addedAt: Date.now(),
                        addedBy: currentSession.inCharge || '',
                        remarks: remarks || ''
                    });
                    added++;
                }
            });
        } catch(err){
            if(resEl){ resEl.style.color = '#dc2626'; resEl.textContent = 'Could not read or verify the file: ' + (err && err.message ? err.message : 'invalid workbook'); }
            toast('⛔ Equipment import failed — Central verification was not completed.','red',5000);
            return;
        }
        saveEquipData();
        refreshEquipmentUI();
        if(window.QLogCentral && typeof window.QLogCentral.syncDatasets === 'function'){ window.QLogCentral.syncDatasets(['equipment','equipLogs']); }
        eqAudit('EQUIPMENT_BULK_IMPORT', 'Added: ' + added + ', Updated: ' + updated + ', Skipped: ' + skipped + ', Cross-office blocked: ' + crossOffice + ', Invalid: ' + invalid + ' (file: ' + f.name + ')');
        if(resEl){
            resEl.style.color = (invalid || skipped) ? '#b45309' : '#16a34a';
            resEl.innerHTML = '✅ Added: <b>' + added + '</b> &nbsp; ♻ Updated: <b>' + updated + '</b> &nbsp; ⏭ Skipped: <b>' + skipped + '</b> &nbsp; ⚠ Invalid: <b>' + invalid + '</b>' +
                (problems.length ? '<div style="margin-top:6px;font-weight:400;color:#64748b;font-size:12px;">' + problems.slice(0,12).map(eqEsc).join('<br>') + (problems.length > 12 ? '<br>… and ' + (problems.length - 12) + ' more' : '') + '</div>' : '');
        }
        if(crossOffice > 0){
            toast('⛔ ' + crossOffice + ' equipment item(s) already added in another office/laboratory. Nothing was added for those items.','red',5500);
        }else if(skipped > 0){
            toast('⚠️ Equipment import completed with ' + skipped + ' duplicate/skipped item(s).','yellow',4500);
        }else{
            toast('📥 Equipment import complete — ' + added + ' added, ' + updated + ' updated.','green');
        }
        fileInput.value = '';
    };
    r.readAsArrayBuffer(f);
}

/* Bulk QR export: one standalone, fully offline, printable HTML sheet with a
   QR per equipment item. QR images are embedded as data URLs generated by the
   bundled local QR library, so the file needs no CDN and no internet. */
async function exportAllEquipmentQrHTML(){
    if(!canAccessEquipmentModule()){ toast('⛔ Not authorized for the Equipment module.','red'); return; }
    if(typeof QRCode === 'undefined'){ alert('Local QR library not loaded.'); return; }
    // Honours the registry's current visibility rules (unit + status + search).
    var q = ((document.getElementById('eqRegistrySearch') || {}).value || '').trim().toLowerCase();
    var st = (document.getElementById('eqRegistryStatus') || {}).value || 'ALL';
    var onlyMine = document.getElementById('eqRegistryOnlyMine') ? document.getElementById('eqRegistryOnlyMine').checked : true;
    var list = equipment.slice().filter(function(e){
        if(onlyMine && !sameUnit(e.unit, currentSession.facility)) return false;
        if(st !== 'ALL' && e.status !== st) return false;
        if(q){
            var hay = [e.id, e.name, e.category, e.unit, e.condition].join(' ').toLowerCase();
            if(hay.indexOf(q) === -1) return false;
        }
        return true;
    });
    if(!list.length){ alert('No equipment matches the current registry view.'); return; }
    list.sort(function(a,b){ return String(a.name).localeCompare(String(b.name)); });

    toast('⏳ Generating ' + list.length + ' QR codes…','blue');
    var cards = '';
    for(var i = 0; i < list.length; i++){
        var e = list[i];
        var url = await _qrDataURL(e.id, 240);       // encodes the REAL equipment ID
        cards += '<div class="qcard">' +
            (url ? '<img class="qimg" alt="QR ' + eqEsc(e.id) + '" src="' + url + '">' : '<div class="qimg missing">QR unavailable</div>') +
            '<div class="qname">' + eqEsc(e.name) + '</div>' +
            '<div class="qid">' + eqEsc(e.id) + '</div>' +
            '<div class="qmeta">' + eqEsc(e.category || 'General') + '</div>' +
            '<div class="qmeta">' + eqEsc(e.unit || '') + '</div>' +
        '</div>';
    }
    var title = 'Equipment QR Labels — ' + (onlyMine ? (currentSession.facility || 'Current Unit') : 'All Units');
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>' + eqEsc(title) + '</title><style>' +
        'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:18px;background:#fff;color:#0f172a}' +
        'h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 16px;font-size:12px;color:#64748b}' +
        '.grid{display:flex;flex-wrap:wrap;gap:10px}' +
        '.qcard{width:200px;border:1px solid #0f172a;border-radius:6px;padding:10px;text-align:center;box-sizing:border-box;page-break-inside:avoid;break-inside:avoid}' +
        '.qimg{width:150px;height:150px;display:block;margin:0 auto 8px}' +
        '.qimg.missing{display:flex;align-items:center;justify-content:center;font-size:11px;color:#dc2626;border:1px dashed #dc2626}' +
        '.qname{font-size:14px;font-weight:700;line-height:1.25;word-break:break-word;margin-bottom:4px}' +
        '.qid{font-family:monospace;font-size:12px;font-weight:700;color:#1e293b}' +
        '.qmeta{font-size:11px;color:#64748b}' +
        '@media print{body{padding:8px}.noprint{display:none}}' +
        '</style></head><body>' +
        '<h1>' + eqEsc(title) + '</h1>' +
        '<p class="sub">' + list.length + ' item(s) — generated ' + eqEsc(new Date().toLocaleString()) + '. Works offline; cut along the borders to label each item.</p>' +
        '<button class="noprint" onclick="window.print()" style="margin-bottom:14px;padding:8px 14px;cursor:pointer;">🖨 Print</button>' +
        '<div class="grid">' + cards + '</div></body></html>';

    var blob = new Blob([html], { type: 'text/html' });
    var url2 = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url2; a.download = 'QLOG_Equipment_QR_Codes.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url2); }, 1000);
    eqAudit('EQUIPMENT_QR_BULK_EXPORT', list.length + ' equipment QR labels exported');
    toast('🔳 Exported ' + list.length + ' equipment QR labels.','green');
}
/* ---------- QR ---------- */
async function showEquipmentQr(id){
    var it = findEquipment(id); if(!it) return;
    _eqQrCurrent = it;
    var box = document.getElementById('eqQrBox');
    box.innerHTML = '<span style="color:#64748b;">Generating…</span>';
    document.getElementById('eqQrCaption').textContent = it.id + ' — ' + it.name;
    document.getElementById('equipQrModal').style.display = 'flex';
    var url = await _qrDataURL(it.id, 220);
    box.innerHTML = url ? '<img alt="Equipment QR" src="' + url + '" style="width:220px;height:220px;">' : '<span style="color:#dc2626;">QR library unavailable.</span>';
}
async function printEquipmentQr(){
    if(!_eqQrCurrent) return;
    var url = await _qrDataURL(_eqQrCurrent.id, 300);
    var w = window.open('','','width=600,height=700');
    w.document.write('<html><head><title>Equipment QR</title></head><body style="font-family:Arial;text-align:center;padding:40px;">' +
        '<h2>' + eqEsc(_eqQrCurrent.name) + '</h2><img src="' + url + '" style="width:300px;height:300px;"><h3>' + eqEsc(_eqQrCurrent.id) + '</h3><p>' + eqEsc(_eqQrCurrent.unit) + '</p></body></html>');
    w.document.close(); w.focus();
    setTimeout(function(){ w.print(); w.close(); }, 400);
}

/* ---------- Scanner (reuses jsQR + USB keyboard wedge pattern) ---------- */
var currentEquipScanMode = 'USB';
var equipCameraAnimationId = null;

function setEquipScanMode(mode){
    currentEquipScanMode = mode;
    var statusTxt = document.getElementById('equipScannerStatusText');
    var btnUsb = document.getElementById('btnEquipUsbMode');
    var btnCam = document.getElementById('btnEquipCamMode');
    var cameraArea = document.getElementById('equipCameraArea');
    var cameraSelect = document.getElementById('equipCameraSelect');
    if(mode === 'USB'){
        btnUsb.classList.add('active-mode'); btnCam.classList.remove('active-mode');
        cameraArea.style.display = 'none'; cameraSelect.style.display = 'none';
        statusTxt.innerHTML = '🟢 Scanner Mode: <b>USB Keyboard</b> (Focus locked)';
        stopEquipCameraScanner();
        var hs = document.getElementById('equipHiddenScanner'); if(hs) hs.focus();
    } else {
        btnCam.classList.add('active-mode'); btnUsb.classList.remove('active-mode');
        cameraArea.style.display = 'block';
        statusTxt.innerHTML = '📷 Scanner Mode: <b>Camera Scanner</b> Active';
        initEquipCameraScanner();
    }
}
function initEquipCameraScanner(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }).then(function(tmp){
        tmp.getTracks().forEach(function(t){ t.stop(); });
        return navigator.mediaDevices.enumerateDevices();
    }).then(function(devices){
        var vids = devices.filter(function(d){ return d.kind === 'videoinput'; });
        var sel = document.getElementById('equipCameraSelect');
        sel.innerHTML = '';
        if(vids.length > 0){
            sel.style.display = 'inline-block';
            var frontIndex = 0;
            vids.forEach(function(d, i){
                var o = document.createElement('option');
                o.value = d.deviceId; o.text = d.label || ('Camera ' + (i+1));
                if(/front|user/i.test(d.label)){ frontIndex = i; o.selected = true; }
                sel.appendChild(o);
            });
            startEquipCameraStream(vids[frontIndex].deviceId);
        } else { sel.style.display = 'none'; startEquipCameraStream(); }
    }).catch(function(){ startEquipCameraStream(); });
}
function switchEquipCameraDevice(){ startEquipCameraStream(document.getElementById('equipCameraSelect').value); }
function startEquipCameraStream(deviceId){
    stopCameraScanner(); stopBorrowCameraScanner(); stopEquipCameraScanner();
    var constraints = { video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' } };
    navigator.mediaDevices.getUserMedia(constraints).then(function(stream){
        activeCameraStream = stream;
        var video = document.getElementById('equipLiveCamera');
        video.srcObject = stream; video.setAttribute('playsinline','true'); video.play();
        var raf = window.requestAnimationFrame || function(cb){ return setTimeout(cb, 1000/60); };
        equipCameraAnimationId = raf(scanEquipCameraFrame);
    }).catch(function(){});
}
function stopEquipCameraScanner(){
    if(equipCameraAnimationId){
        var caf = window.cancelAnimationFrame || clearTimeout;
        caf(equipCameraAnimationId); equipCameraAnimationId = null;
    }
    if(activeCameraStream && currentEquipScanMode === 'CAMERA'){
        try { activeCameraStream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
        activeCameraStream = null;
    }
}
function scanEquipCameraFrame(){
    var video = document.getElementById('equipLiveCamera');
    var canvas = document.getElementById('equipCameraCanvas');
    if(video && video.readyState === video.HAVE_ENOUGH_DATA){
        canvas.height = video.videoHeight; canvas.width = video.videoWidth;
        var ctx = canvas.getContext('2d');
        ctx.setTransform(1,0,0,1,0,0);
        ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.setTransform(1,0,0,1,0,0);
        var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if(typeof jsQR !== 'undefined'){
            var code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
            if(code && code.data){
                try{
                    var actx = new (window.AudioContext || window.webkitAudioContext)();
                    var osc = actx.createOscillator(); var gain = actx.createGain();
                    osc.connect(gain); gain.connect(actx.destination);
                    osc.type = 'sine'; osc.frequency.value = 880;
                    gain.gain.setValueAtTime(0.1, actx.currentTime);
                    osc.start(); osc.stop(actx.currentTime + 0.1);
                }catch(e){}
                processEquipScan(code.data.trim());
            }
        }
    }
    if(currentEquipScanMode === 'CAMERA'){
        var raf = window.requestAnimationFrame || function(cb){ return setTimeout(cb, 1000/60); };
        equipCameraAnimationId = raf(scanEquipCameraFrame);
    }
}

/* Scan routing: borrower first (must be a registered client), then equipment. */
function processEquipScan(code){
    if(!code) return;
    if(!canAccessEquipmentModule()) return;
    var now = Date.now();
    if(equipDup[code] && now - equipDup[code] < 2500) return;
    equipDup[code] = now;

    var eqItem = findEquipment(code);
    var person = findPerson(code);

    if(eqItem && !person){ applyEquipmentScan(eqItem); }
    else if(person && !eqItem){ applyBorrowerScan(person); }
    else if(person && eqItem){
        if(document.getElementById('eqBorrowerScan').value.trim() === '') applyBorrowerScan(person);
        else applyEquipmentScan(eqItem);
    } else {
        document.getElementById('eqBorrowMsg').style.color = '#dc2626';
        document.getElementById('eqBorrowMsg').textContent = '⛔ Unrecognized QR "' + code + '". Unregistered borrowers and unregistered equipment are not allowed.';
        toast('⛔ Not registered in the database: ' + code, 'red');
    }
    if(currentEquipScanMode === 'USB'){
        var hs = document.getElementById('equipHiddenScanner'); if(hs) hs.focus();
    }
}

function applyBorrowerScan(person){
    document.getElementById('eqBorrowerScan').value = person.id;
    var extra = [person.category, person.grade, person.section].filter(function(v){ return !!v; }).join(' • ');
    document.getElementById('eqBorrowerInfo').innerHTML = '✅ <b>' + eqEsc(person.name) + '</b>' + (extra ? ' — ' + eqEsc(extra) : '');
    document.getElementById('eqBorrowMsg').textContent = '';
    toast('👤 Borrower verified: ' + person.name, 'green');
}
function applyEquipmentScan(item){
    document.getElementById('eqItemScan').value = item.id;
    var sel = document.getElementById('eqItemSelect');
    if(sel) sel.value = item.id;
    var msg = '';
    if(!sameUnit(item.unit, currentSession.facility)){
        msg = '⛔ <b>' + eqEsc(item.name) + '</b> is assigned to <b>' + eqEsc(item.unit) + '</b> — not to your unit.';
        toast('⛔ Equipment belongs to ' + item.unit, 'red');
    } else if(eqAvailableQty(item) <= 0 || item.status === 'DAMAGED' || item.status === 'MAINTENANCE'){
        var unavailableState = (item.status === 'DAMAGED' || item.status === 'MAINTENANCE') ? item.status : '0 AVAILABLE';
        msg = '⚠️ <b>' + eqEsc(item.name) + '</b> is currently <b>' + eqEsc(unavailableState) + '</b> and cannot be borrowed.';
        toast('⚠️ Equipment is unavailable', 'yellow');
    } else {
        msg = '✅ <b>' + eqEsc(item.name) + '</b> — ' + eqEsc(item.category||'') + ' • ' + eqEsc(item.unit) + ' • Available: <b>' + eqAvailableQty(item) + '</b> / ' + eqQty(item) + ' • Condition: ' + eqEsc(item.condition||'Good');
        toast('🧰 Equipment verified: ' + item.name, 'green');
    }
    document.getElementById('eqItemInfo').innerHTML = msg;
}
function selectEquipmentFromList(){
    var v = document.getElementById('eqItemSelect').value;
    if(!v){ document.getElementById('eqItemScan').value = ''; document.getElementById('eqItemInfo').textContent = 'No equipment selected yet.'; return; }
    var it = findEquipment(v); if(it) applyEquipmentScan(it);
}
function clearEquipStaging(){
    document.getElementById('eqBorrowerScan').value = '';
    document.getElementById('eqItemScan').value = '';
    document.getElementById('eqItemSelect').value = '';
    document.getElementById('eqBorrowerInfo').textContent = 'No borrower scanned yet.';
    document.getElementById('eqItemInfo').textContent = 'No equipment selected yet.';
    document.getElementById('eqPurpose').value = '';
    if(document.getElementById('eqBorrowQty')) document.getElementById('eqBorrowQty').value = '1';
    document.getElementById('eqBorrowMsg').textContent = '';
    equipDup = {};
}

/* ---------- Borrow ---------- */
function recordEquipmentBorrow(){
    var msgEl = document.getElementById('eqBorrowMsg');
    var fail = function(t){ msgEl.style.color = '#dc2626'; msgEl.textContent = t; toast(t, 'red'); };
    if(!canAccessEquipmentModule()){ fail('⛔ Your unit is not authorized to use Equipment Borrowing.'); return; }

    var bid = document.getElementById('eqBorrowerScan').value.trim();
    var eid = document.getElementById('eqItemScan').value.trim() || document.getElementById('eqItemSelect').value;
    var requestedQty = Math.max(1, parseInt((document.getElementById('eqBorrowQty')||{}).value || '1', 10) || 1);
    if(!bid){ fail('⛔ Scan the borrower QR first. Unregistered borrowers are not allowed.'); return; }
    var person = findPerson(bid);
    if(!person){ fail('⛔ Borrower is not registered in the client database.'); return; }
    if(!eid){ fail('⛔ Scan or select the equipment to be borrowed.'); return; }
    var item = findEquipment(eid);
    if(!item){ fail('⛔ Equipment is not registered in the equipment registry.'); return; }
    if(!sameUnit(item.unit, currentSession.facility)){ fail('⛔ ' + item.id + ' is assigned to ' + item.unit + '. Your unit cannot release it.'); return; }
    var availableQty = eqAvailableQty(item);
    if(availableQty < requestedQty){ fail('⛔ Only ' + availableQty + ' unit(s) are available for ' + item.id + '.'); return; }
    if(item.status === 'DAMAGED' || item.status === 'MAINTENANCE'){ fail('⛔ ' + item.id + ' is currently ' + item.status + ' and is not available for borrowing.'); return; }

    var expVal = document.getElementById('eqExpectedReturn').value;
    var expMs = eqDateInputToMs(expVal);
    if(!expMs){ fail('⛔ Set the expected return date and time.'); return; }
    var nowMs = Date.now();
    if(expMs <= nowMs){ fail('⛔ Expected return must be later than the current date and time.'); return; }

    var ref = 'EQ-' + nowMs.toString(36).toUpperCase();
    equipLogs.push({
        ref: ref,
        eqId: item.id, eqName: item.name, eqCategory: item.category || '', unit: item.unit,
        qty: requestedQty,
        borrowerId: person.id, borrowerName: person.name,
        borrowerCategory: person.category || '', borrowerGrade: person.grade || '', borrowerSection: person.section || '',
        s: 'BORROWED',
        borrowedMs: nowMs, borrowedAt: eqFmt(nowMs),
        expectedMs: expMs, expectedAt: eqFmt(expMs),
        returnedMs: 0, returnedAt: '',
        conditionOut: document.getElementById('eqConditionOut').value,
        conditionIn: '',
        overdueDays: 0,
        remarks: document.getElementById('eqPurpose').value.trim(),
        releasedBy: currentSession.inCharge || '',
        releasedByDesignation: currentSession.designation || '',
        receivedBy: ''
    });
    eqNormalizeItemState(item);
    saveEquipData();
    eqAudit('EQUIPMENT_BORROW', ref + ' | ' + item.id + ' x' + requestedQty + ' -> ' + person.name);
    clearEquipStaging();
    msgEl.style.color = '#16a34a';
    msgEl.textContent = '✅ ' + requestedQty + ' unit(s) of ' + item.name + ' released to ' + person.name + '. Expected return: ' + eqFmt(expMs) + ' (Ref ' + ref + ')';
    toast('✅ Equipment borrowing recorded • Qty ' + requestedQty, 'green');
    refreshEquipmentUI();
}
/* ---------- Return ---------- */
function openEquipReturnModal(ref){
    var log = equipLogs.filter(function(l){ return l.ref === ref; })[0];
    if(!log) return;
    _eqPendingReturnRef = ref;
    document.getElementById('eqReturnSummary').innerHTML =
        '<b>' + eqEsc(log.eqName) + '</b> (' + eqEsc(log.eqId) + ') • Qty: <b>' + (log.qty || 1) + '</b><br>' +
        'Borrower: ' + eqEsc(log.borrowerName) + ' (' + eqEsc(log.borrowerId) + ')<br>' +
        'Borrowed: ' + eqEsc(log.borrowedAt) + '<br>' +
        'Expected: ' + eqEsc(log.expectedAt) + (log.s === 'OVERDUE' ? ' <span style="color:#dc2626;font-weight:700;">(OVERDUE ' + log.overdueDays + ' day/s)</span>' : '');
    document.getElementById('eqReturnWhen').value = eqLocalInputValue(Date.now());
    document.getElementById('eqReturnCondition').value = 'Good';
    document.getElementById('eqReturnRemarks').value = '';
    document.getElementById('equipReturnModal').style.display = 'flex';
}
function closeEquipReturnModal(){
    document.getElementById('equipReturnModal').style.display = 'none';
    _eqPendingReturnRef = null;
}
function submitEquipmentReturn(){
    var log = equipLogs.filter(function(l){ return l.ref === _eqPendingReturnRef; })[0];
    if(!log){ closeEquipReturnModal(); return; }
    if(log.s === 'RETURNED' || log.s === 'DAMAGED' || log.s === 'MAINTENANCE'){ toast('⚠️ This transaction is already closed.','yellow'); closeEquipReturnModal(); return; }
    var whenMs = eqDateInputToMs(document.getElementById('eqReturnWhen').value) || Date.now();
    if(whenMs + 60000 < log.borrowedMs){ toast('⛔ Return time cannot be earlier than the borrow time.','red'); return; }
    var cond = document.getElementById('eqReturnCondition').value;
    var remarks = document.getElementById('eqReturnRemarks').value.trim();

    log.returnedMs = whenMs;
    log.returnedAt = eqFmt(whenMs);
    log.conditionIn = cond;
    log.receivedBy = currentSession.inCharge || '';
    if(remarks) log.remarks = (log.remarks ? log.remarks + ' | ' : '') + remarks;
    log.overdueDays = (log.expectedMs && whenMs > log.expectedMs) ? Math.ceil((whenMs - log.expectedMs) / 86400000) : 0;
    log.s = (cond === 'Damaged') ? 'DAMAGED' : (cond === 'For Maintenance' ? 'MAINTENANCE' : 'RETURNED');

    var item = findEquipment(log.eqId);
    if(item){
        item.condition = (cond === 'Damaged') ? 'Damaged' : (cond === 'For Maintenance' ? 'For Maintenance' : cond);
        if(cond === 'Damaged') item.status = 'DAMAGED';
        else if(cond === 'For Maintenance') item.status = 'MAINTENANCE';
        else eqNormalizeItemState(item);
    }
    saveEquipData();
    eqAudit('EQUIPMENT_RETURN', log.ref + ' | ' + log.eqId + ' | ' + log.s);
    closeEquipReturnModal();
    refreshEquipmentUI();
    toast('✅ Return recorded: ' + log.eqName + ' (' + log.s + ')', 'green');
}

/* ---------- Rendering ---------- */
function renderEquipDashboard(){
    var mine = equipment.filter(function(e){ return sameUnit(e.unit, currentSession.facility); });
    var total = 0, avail = 0, borrowed = 0, overdue = 0, out = 0;
    mine.forEach(function(e){
        var q = eqQty(e), b = eqBorrowedQty(e.id), a = eqAvailableQty(e);
        total += q; avail += a; borrowed += b;
        if(e.status === 'OVERDUE') overdue += b;
        else if(e.status === 'DAMAGED' || e.status === 'MAINTENANCE') out += q;
    });
    document.getElementById('eqDashTotal').textContent = total;
    document.getElementById('eqDashAvailable').textContent = avail;
    document.getElementById('eqDashBorrowed').textContent = borrowed;
    document.getElementById('eqDashOverdue').textContent = overdue;
    document.getElementById('eqDashOut').textContent = out;
}
function renderEquipSelect(){
    var sel = document.getElementById('eqItemSelect');
    if(!sel) return;
    var cur = sel.value;
    var html = '<option value="">-- Select available equipment --</option>';
    equipment.filter(function(e){ return sameUnit(e.unit, currentSession.facility) && eqAvailableQty(e) > 0; })
        .sort(function(a,b){ return String(a.name).localeCompare(String(b.name)); })
        .forEach(function(e){ html += '<option value="' + eqEsc(e.id) + '">' + eqEsc(e.name) + ' (' + eqEsc(e.id) + ') • ' + eqAvailableQty(e) + '/' + eqQty(e) + ' available</option>'; });
    sel.innerHTML = html;
    if(cur && findEquipment(cur)) sel.value = cur;
}
function renderEquipActive(){
    var rows = equipLogs.filter(function(l){
        return (l.s === 'BORROWED' || l.s === 'OVERDUE') && sameUnit(l.unit, currentSession.facility);
    }).sort(function(a,b){ return a.expectedMs - b.expectedMs; });
    var html = '';
    rows.forEach(function(l){
        html += '<tr><td>' + eqEsc(l.ref) + '</td><td>' + eqEsc(l.eqName) + '</td><td>' + eqEsc(l.eqId) + '</td><td>' + (l.qty || 1) + '</td><td>' + eqEsc(l.borrowerName) + '</td><td>' + eqEsc(l.borrowerId) + '</td><td>' + eqEsc(l.unit) + '</td><td>' + eqEsc(l.borrowedAt) + '</td><td>' + eqEsc(l.expectedAt) + '</td><td>' + eqStatusBadge(l.s) + '</td><td>' + (l.overdueDays || 0) + '</td>' +
            '<td><button style="background:#16a34a;padding:5px 10px;font-size:12px;" onclick="openEquipReturnModal(\'' + eqEsc(l.ref) + '\')">Return</button> ' +
            '<button style="background:#7c3aed;padding:5px 10px;font-size:12px;" onclick="openEquipmentHistory(\'' + eqEsc(l.eqId) + '\')">History</button></td></tr>';
    });
    document.getElementById('eqActiveTbl').innerHTML = html || '<tr><td colspan="12">No active equipment borrowings.</td></tr>';
}
function eqFilteredLogs(){
    var st = (document.getElementById('eqFilterStatus') || {}).value || 'ALL';
    var q = ((document.getElementById('eqFilterSearch') || {}).value || '').trim().toLowerCase();
    var d = (document.getElementById('eqFilterDate') || {}).value || '';
    return equipLogs.filter(function(l){
        if(!sameUnit(l.unit, currentSession.facility)) return false;
        if(st !== 'ALL' && l.s !== st) return false;
        if(q){
            var hay = [l.ref, l.eqId, l.eqName, l.eqCategory, l.unit, l.borrowerId, l.borrowerName, l.remarks].join(' ').toLowerCase();
            if(hay.indexOf(q) === -1) return false;
        }
        if(d){
            var target = new Date(d).toLocaleDateString();
            var b = l.borrowedMs ? new Date(l.borrowedMs).toLocaleDateString() : '';
            var r = l.returnedMs ? new Date(l.returnedMs).toLocaleDateString() : '';
            if(b !== target && r !== target) return false;
        }
        return true;
    }).slice().reverse();
}
function renderEquipLogs(){
    var rows = eqFilteredLogs();
    var html = '';
    rows.forEach(function(l){
        html += '<tr><td>' + eqEsc(l.ref) + '</td><td>' + eqEsc(l.eqName) + '</td><td>' + eqEsc(l.eqId) + '</td><td>' + (l.qty || 1) + '</td><td>' + eqEsc(l.unit) + '</td><td>' + eqEsc(l.borrowerName) + '</td><td>' + eqEsc(l.borrowerId) + '</td><td>' + eqStatusBadge(l.s) + '</td><td>' + eqEsc(l.borrowedAt) + '</td><td>' + eqEsc(l.expectedAt) + '</td><td>' + eqEsc(l.returnedAt || '--') + '</td><td>' + (l.overdueDays || 0) + '</td><td>' + eqEsc(l.conditionOut || '') + '</td><td>' + eqEsc(l.conditionIn || '--') + '</td><td>' + eqEsc(l.remarks || '') + '</td><td>' + eqEsc(l.releasedBy || '') + '</td></tr>';
    });
    document.getElementById('eqLogsTbl').innerHTML = html || '<tr><td colspan="16">No equipment transactions found for the current filters.</td></tr>';
}
function clearEquipFilters(){
    document.getElementById('eqFilterStatus').value = 'ALL';
    document.getElementById('eqFilterSearch').value = '';
    document.getElementById('eqFilterDate').value = '';
    renderEquipLogs();
}
function refreshEquipmentUI(){
    if(!currentSession || !currentSession.facility) return;
    if(!document.getElementById('equipment')) return;
    checkOverdueEquipment();
    renderEquipDashboard();
    renderEquipSelect();
    renderEquipActive();
    renderEquipLogs();
    if(document.getElementById('equipRegistryModal').style.display === 'flex') renderEquipRegistry();
}

/* ---------- Histories ---------- */
function _renderEqHistoryRows(rows){
    var html = '';
    rows.slice().reverse().forEach(function(l){
        html += '<tr><td>' + eqEsc(l.ref) + '</td><td>' + eqEsc(l.eqName) + ' (' + eqEsc(l.eqId) + ')</td><td>' + eqEsc(l.borrowerName) + '</td><td>' + eqStatusBadge(l.s) + '</td><td>' + eqEsc(l.borrowedAt) + '</td><td>' + eqEsc(l.expectedAt) + '</td><td>' + eqEsc(l.returnedAt || '--') + '</td><td>' + eqEsc(l.conditionIn || '--') + '</td><td>' + eqEsc(l.remarks || '') + '</td></tr>';
    });
    document.getElementById('eqHistoryTbl').innerHTML = html || '<tr><td colspan="9">No records found.</td></tr>';
}
function _eqHistorySummary(rows){
    var b = 0, r = 0, o = 0, d = 0;
    rows.forEach(function(l){
        if(l.s === 'BORROWED') b++;
        else if(l.s === 'OVERDUE'){ b++; o++; }
        else if(l.s === 'RETURNED') r++;
        else d++;
    });
    document.getElementById('eqHistorySummary').innerHTML =
        '<div class="card" style="flex:1;padding:12px;margin:0;text-align:center;min-width:90px;"><b>Total</b><br><span style="font-size:22px;">' + rows.length + '</span></div>' +
        '<div class="card" style="flex:1;padding:12px;margin:0;text-align:center;color:#d97706;min-width:90px;"><b>Active</b><br><span style="font-size:22px;">' + b + '</span></div>' +
        '<div class="card" style="flex:1;padding:12px;margin:0;text-align:center;color:#dc2626;min-width:90px;"><b>Overdue</b><br><span style="font-size:22px;">' + o + '</span></div>' +
        '<div class="card" style="flex:1;padding:12px;margin:0;text-align:center;color:#16a34a;min-width:90px;"><b>Returned</b><br><span style="font-size:22px;">' + r + '</span></div>' +
        '<div class="card" style="flex:1;padding:12px;margin:0;text-align:center;color:#475569;min-width:90px;"><b>Damaged/Maint.</b><br><span style="font-size:22px;">' + d + '</span></div>';
}
function openEquipmentHistory(eqId){
    var it = findEquipment(eqId);
    document.getElementById('eqHistoryTitle').textContent = '📜 Equipment History — ' + (it ? it.name + ' (' + it.id + ')' : eqId);
    document.getElementById('eqHistorySearchRow').style.display = 'none';
    var rows = equipLogs.filter(function(l){ return l.eqId === eqId; });
    _eqHistorySummary(rows);
    _renderEqHistoryRows(rows);
    document.getElementById('equipHistoryModal').style.display = 'flex';
}
function openEquipBorrowerProfile(){
    document.getElementById('eqHistoryTitle').textContent = '👤 Borrower Equipment History';
    document.getElementById('eqHistorySearchRow').style.display = 'flex';
    document.getElementById('eqHistoryQuery').value = document.getElementById('eqBorrowerScan').value || '';
    document.getElementById('eqHistorySummary').innerHTML = '';
    document.getElementById('eqHistoryTbl').innerHTML = '<tr><td colspan="9">Enter a borrower ID and press Search.</td></tr>';
    document.getElementById('equipHistoryModal').style.display = 'flex';
    if(document.getElementById('eqHistoryQuery').value) loadEquipBorrowerHistory();
}
function loadEquipBorrowerHistory(){
    var id = document.getElementById('eqHistoryQuery').value.trim();
    if(!id){ toast('⚠️ Enter a borrower ID.','yellow'); return; }
    var person = findPerson(id);
    if(!person){ toast('⛔ Borrower is not registered.','red'); document.getElementById('eqHistoryTbl').innerHTML = '<tr><td colspan="9">Unregistered borrower.</td></tr>'; document.getElementById('eqHistorySummary').innerHTML = ''; return; }
    var rows = equipLogs.filter(function(l){ return String(l.borrowerId).toLowerCase() === id.toLowerCase(); });
    document.getElementById('eqHistoryTitle').textContent = '👤 Equipment History — ' + person.name + ' (' + person.id + ')';
    _eqHistorySummary(rows);
    _renderEqHistoryRows(rows);
}
function closeEquipHistoryModal(){ document.getElementById('equipHistoryModal').style.display = 'none'; }

/* ---------- Reports ---------- */
function exportEquipLogs(){
    var rows = eqFilteredLogs();
    if(rows.length === 0){ alert('No equipment transactions to export for the current filters.'); return; }
    if(typeof XLSX === 'undefined') return;
    var out = rows.map(function(l){
        return {
            Ref:l.ref, Equipment:l.eqName, EquipmentID:l.eqId, Category:l.eqCategory||'', AssignedUnit:l.unit,
            BorrowerID:l.borrowerId, BorrowerName:l.borrowerName, BorrowerCategory:l.borrowerCategory||'',
            Status:l.s, Borrowed:l.borrowedAt, ExpectedReturn:l.expectedAt, ActualReturn:l.returnedAt||'',
            OverdueDays:l.overdueDays||0, ConditionOut:l.conditionOut||'', ConditionIn:l.conditionIn||'',
            Remarks:l.remarks||'', ReleasedBy:l.releasedBy||'', ReceivedBy:l.receivedBy||''
        };
    });
    var ws = XLSX.utils.json_to_sheet(out);
    if(typeof addSignatureToExcel === 'function') addSignatureToExcel(ws);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Equipment Logs');
    XLSX.writeFile(wb, 'Equipment_Borrowing_Logs.xlsx');
}
function printEquipLogs(){
    var rows = eqFilteredLogs();
    if(rows.length === 0){ alert('No equipment transactions to print for the current filters.'); return; }
    var sigHtml = (typeof getSignatureBlock === 'function') ? getSignatureBlock() : '';
    var w = window.open('','','width=1200,height=800');
    var html = '<html><head><title>Equipment Borrowing Report</title><style>body{font-family:"Segoe UI",Arial,sans-serif;padding:25px;} h2,h4{text-align:center;margin:4px;color:#5b21b6;} table{width:100%;border-collapse:collapse;margin-top:20px;} th,td{border:1px solid #cbd5e1;padding:8px;text-align:center;font-size:12px;} th{background:#f1f5f9;color:#0f172a;}</style></head><body>';
    html += '<h2>🧰 Equipment Borrowing &amp; Returns Report</h2>';
    html += '<h4>' + eqEsc(currentSession.facility || '') + ' — In-Charge: ' + eqEsc(currentSession.inCharge || '') + '</h4>';
    html += '<table><thead><tr><th>Ref</th><th>Equipment</th><th>ID</th><th>Borrower</th><th>Borrower ID</th><th>Status</th><th>Borrowed</th><th>Expected</th><th>Returned</th><th>Overdue Days</th><th>Condition In</th><th>Remarks</th></tr></thead><tbody>';
    rows.forEach(function(l){
        html += '<tr><td>' + eqEsc(l.ref) + '</td><td>' + eqEsc(l.eqName) + '</td><td>' + eqEsc(l.eqId) + '</td><td>' + eqEsc(l.borrowerName) + '</td><td>' + eqEsc(l.borrowerId) + '</td><td>' + eqEsc(l.s) + '</td><td>' + eqEsc(l.borrowedAt) + '</td><td>' + eqEsc(l.expectedAt) + '</td><td>' + eqEsc(l.returnedAt||'--') + '</td><td>' + (l.overdueDays||0) + '</td><td>' + eqEsc(l.conditionIn||'--') + '</td><td>' + eqEsc(l.remarks||'') + '</td></tr>';
    });
    html += '</tbody></table>' + sigHtml + '</body></html>';
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(function(){ w.print(); w.close(); }, 300);
}

/* ---------- Wiring into the existing app lifecycle ---------- */
(function(){
    var hs = document.getElementById('equipHiddenScanner');
    var t;
    if(hs){
        hs.addEventListener('input', function(){
            clearTimeout(t);
            t = setTimeout(function(){ processEquipScan(hs.value.trim()); hs.value = ''; }, 80);
        });
    }

    var _origFinalize = window.finalizeStartup;
    window.finalizeStartup = function(isLibrarian){
        _origFinalize.apply(this, arguments);
        applyEquipmentTabVisibility();
    };

    var _origShowTab = window.showTab;
    window.showTab = function(id, btn){
        if(id === 'equipment' && !canAccessEquipmentModule()){
            toast('⛔ Equipment Borrowing is not available for your unit.','red');
            return;
        }
        _origShowTab.apply(this, arguments);
        if(id === 'equipment'){
            refreshEquipmentUI();
            if(!document.getElementById('eqExpectedReturn').value){
                document.getElementById('eqExpectedReturn').value = eqLocalInputValue(Date.now() + 86400000);
            }
            if(currentEquipScanMode === 'CAMERA') initEquipCameraScanner();
            else {
                var el = document.getElementById('equipHiddenScanner');
                if(el) setTimeout(function(){ el.focus(); }, 100);
            }
        } else {
            stopEquipCameraScanner();
        }
    };


    
window.addEventListener('load', function(){
        setTimeout(function(){
            applyEquipmentTabVisibility();
            checkOverdueEquipment();
        }, 300);
        setInterval(function(){
            if(checkOverdueEquipment() && canAccessEquipmentModule()) refreshEquipmentUI();
        }, 60000);
    });
})();
