/* =====================================================================
   QLog Pro — Classic Features Bridge v1.0
   Restores the ORIGINAL QLog UI/UX while retaining the latest feature
   layer: whitelabel school profile, fixed QLog identity, report scope,
   facility capability filtering, legacy-scope assignment, and report
   branding. No sidebar, overview shell, command palette, drawers, or
   master-designer page restructuring is installed here.
   ===================================================================== */
(function(){
'use strict';

var BRAND_KEY='qlogSchoolBranding';
var FIXED_PRODUCT='QLog Pro';
var FIXED_CREDIT='Powered by: Magallanes NHS Team Bitaug C.I. Projects';

function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function getBranding(){
  var d={schoolName:'',schoolId:'',address:'',district:'',division:'',region:'',contact:'',email:'',schoolYear:'',logo:'',accent:'#2563eb',preparedBy:'',preparedPosition:'',checkedBy:'',checkedPosition:'',approvedBy:'',approvedPosition:''};
  /* configData is part of the Central sync contract. Keep a mirrored copy there
     so school/report settings survive device/profile reconciliation. */
  try{Object.assign(d,JSON.parse(localStorage.getItem(BRAND_KEY)||'{}'));}catch(e){}
  try{var cfg=JSON.parse(localStorage.getItem('configData')||'{}');if(cfg&&cfg.qlogSchoolBranding)Object.assign(d,cfg.qlogSchoolBranding);}catch(e){}
  return d;
}
window.getQlogBranding=getBranding;
window.QLOG_FIXED_PRODUCT=FIXED_PRODUCT;
window.QLOG_FIXED_CREDIT=FIXED_CREDIT;

function field(id,label,cls,type){
  return '<div class="'+(cls||'')+'"><label for="'+id+'">'+esc(label)+'</label><input type="'+(type||'text')+'" id="'+id+'" autocomplete="off"></div>';
}
function ensureSettings(){
  if(document.getElementById('settings')) return;
  var reports=document.getElementById('reports'), nav=document.querySelector('.nav');
  if(!reports||!nav) return;

  var btn=document.createElement('button');
  btn.id='qlogSettingsNav';
  btn.textContent='⚙️ Settings';
  btn.onclick=function(){ if(window.showTab) window.showTab('settings',btn); };
  nav.appendChild(btn);

  var tab=document.createElement('div');
  tab.id='settings'; tab.className='tab';
  tab.innerHTML='\
    <div class="card">\
      <h3>⚙️ Settings</h3>\
      <div class="qlog-classic-settings-menu">\
        <button class="active" data-panel="reports">Report Signatories</button>\
        <button data-panel="scope">Data & Scope</button>\
        <button data-panel="about">About</button>\
      </div>\
    </div>\
    <div class="qlog-classic-settings-panel active" data-panel="reports">\
      <div class="card"><h3>🖨 Report Signatories</h3><div class="qlog-classic-form-grid">\
        '+field('qBrandPreparedBy','Prepared By')+field('qBrandPreparedPos','Prepared By — Position')+field('qBrandCheckedBy','Checked By')+field('qBrandCheckedPos','Checked By — Position')+field('qBrandApprovedBy','Approved By')+field('qBrandApprovedPos','Approved By — Position')+'\
      </div><button class="qBrandSaveAny" style="margin-top:14px;">💾 Save Report Signatories</button></div>\
    </div>\
    <div class="qlog-classic-settings-panel" data-panel="scope">\
      <div class="card"><h3>🏢 Current Unit / Report Scope</h3><p style="font-size:13px;color:#64748b;">Normal users only see report types and report records allowed for their assigned facility. Old records without facility ownership remain isolated until explicitly assigned.</p><div id="qClassicScopeGrid" class="qlog-classic-scope-grid"></div>\
      <hr><h4>Legacy Unscoped Records</h4><div id="qClassicLegacyGrid" class="qlog-classic-scope-grid"></div><button id="qClassicAssignLegacy" style="background:#d97706;">Assign All Unscoped Logs to Current Unit</button>\
      <hr><h4>🔐 Superadmin Maintenance</h4><p style="font-size:13px;color:#64748b;max-width:820px;">Delete operational QLog records while keeping the installation activation, Superadmin password, and school branding. Superadmin password re-entry is required.</p><button id="qClassicResetOperational" style="background:#b91c1c;">🗑 Reset Operational Data</button></div>\
    </div>\
    <div class="qlog-classic-settings-panel" data-panel="about">\
      <div class="card"><h3>'+FIXED_PRODUCT+'</h3><p>Offline-first school logging, visitor verification, library circulation, COA ICS inventory, equipment custody, and unit-scoped reporting.</p><div class="qlog-classic-fixed-brand"><b>Product:</b> '+FIXED_PRODUCT+'<br><b>Credit:</b> '+FIXED_CREDIT+'<br><b>Deployment:</b> Pure PWA / local-first<br><b>UI Mode:</b> Original QLog Classic</div></div>\
    </div>';
  reports.insertAdjacentElement('afterend',tab);

  document.querySelectorAll('.qlog-classic-settings-menu button').forEach(function(b){
    b.onclick=function(){
      document.querySelectorAll('.qlog-classic-settings-menu button').forEach(function(x){x.classList.toggle('active',x===b);});
      document.querySelectorAll('.qlog-classic-settings-panel').forEach(function(x){x.classList.toggle('active',x.dataset.panel===b.dataset.panel);});
      if(b.dataset.panel==='scope') renderScope();
    };
  });
  document.querySelectorAll('.qBrandSaveAny').forEach(function(x){x.onclick=function(){saveBranding(readBrandFields());};});
  var as=document.getElementById('qClassicAssignLegacy'); if(as)as.onclick=assignLegacy;
  var ro=document.getElementById('qClassicResetOperational'); if(ro)ro.onclick=openOperationalResetAuth;
  ensureOperationalResetModal();
  loadBrandFields(); renderScope();
}

function mapFields(){return {qBrandSchoolName:'schoolName',qBrandSchoolId:'schoolId',qBrandSchoolYear:'schoolYear',qBrandAddress:'address',qBrandDistrict:'district',qBrandDivision:'division',qBrandRegion:'region',qBrandContact:'contact',qBrandEmail:'email',qBrandPreparedBy:'preparedBy',qBrandPreparedPos:'preparedPosition',qBrandCheckedBy:'checkedBy',qBrandCheckedPos:'checkedPosition',qBrandApprovedBy:'approvedBy',qBrandApprovedPos:'approvedPosition',qBrandAccent:'accent'};}
function loadBrandFields(){var b=getBranding(),m=mapFields();Object.keys(m).forEach(function(id){var e=document.getElementById(id);if(e)e.value=b[m[id]]||'';});updatePreview();applyBranding();}
function readBrandFields(){var b=getBranding(),m=mapFields();Object.keys(m).forEach(function(id){var e=document.getElementById(id);if(e)b[m[id]]=String(e.value||'').trim();});return b;}
function saveBranding(b){try{localStorage.setItem(BRAND_KEY,JSON.stringify(b));var cfg=JSON.parse(localStorage.getItem('configData')||'{}');if(!cfg||typeof cfg!=='object'||Array.isArray(cfg))cfg={};cfg.qlogSchoolBranding=b;localStorage.setItem('configData',JSON.stringify(cfg));if(typeof window.configData==='object'&&window.configData)window.configData=cfg;}catch(e){}applyBranding();updatePreview();if(window.toast)toast('✅ School profile / report settings saved.','green');}
function handleLogo(ev){var file=ev.target.files&&ev.target.files[0];if(!file)return;if(!/^image\/(png|jpeg|webp)$/.test(file.type)){if(window.toast)toast('Please select a PNG, JPG or WebP school logo.','red');return;}var fr=new FileReader();fr.onload=function(){var im=new Image();im.onload=function(){var c=document.createElement('canvas'),max=320,scale=Math.min(1,max/Math.max(im.width,im.height));c.width=Math.max(1,Math.round(im.width*scale));c.height=Math.max(1,Math.round(im.height*scale));c.getContext('2d').drawImage(im,0,0,c.width,c.height);var b=getBranding();b.logo=c.toDataURL('image/png',.9);saveBranding(b);loadBrandFields();};im.src=fr.result;};fr.readAsDataURL(file);}
function updatePreview(){var b=readBrandFields(),box=document.getElementById('qClassicPreview'),img=document.getElementById('qClassicLogoPreview'),nm=document.getElementById('qClassicSchoolPreview'),ad=document.getElementById('qClassicAddressPreview');if(nm)nm.textContent=b.schoolName||'Your School / Institution';if(ad)ad.textContent=[b.address,b.schoolYear?'SY '+b.schoolYear:''].filter(Boolean).join(' • ')||'School profile appears here.';if(img&&box){if(b.logo){img.src=b.logo;box.classList.add('has-logo');}else{img.removeAttribute('src');box.classList.remove('has-logo');}}}
function applyBranding(){var b=getBranding();document.title=FIXED_PRODUCT+(b.schoolName?' — '+b.schoolName:'');var tc=document.querySelector('meta[name="theme-color"]');if(tc)tc.setAttribute('content',b.accent||'#2563eb');var h=document.querySelector('.header h2');if(h)h.textContent=FIXED_PRODUCT;var ft=document.getElementById('facilityTitle');if(ft&&window.currentSession&&currentSession.facility){ft.textContent=((b.schoolName?b.schoolName+' • ':'')+currentSession.facility).toUpperCase();}}
window.applyQlogBranding=applyBranding;

function applyVisibility(){
  /* Restore the ORIGINAL QLog role/tab behavior exactly:
     - Live Monitor, Client Inventory and Reports are common tabs.
     - Library tabs appear ONLY for the explicit Librarian startup role.
     - Equipment follows the original non-Library / non-Security access rule.
     - Visitors stays hidden by default and is revealed only by showVisitorTab()
       while an active visitor workflow is in progress. */
  if(!window.currentSession || !currentSession.facility){ filterReportOptions(); return; }
  var isLibrarianRole = currentSession.role === 'librarian';
  var set=function(id,on){var e=document.getElementById(id);if(e)e.style.display=on?'inline-block':'none';};

  set('bookInvBtn',isLibrarianRole);
  set('borrowBtn',isLibrarianRole);
  set('reservationTabBtn',isLibrarianRole);
  var guardRole=(typeof window.isGuardWatchmanSession==='function')?!!window.isGuardWatchmanSession():String(currentSession.role||currentSession.designation||'').toLowerCase().indexOf('guard')>=0;
  var settingsNav=document.getElementById('qlogSettingsNav');if(settingsNav)settingsNav.style.display=guardRole?'none':'inline-block';

  if(typeof window.applyEquipmentTabVisibility==='function'){
    window.applyEquipmentTabVisibility();
  }else{
    var equipmentAllowed = (typeof window.canAccessEquipmentModule==='function') ? !!window.canAccessEquipmentModule() : false;
    set('equipBtn',equipmentAllowed);
  }

  /* IMPORTANT: do not force visitorTabBtn visible here. The original flow
     controls it through showVisitorTab()/hideVisitorTab(). */
  var visitorBtn=document.getElementById('visitorTabBtn');
  var visitorTab=document.getElementById('visitors');
  if(visitorBtn && (!visitorTab || !visitorTab.classList.contains('active'))){
    visitorBtn.style.display='none';
  }

  filterReportOptions();
  var a=document.querySelector('.tab.active');
  if(a){
    var badLibrary=!isLibrarianRole && ['bookinv','borrow','reservationsTab'].indexOf(a.id)>=0;
    var badEquipment=a.id==='equipment' && typeof window.canAccessEquipmentModule==='function' && !window.canAccessEquipmentModule();
    var badSettings=guardRole&&a.id==='settings';
    if((badLibrary||badEquipment||badSettings)&&window.showTab){var b=document.querySelector('.nav button');showTab('live',b);}
  }
}
function filterReportOptions(){
  var sel=document.getElementById('reportType');if(!sel||!window.QLogScope)return;
  var allowed=QLogScope.reportTypes();
  Array.prototype.forEach.call(sel.options,function(o){var ok=allowed.indexOf(o.value)>=0;o.hidden=!ok;o.disabled=!ok;});
  if(allowed.indexOf(sel.value)<0){sel.value=allowed[0]||'ATTENDANCE';if(window.updateReportControls)updateReportControls();}
  var note=document.getElementById('reportContextNote');if(note){note.textContent='Showing only report types and records allowed for '+QLogScope.unitLabel()+'.';}
}
function renderScope(){
  if(!window.QLogScope)return;var c=QLogScope.capabilities(),unit=QLogScope.unitLabel();
  var grid=document.getElementById('qClassicScopeGrid');if(grid)grid.innerHTML=[['Active Unit',unit],['Attendance',c.attendance?'Enabled':'Not available'],['Visitors',c.visitors?'Enabled':'Not available'],['Library',c.library?'Enabled':'Not available'],['Equipment',c.equipment?'Enabled':'Not available'],['Cross-unit Reports',c.allUnits?'Enabled':'Not available']].map(function(x){return '<div class="qlog-classic-scope-item"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b></div>';}).join('');
  var l=QLogScope.legacyCounts(),lg=document.getElementById('qClassicLegacyGrid');if(lg)lg.innerHTML=[['Total Unscoped',l.total],['Attendance',l.attendance],['Visitors',l.visitors],['Audit',l.audit]].map(function(x){return '<div class="qlog-classic-scope-item"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b></div>';}).join('');
}
function assignLegacy(){if(!window.QLogScope)return;var l=QLogScope.legacyCounts();if(!l.total){if(window.toast)toast('No legacy unscoped records found.','blue');return;}if(!confirm('Assign ALL '+l.total+' unscoped historical log(s) to '+QLogScope.unitLabel()+'? This changes their reporting ownership.'))return;try{var n=QLogScope.assignLegacyToCurrent();renderScope();if(window.renderReports)renderReports();if(window.toast)toast('✅ '+n+' historical record(s) assigned to '+QLogScope.unitLabel()+'.','green');}catch(e){if(window.toast)toast('Unable to assign legacy records: '+e.message,'red');}}

function ensureOperationalResetModal(){
  if(document.getElementById('qOperationalResetModal')) return;
  var m=document.createElement('div');
  m.id='qOperationalResetModal';
  m.style.cssText='display:none;position:fixed;inset:0;z-index:10050;background:rgba(15,23,42,.62);align-items:center;justify-content:center;padding:18px;';
  m.innerHTML='<div role="dialog" aria-modal="true" aria-labelledby="qOperationalResetTitle" style="width:min(520px,96vw);background:#fff;border-radius:16px;padding:22px;box-shadow:0 24px 70px rgba(15,23,42,.28);">'
    +'<h3 id="qOperationalResetTitle" style="margin:0 0 8px;color:#991b1b;">🗑 Reset Operational Data</h3>'
    +'<p style="margin:0 0 14px;color:#475569;font-size:13px;line-height:1.55;">This deletes operational records across QLog Pro. Installation activation, the Superadmin password, and school branding are retained.</p>'
    +'<label for="qOperationalResetPassword" style="display:block;font-weight:700;margin-bottom:6px;">Superadmin Password</label>'
    +'<input id="qOperationalResetPassword" type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;margin-bottom:8px;" placeholder="Enter Superadmin password">'
    +'<div id="qOperationalResetError" style="min-height:20px;color:#b91c1c;font-size:12px;font-weight:700;"></div>'
    +'<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px;">'
    +'<button id="qOperationalResetCancel" type="button" style="background:#64748b;">Cancel</button>'
    +'<button id="qOperationalResetConfirm" type="button" style="background:#b91c1c;">Verify & Continue</button>'
    +'</div></div>';
  document.body.appendChild(m);
  var cancel=document.getElementById('qOperationalResetCancel'); if(cancel)cancel.onclick=closeOperationalResetAuth;
  var confirmBtn=document.getElementById('qOperationalResetConfirm'); if(confirmBtn)confirmBtn.onclick=submitOperationalResetAuth;
  var pw=document.getElementById('qOperationalResetPassword'); if(pw)pw.addEventListener('keydown',function(e){if(e.key==='Enter')submitOperationalResetAuth();});
  m.addEventListener('click',function(e){if(e.target===m)closeOperationalResetAuth();});
}
function openOperationalResetAuth(){
  ensureOperationalResetModal();
  var m=document.getElementById('qOperationalResetModal'),pw=document.getElementById('qOperationalResetPassword'),err=document.getElementById('qOperationalResetError');
  if(pw)pw.value=''; if(err)err.textContent=''; if(m)m.style.display='flex';
  setTimeout(function(){if(pw)pw.focus();},80);
}
function closeOperationalResetAuth(){
  var m=document.getElementById('qOperationalResetModal'),pw=document.getElementById('qOperationalResetPassword'),err=document.getElementById('qOperationalResetError');
  if(pw)pw.value=''; if(err)err.textContent=''; if(m)m.style.display='none';
}
function submitOperationalResetAuth(){
  var pw=document.getElementById('qOperationalResetPassword'),err=document.getElementById('qOperationalResetError');
  var value=pw?pw.value:'';
  if(!value){if(err)err.textContent='Enter the Superadmin password.';return;}
  var ok=false; try{ok=typeof window.verifySuperPassword==='function'&&window.verifySuperPassword(value);}catch(e){ok=false;}
  value=''; if(pw)pw.value='';
  if(!ok){if(err)err.textContent='Incorrect Superadmin password. Access denied.';if(window.toast)toast('❌ Operational reset denied.','red');return;}
  closeOperationalResetAuth();
  if(typeof window.resetDatabase!=='function'){if(window.toast)toast('Reset routine is unavailable.','red');return;}
  window.resetDatabase();
}

function patchLifecycle(){
  if(window.finalizeStartup&&!window.finalizeStartup.__qclassic){var oldF=window.finalizeStartup;var f=function(){var r=oldF.apply(this,arguments);setTimeout(function(){applyVisibility();applyBranding();renderScope();},20);return r;};f.__qclassic=true;window.finalizeStartup=f;}
  if(window.showTab&&!window.showTab.__qclassic){var oldS=window.showTab;var s=function(id,btn){
    var isLibrarianRole=!!(window.currentSession&&currentSession.role==='librarian');
    if(['bookinv','borrow','reservationsTab'].indexOf(id)>=0&&!isLibrarianRole){if(window.toast)toast('⛔ Library modules are available only to the Librarian role.','red');return;}
    if(id==='equipment'&&typeof window.canAccessEquipmentModule==='function'&&!window.canAccessEquipmentModule()){if(window.toast)toast('⛔ Equipment Borrowing is not available for your unit.','red');return;}
    if(id==='settings'&&typeof window.isGuardWatchmanSession==='function'&&window.isGuardWatchmanSession()){if(window.toast)toast('⛔ Settings is not available for the Guard role.','red');return;}
    var r=oldS.apply(this,arguments);if(id==='reports'){filterReportOptions();if(window.renderReports)renderReports();}if(id==='settings')renderScope();return r;};s.__qclassic=true;window.showTab=s;}
}
function boot(){ensureSettings();patchLifecycle();applyVisibility();applyBranding();renderScope();setTimeout(function(){applyVisibility();applyBranding();},300);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
