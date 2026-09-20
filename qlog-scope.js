/* =====================================================================
   QLog Pro — Facility Scope & Capability Layer v1.0
   Keeps normal users inside the current assigned facility across
   navigation, search, reports and newly-created operational records.
   Fixed identity: QLog Pro
   ===================================================================== */
(function(global){
'use strict';

function text(v){ return String(v == null ? '' : v).trim(); }
function unitKey(v){
  return text(v).toUpperCase().replace(/&/g,' AND ').replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}
function session(){ return global.currentSession || {}; }
function currentUnit(){ return text(session().facility); }
function currentKey(){ return unitKey(currentUnit()); }
function isLibrary(){ return session().role === 'librarian'; }
function isLibraryUnit(){ return /LIBRAR/.test(unitKey(currentUnit())); }
function isSecurity(){ return /(SECURITY|GUARD|GATE)/.test(unitKey(currentUnit())); }
function isSuperScope(){ return session().role === 'superadmin' || session().scope === 'ALL_UNITS'; }

function capabilities(){
  if(isSuperScope()) return {attendance:true,visitors:true,clients:true,library:true,equipment:true,reports:true,allUnits:true};
  if(isLibrary()) return {attendance:true,visitors:true,clients:true,library:true,equipment:false,reports:true,allUnits:false};
  if(isSecurity()) return {attendance:true,visitors:true,clients:true,library:false,equipment:false,reports:true,allUnits:false};
  if(isLibraryUnit()) return {attendance:true,visitors:true,clients:true,library:false,equipment:false,reports:true,allUnits:false};
  return {attendance:true,visitors:true,clients:true,library:false,equipment:true,reports:true,allUnits:false};
}

function reportTypes(){
  var c=capabilities();
  if(c.allUnits) return ['ATTENDANCE','VISITOR','CLIENT','LIBRARY_INVENTORY','LIBRARY_BORROW','LIBRARY_RESERVATION','LIBRARY_AUDIT','EQUIPMENT_INVENTORY','EQUIPMENT_BORROW'];
  var out=['ATTENDANCE','VISITOR'];
  if(c.library) out.push('LIBRARY_INVENTORY','LIBRARY_BORROW','LIBRARY_RESERVATION','LIBRARY_AUDIT');
  if(c.equipment) out.push('EQUIPMENT_INVENTORY','EQUIPMENT_BORROW');
  return out;
}

function recordUnit(record,type){
  record=record||{};
  if(record.facilityId) return unitKey(record.facilityId);
  var raw=record._facilityId || record._facility || record.facilityName || record.facility || record.assignedUnit || record.unit || '';
  if(raw) return unitKey(raw);
  if(/^LIBRARY_/.test(type||'')) return 'SCHOOL_LIBRARY';
  return '';
}
function recordBelongs(record,type){
  if(isSuperScope()) return true;
  var rk=recordUnit(record,type), ck=currentKey();
  if(!ck) return false;
  if(!rk) return false; // legacy/unassigned remains isolated until deliberately migrated
  if(/^LIBRARY_/.test(type||'') && isLibrary() && rk==='SCHOOL_LIBRARY') return true;
  return rk===ck;
}
function scopeReportRows(type,rows){
  rows=Array.isArray(rows)?rows:[];
  if(isSuperScope()) return rows;
  if(reportTypes().indexOf(type)<0) return [];
  return rows.filter(function(r){ return recordBelongs(r,type); });
}
function stampCurrent(record,forcedUnit){
  record=record||{};
  var u=text(forcedUnit || currentUnit());
  record.facilityName=u;
  record.facilityId=unitKey(u);
  return record;
}
function scopedRecords(records,type){ return (records||[]).filter(function(r){return recordBelongs(r,type);}); }
function legacyCounts(){
  var out={attendance:0,visitors:0,audit:0,total:0};
  (global.logs||[]).forEach(function(r){
    if(recordUnit(r,String(r.category||'').toUpperCase()==='VISITOR'?'VISITOR':'ATTENDANCE')) return;
    if(String(r.category||'').toUpperCase()==='VISITOR') out.visitors++; else out.attendance++;
  });
  (global.auditLogs||[]).forEach(function(r){if(!recordUnit(r,'LIBRARY_AUDIT')) out.audit++;});
  out.total=out.attendance+out.visitors+out.audit;
  return out;
}
function assignLegacyToCurrent(){
  var u=currentUnit(), k=currentKey();
  if(!u||!k) throw new Error('No active facility/unit is available.');
  var changed=0;
  (global.logs||[]).forEach(function(r){if(!recordUnit(r,String(r.category||'').toUpperCase()==='VISITOR'?'VISITOR':'ATTENDANCE')){r.facilityName=u;r.facilityId=k;changed++;}});
  (global.auditLogs||[]).forEach(function(r){if(!recordUnit(r,'LIBRARY_AUDIT')){r.facilityName=u;r.facilityId=k;changed++;}});
  try{global.localStorage.setItem('logs',JSON.stringify(global.logs||[]));}catch(e){}
  try{global.localStorage.setItem('auditLogs',JSON.stringify(global.auditLogs||[]));}catch(e){}
  return changed;
}
function unitLabel(){return currentUnit() || 'Unassigned Facility';}

global.QLogScope={
  version:'1.0.0', unitKey:unitKey, currentUnit:currentUnit, currentKey:currentKey,
  unitLabel:unitLabel, isLibrary:isLibrary, isLibraryUnit:isLibraryUnit, isSecurity:isSecurity, isSuperScope:isSuperScope,
  capabilities:capabilities, reportTypes:reportTypes, recordUnit:recordUnit,
  recordBelongs:recordBelongs, scopeReportRows:scopeReportRows, scopedRecords:scopedRecords,
  stampCurrent:stampCurrent, legacyCounts:legacyCounts, assignLegacyToCurrent:assignLegacyToCurrent
};
})(window);
