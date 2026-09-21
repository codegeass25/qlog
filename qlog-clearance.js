/* =====================================================================
   QLog Pro — Return Clearance & Archive v1.1
   Offline-first helper for Library + Equipment return clearances.
   - Generates a real .docx entirely in the browser using bundled JSZip.
   - Stores the DOCX Blob + metadata in IndexedDB for future printing.
   - Opens the browser print dialog after successful borrower returns.
     (Web PWAs cannot silently detect a physical printer or bypass the
      browser/OS print dialog; the archive is always preserved first.)
   Fixed product identity: QLog Pro
   Powered by: Magallanes NHS Team Bitaug C.I. Projects
   ===================================================================== */
(function(global){
'use strict';

var DB_NAME='qlogProClearanceArchive';
var DB_VERSION=1;
var STORE='clearances';
var FIXED_PRODUCT='QLog Pro';
var FIXED_CREDIT='Powered by: Magallanes NHS Team Bitaug C.I. Projects';

function txt(v){return String(v==null?'':v).trim();}
function escXml(v){return txt(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function escHtml(v){return txt(v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function safeName(v){return txt(v).replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,70)||'Borrower';}
function unitKey(v){return txt(v).toUpperCase().replace(/&/g,' AND ').replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');}
function nowLabel(ms){try{return new Date(ms||Date.now()).toLocaleString();}catch(e){return '';}}
function getBranding(){
  if(typeof global.getQlogBranding==='function') return global.getQlogBranding()||{};
  try{return JSON.parse(global.localStorage.getItem('qlogSchoolBranding')||'{}')||{};}catch(e){return {};}
}
function isTeacherCategory(v){var s=txt(v).toUpperCase();return s.indexOf('TEACH')!==-1 || s.indexOf('FACULTY')!==-1;}
function getPerson(id){var a=global.people||[];for(var i=0;i<a.length;i++){if(txt(a[i].id)===txt(id))return a[i];}return null;}
function outstandingFor(borrowerId){
  var id=txt(borrowerId),books=0,equipment=0;
  (global.borrowLogs||[]).forEach(function(l){if(txt(l.l)===id && (l.s==='BORROWED'||l.s==='OVERDUE'))books+=(Number(l.qty)||1);});
  (global.equipLogs||[]).forEach(function(l){if(txt(l.borrowerId)===id && (l.s==='BORROWED'||l.s==='OVERDUE'))equipment++;});
  return {books:books,equipment:equipment,total:books+equipment};
}
function openDb(){return new Promise(function(resolve,reject){
  if(!global.indexedDB){reject(new Error('IndexedDB is not supported by this browser.'));return;}
  var req=global.indexedDB.open(DB_NAME,DB_VERSION);
  req.onupgradeneeded=function(){var db=req.result;if(!db.objectStoreNames.contains(STORE)){var s=db.createObjectStore(STORE,{keyPath:'id'});s.createIndex('issuedMs','issuedMs',{unique:false});s.createIndex('module','module',{unique:false});s.createIndex('borrowerId','borrowerId',{unique:false});s.createIndex('facilityId','facilityId',{unique:false});}};
  req.onsuccess=function(){resolve(req.result);};req.onerror=function(){reject(req.error||new Error('Could not open Clearance Archive.'));};
});}
function put(rec){return openDb().then(function(db){return new Promise(function(resolve,reject){var tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(rec);tx.oncomplete=function(){db.close();resolve(rec);};tx.onerror=function(){var e=tx.error;db.close();reject(e);};});});}
function get(id){return openDb().then(function(db){return new Promise(function(resolve,reject){var req=db.transaction(STORE,'readonly').objectStore(STORE).get(id);req.onsuccess=function(){var r=req.result;db.close();resolve(r||null);};req.onerror=function(){var e=req.error;db.close();reject(e);};});});}
function all(){return openDb().then(function(db){return new Promise(function(resolve,reject){var req=db.transaction(STORE,'readonly').objectStore(STORE).getAll();req.onsuccess=function(){var r=req.result||[];db.close();r.sort(function(a,b){return (b.issuedMs||0)-(a.issuedMs||0);});resolve(r);};req.onerror=function(){var e=req.error;db.close();reject(e);};});});}
function clearAll(){return openDb().then(function(db){return new Promise(function(resolve,reject){var tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();tx.oncomplete=function(){db.close();resolve(true);};tx.onerror=function(){var e=tx.error;db.close();reject(e);};});});}

function run(text,bold,size,color){var p='<w:r><w:rPr>'+(bold?'<w:b/>':'')+(size?'<w:sz w:val="'+size+'"/><w:szCs w:val="'+size+'"/>':'')+(color?'<w:color w:val="'+color+'"/>':'')+'</w:rPr><w:t xml:space="preserve">'+escXml(text)+'</w:t></w:r>';return p;}
function para(text,opt){opt=opt||{};var jc=opt.align?'<w:jc w:val="'+opt.align+'"/>':'';var after=opt.after!=null?opt.after:80;var before=opt.before||0;return '<w:p><w:pPr>'+jc+'<w:spacing w:before="'+before+'" w:after="'+after+'"/></w:pPr>'+run(text,!!opt.bold,opt.size||22,opt.color||'111827')+'</w:p>';}
function cell(text,opt){opt=opt||{};return '<w:tc><w:tcPr><w:tcW w:w="'+(opt.width||2400)+'" w:type="dxa"/>'+(opt.shade?'<w:shd w:fill="'+opt.shade+'"/>':'')+'</w:tcPr>'+para(text,{bold:opt.bold,size:opt.size||20,align:opt.align||'left',after:40})+'</w:tc>';}
function table(rows,widths){var xml='<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders></w:tblPr>';
  rows.forEach(function(r,ri){xml+='<w:tr>';r.forEach(function(v,ci){xml+=cell(v,{width:(widths&&widths[ci])||2400,bold:ri===0,shade:ri===0?'EAF2F8':'FFFFFF',size:ri===0?19:19});});xml+='</w:tr>';});return xml+'</w:tbl>';}
function makeDocXml(rec){
  var b=rec.branding||{},school=txt(b.schoolName)||'School / Institution',address=txt(b.address),sy=txt(b.schoolYear),status=rec.accountabilityStatus||'';
  var body='';
  body+=para(school.toUpperCase(),{bold:true,size:28,align:'center',after:40,color:'0F3D4A'});
  if(address) body+=para(address,{size:18,align:'center',after:20,color:'475569'});
  if(sy) body+=para('School Year '+sy,{size:18,align:'center',after:60,color:'475569'});
  body+=para(FIXED_PRODUCT,{bold:true,size:20,align:'center',after:120,color:'0F3D4A'});
  body+=para(rec.module==='LIBRARY'?'LIBRARY RETURN CLEARANCE':'EQUIPMENT RETURN CLEARANCE',{bold:true,size:30,align:'center',after:40,color:'111827'});
  body+=para('Clearance No.: '+rec.id,{bold:true,size:18,align:'center',after:160,color:'64748B'});
  body+=table([
    ['Borrower / Client',rec.borrowerName],['ID Number',rec.borrowerId],['Category',rec.borrowerCategory||'Client'],['Office / Facility',rec.facilityName||''],['Issued',rec.issuedAt],['Accountability Status',status]
  ],[2700,6500]);
  body+=para('',{after:70});
  body+=para('RETURNED ITEM(S)',{bold:true,size:21,after:70,color:'0F3D4A'});
  var rows=[['Item / Description','Item ID / ISBN','Qty','Return Details']];
  (rec.items||[]).forEach(function(it){rows.push([it.name||it.title||'',it.id||it.isbn||'',String(it.qty||1),[it.returnedAt||rec.issuedAt,it.condition?('Condition: '+it.condition):'',it.ref?('Ref: '+it.ref):''].filter(Boolean).join(' | ')]);});
  body+=table(rows,[3500,1900,700,3100]);
  body+=para('',{after:70});
  var statement='This certifies that the item(s) listed above were returned and received by the responsible QLog Pro unit. ';
  if(rec.module==='LIBRARY') statement+='No active Library book accountability remains in QLog Pro for this borrower as of issuance.';
  else statement+='No active Equipment accountability remains in QLog Pro for this borrower as of issuance.';
  body+=para(statement,{size:20,after:180});
  body+=table([['Received / Certified By','Borrower / Client'],[rec.receivedBy||'____________________________',rec.borrowerName||'____________________________'],[rec.receivedByDesignation||'Unit In-Charge','Signature / Acknowledgment']], [4600,4600]);
  if(b.approvedBy){body+=para('',{after:70});body+=para('Approved / Noted by:',{bold:true,size:19,align:'center',after:60});body+=para(b.approvedBy,{bold:true,size:21,align:'center',after:20});body+=para(b.approvedPosition||'',{size:18,align:'center',after:100});}
  body+=para(FIXED_PRODUCT+' • '+FIXED_CREDIT,{size:16,align:'center',after:0,color:'64748B'});
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr></w:body></w:document>';
}
async function generateDocx(rec){
  if(!global.JSZip) throw new Error('JSZip is unavailable; clearance DOCX cannot be generated.');
  var z=new global.JSZip();
  z.file('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.folder('_rels').file('.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.folder('word').file('document.xml',makeDocXml(rec));
  return z.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',compression:'DEFLATE'});
}
function downloadBlob(blob,name){var u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u);},1500);}
function printHtml(rec){
  var b=rec.branding||{},rows=(rec.items||[]).map(function(it){return '<tr><td>'+escHtml(it.name||it.title)+'</td><td>'+escHtml(it.id||it.isbn)+'</td><td style="text-align:center">'+escHtml(it.qty||1)+'</td><td>'+escHtml([it.returnedAt||rec.issuedAt,it.condition?('Condition: '+it.condition):'',it.ref?('Ref: '+it.ref):''].filter(Boolean).join(' | '))+'</td></tr>';}).join('');
  var html='<!doctype html><html><head><meta charset="utf-8"><title>'+escHtml(rec.id)+'</title><style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111827;font-size:11pt;margin:0}.head{text-align:center}.school{font-size:16pt;font-weight:800;color:#0f3d4a}.muted{color:#64748b}.title{font-size:18pt;font-weight:800;margin:18px 0 3px}.meta{display:grid;grid-template-columns:1fr 1fr;border:1px solid #cbd5e1;margin:18px 0}.meta div{padding:7px 9px;border-bottom:1px solid #e2e8f0}.meta div:nth-child(odd){font-weight:700;background:#f8fafc}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #cbd5e1;padding:7px;vertical-align:top}th{background:#eaf2f8;text-align:left}.statement{margin:18px 0;line-height:1.5}.sign{display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:36px;text-align:center}.line{border-top:1px solid #111827;padding-top:5px;margin-top:35px}.footer{text-align:center;color:#64748b;font-size:9pt;margin-top:32px}</style></head><body><div class="head"><div class="school">'+escHtml((b.schoolName||'School / Institution').toUpperCase())+'</div><div class="muted">'+escHtml(b.address||'')+'</div>'+(b.schoolYear?'<div class="muted">School Year '+escHtml(b.schoolYear)+'</div>':'')+'<div style="margin-top:6px;font-weight:700">'+FIXED_PRODUCT+'</div><div class="title">'+(rec.module==='LIBRARY'?'LIBRARY RETURN CLEARANCE':'EQUIPMENT RETURN CLEARANCE')+'</div><div class="muted">Clearance No. '+escHtml(rec.id)+'</div></div><div class="meta"><div>Borrower / Client</div><div>'+escHtml(rec.borrowerName)+'</div><div>ID Number</div><div>'+escHtml(rec.borrowerId)+'</div><div>Office / Facility</div><div>'+escHtml(rec.facilityName)+'</div><div>Issued</div><div>'+escHtml(rec.issuedAt)+'</div><div>Accountability Status</div><div>'+escHtml(rec.accountabilityStatus)+'</div></div><h3>Returned Item(s)</h3><table><thead><tr><th>Item / Description</th><th>Item ID / ISBN</th><th>Qty</th><th>Return Details</th></tr></thead><tbody>'+rows+'</tbody></table><div class="statement">This certifies that the item(s) above were returned and received by the responsible QLog Pro unit. '+(rec.module==='LIBRARY'?'No active Library book accountability remains in QLog Pro for this borrower as of issuance.':'No active Equipment accountability remains in QLog Pro for this borrower as of issuance.')+'</div><div class="sign"><div><div class="line">'+escHtml(rec.receivedBy||'Unit In-Charge')+'</div><div class="muted">'+escHtml(rec.receivedByDesignation||'Received / Certified By')+'</div></div><div><div class="line">'+escHtml(rec.borrowerName)+'</div><div class="muted">Borrower / Client</div></div></div><div class="footer">'+FIXED_PRODUCT+' • '+FIXED_CREDIT+'</div></body></html>';
  var frame=document.createElement('iframe');frame.style.position='fixed';frame.style.right='0';frame.style.bottom='0';frame.style.width='1px';frame.style.height='1px';frame.style.border='0';frame.style.opacity='0.01';document.body.appendChild(frame);var d=frame.contentDocument||frame.contentWindow.document;d.open();d.write(html);d.close();setTimeout(function(){try{frame.contentWindow.focus();frame.contentWindow.print();}catch(e){}setTimeout(function(){frame.remove();},1500);},250);
}

function clearanceMeta(rec){
  rec=rec||{};
  var meta={id:rec.id,module:rec.module,borrowerId:rec.borrowerId,borrowerName:rec.borrowerName,borrowerCategory:rec.borrowerCategory,facilityName:rec.facilityName,facilityId:rec.facilityId,items:(rec.items||[]).map(function(x){return {name:x.name||x.title||'',title:x.title||'',id:x.id||'',isbn:x.isbn||'',qty:x.qty||1,returnedAt:x.returnedAt||'',condition:x.condition||'',ref:x.ref||''};}),issuedMs:rec.issuedMs,issuedAt:rec.issuedAt,receivedBy:rec.receivedBy,receivedByDesignation:rec.receivedByDesignation,remaining:rec.remaining,accountabilityStatus:rec.accountabilityStatus,filename:rec.filename||''};if(rec._syncId)meta._syncId=rec._syncId;return meta;
}
function syncMetaMirror(rec){
  try{
    var arr=JSON.parse(global.localStorage.getItem('clearances')||'[]');if(!Array.isArray(arr))arr=[];
    var meta=clearanceMeta(rec);
    var i=arr.findIndex(function(x){return x&&x.id===meta.id;});if(i>=0)arr[i]=meta;else arr.push(meta);
    global.localStorage.setItem('clearances',JSON.stringify(arr));
  }catch(e){console.warn('[QLog Clearance] Central metadata mirror failed',e);}
}
async function recoverArchivedClearancesToMirror(){
  try{
    var role=String((global.currentSession||{}).role||'').toLowerCase();
    if(/guard|security|watchman/.test(role))return 0;
    var archived=(await all()).filter(function(r){return recordVisible(r,'');});
    if(!archived.length)return 0;
    var arr=JSON.parse(global.localStorage.getItem('clearances')||'[]');if(!Array.isArray(arr))arr=[];
    var byId={};arr.forEach(function(x,i){if(x&&x.id)byId[String(x.id)]=i;});
    var added=0;
    archived.forEach(function(rec){
      var meta=clearanceMeta(rec),key=String(meta.id||'');if(!key)return;
      if(Object.prototype.hasOwnProperty.call(byId,key))arr[byId[key]]=Object.assign({},arr[byId[key]],meta);
      else{byId[key]=arr.length;arr.push(meta);added++;}
    });
    global.localStorage.setItem('clearances',JSON.stringify(arr));
    if(global.QLogCentral&&typeof global.QLogCentral.syncDatasetsNow==='function')await global.QLogCentral.syncDatasetsNow(['clearances']);
    return added;
  }catch(e){console.warn('[QLog Clearance] Archive-to-Central recovery deferred',e);return 0;}
}

function buildRecord(opts){
  opts=opts||{};var p=opts.person||getPerson(opts.borrowerId)||{};var ms=Date.now(),remaining=outstandingFor(opts.borrowerId);var module=opts.module==='LIBRARY'?'LIBRARY':'EQUIPMENT';
  var id='CLR-'+module.slice(0,3)+'-'+new Date(ms).toISOString().slice(0,10).replace(/-/g,'')+'-'+ms.toString(36).toUpperCase();
  var status=module==='LIBRARY'?'LIBRARY CLEARED — NO ACTIVE BOOK ACCOUNTABILITY':'EQUIPMENT CLEARED — NO ACTIVE EQUIPMENT ACCOUNTABILITY';
  return {id:id,module:module,borrowerId:txt(opts.borrowerId||p.id),borrowerName:txt(opts.borrowerName||p.name),borrowerCategory:txt(opts.borrowerCategory||p.category),facilityName:txt(opts.facilityName),facilityId:unitKey(opts.facilityName),items:opts.items||[],issuedMs:ms,issuedAt:nowLabel(ms),receivedBy:txt(opts.receivedBy||((global.currentSession||{}).inCharge)),receivedByDesignation:txt(opts.receivedByDesignation||((global.currentSession||{}).designation)),remaining:remaining,accountabilityStatus:status,branding:getBranding()};
}
async function issue(opts){
  opts=opts||{};var p=opts.person||getPerson(opts.borrowerId)||{};var module=opts.module==='LIBRARY'?'LIBRARY':'EQUIPMENT';
  var remaining=outstandingFor(opts.borrowerId);
  // Clearance is module-specific and is available to ANY registered borrower.
  // A Library clearance needs zero active books; an Equipment clearance needs
  // zero active equipment. Accountability in the other module does not block it.
  if(module==='LIBRARY' && remaining.books>0) return {issued:false,reason:'OUTSTANDING_BOOKS',remaining:remaining};
  if(module==='EQUIPMENT' && remaining.equipment>0) return {issued:false,reason:'OUTSTANDING_EQUIPMENT',remaining:remaining};
  var rec=buildRecord(opts);var blob=await generateDocx(rec);rec.filename='QLog_Clearance_'+safeName(rec.borrowerName)+'_'+rec.id+'.docx';rec.docxBlob=blob;await put(rec);syncMetaMirror(rec);try{if(global.QLogCentral&&typeof global.QLogCentral.syncDatasetsNow==='function')await global.QLogCentral.syncDatasetsNow(['clearances']);}catch(syncErr){console.warn('[QLog Clearance] Immediate Central sync deferred',syncErr);}
  if(global.toast) global.toast('📁 Clearance archived: '+rec.id,'green');
  if(opts.autoPrint!==false){try{printHtml(rec);}catch(e){if(global.toast)global.toast('Clearance saved to archive. Printing could not be opened automatically.','yellow');}}
  return {issued:true,record:rec};
}
async function download(id){var r=await get(id);if(!r)throw new Error('Clearance not found.');downloadBlob(r.docxBlob,r.filename||('QLog_Clearance_'+r.id+'.docx'));}
async function printOne(id){var r=await get(id);if(!r)throw new Error('Clearance not found.');printHtml(r);}
function recordVisible(r,scope){
  if(scope&&r.module!==scope)return false;
  if(global.QLogScope&&QLogScope.isSuperScope&&QLogScope.isSuperScope())return true;
  if(r.module==='LIBRARY')return !!(global.currentSession&&currentSession.role==='librarian');
  var cur=(global.QLogScope&&QLogScope.currentKey)?QLogScope.currentKey():unitKey((global.currentSession||{}).facility);return !!cur&&r.facilityId===cur;
}
async function archiveHtml(scope){var rows=(await all()).filter(function(r){return recordVisible(r,scope);});if(!rows.length)return '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:20px;">No clearances archived for this scope.</td></tr>';return rows.map(function(r){var items=(r.items||[]).map(function(x){return x.name||x.title||x.id||x.isbn;}).join(', ');return '<tr><td>'+escHtml(r.id)+'</td><td>'+escHtml(r.borrowerName)+'</td><td>'+escHtml(r.borrowerId)+'</td><td>'+escHtml(r.module)+'</td><td>'+escHtml(r.facilityName)+'</td><td>'+escHtml(items)+'</td><td>'+escHtml(r.issuedAt)+'</td><td><button onclick="QLogClearance.download(\''+escHtml(r.id)+'\')" style="padding:5px 9px;font-size:12px;">DOCX</button> <button onclick="QLogClearance.print(\''+escHtml(r.id)+'\')" style="padding:5px 9px;font-size:12px;background:#0f172a;">Print</button></td></tr>';}).join('');}
async function openArchive(scope){
  var ov=document.getElementById('qlogClearanceArchiveModal');if(!ov){ov=document.createElement('div');ov.id='qlogClearanceArchiveModal';ov.className='modal-overlay';ov.innerHTML='<div class="modal-content" style="max-width:1180px;"><div class="modal-header"><div><h3 style="margin:0;">📁 Clearance Archive</h3><div style="font-size:12px;color:#64748b;margin-top:3px;">Archived DOCX clearances remain available offline for future download or printing.</div></div><button class="modal-close" onclick="document.getElementById(\'qlogClearanceArchiveModal\').style.display=\'none\'">Close</button></div><div class="full-table"><table><thead><tr><th>Clearance No.</th><th>Borrower / Client</th><th>ID</th><th>Module</th><th>Facility</th><th>Returned Item(s)</th><th>Issued</th><th>Actions</th></tr></thead><tbody id="qlogClearanceArchiveTbl"></tbody></table></div></div>';document.body.appendChild(ov);}ov.style.display='flex';var tb=document.getElementById('qlogClearanceArchiveTbl');tb.innerHTML='<tr><td colspan="8">Loading clearance archive...</td></tr>';try{tb.innerHTML=await archiveHtml(scope||'');}catch(e){tb.innerHTML='<tr><td colspan="8" style="color:#dc2626;">Unable to load archive: '+escHtml(e.message||e)+'</td></tr>';}}

global.QLogClearance={version:'1.0.1',isTeacherCategory:isTeacherCategory,outstandingFor:outstandingFor,generateDocx:generateDocx,issue:issue,list:all,get:get,download:download,print:printOne,openArchive:openArchive,clearAll:clearAll,recoverArchivedClearancesToMirror:recoverArchivedClearancesToMirror,_makeDocXml:makeDocXml,_buildRecord:buildRecord};
global.addEventListener('qlog:central-ready',function(){setTimeout(function(){recoverArchivedClearancesToMirror();},120);});
global.addEventListener('qlog:central-profile-switched',function(){setTimeout(function(){recoverArchivedClearancesToMirror();},120);});
})(window);
