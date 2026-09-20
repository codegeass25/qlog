/* QLog Pro Ultimate — Profile-Scoped Central Sync
   Authority: authenticated In-Charge profile = assigned office/lab scope.
   Same profile on multiple devices => shared central state.
   Different profile => no central fetch until re-authenticated.
*/
(function () {
  'use strict';

  var API_BASE = String(window.QLOG_API_BASE || localStorage.getItem('qlogApiUrl') || 'https://qlog-upgraded.mdmsportal.uk').replace(/\/$/, '');
  var API_CANDIDATES = Array.from(new Set(([API_BASE].concat(window.QLOG_API_CANDIDATES||[])).map(function(v){return String(v||'').trim().replace(/\/$/,'');}).filter(Boolean)));
  var TOKEN_KEY = 'qlogCentralToken';
  var SOURCE_KEY = 'qlogCentralSourceId';
  var ACCESS_HINT_KEY = 'qlogCentralConnectedAt';
  var ACTIVE_FACILITY_KEY = 'qlogCentralActiveFacility';
  var ACTIVE_PROFILE_KEY = 'qlogCentralActiveProfile';
  var RECONCILE_PREFIX = 'qlogCentralReconcileAt::';
  var CACHE_PREFIX = 'qlogProfileCache::';
  var RESET_KEY = 'qlogCentralResetRequested';
  var CENTRAL_RESET_GENERATION_KEY = 'qlogCentralResetGeneration';
  var RESET_HOLD_KEY = 'qlogCentralResetHold::';
  var DELETE_QUEUE_PREFIX = 'qlogCentralDeleteQueue::';
  var PENDING_PREFIX = 'qlogCentralPending::';
  var OFFLINE_QUEUE_PREFIX = 'qlogCentralOfflineQueue::';
  var VISITOR_FACE_CACHE_KEY = 'qlogCentralVisitorFaceDirectoryV1';

  var SYNC_KEYS = ['logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','configData','dynamicFilterData','borrowPolicies','clearances'];
  var SCHOOL_WIDE_DATASETS = ['logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','clearances'];
  var PROFILE_DATASETS = ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','clearances'];
  var GLOBAL_DATASETS = ['configData','dynamicFilterData','borrowPolicies'];

  var statusTimer = null;

  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    sourceId: localStorage.getItem(SOURCE_KEY) || '',
    activeFacility: localStorage.getItem(ACTIVE_FACILITY_KEY) || '',
    activeProfileKey: localStorage.getItem(ACTIVE_PROFILE_KEY) || '',
    activeScope: localStorage.getItem('qlogCentralActiveScope') || '',
    syncing: false,
    suppress: false,
    pending: new Set(),
    timer: null,
    authInFlight: false,
    reconciling: false,
    switchingProfile: false,
    socket: null,
    serverReady: false,
    healthTimer: null,
    allowOfflineFlush: false,
    lastFullPullAt: 0,
    initialSyncNoticeShown: false,
    lastSuccessReceipt: ''
  };

  function makeSourceId(){
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch(e) {}
    return 'QLOG-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,12);
  }
  if (!state.sourceId) {
    state.sourceId = makeSourceId();
    localStorage.setItem(SOURCE_KEY, state.sourceId);
  }
  window.QLOG_CLIENT_ID = state.sourceId;

  function normalize(v){ return String(v == null ? '' : v).trim().replace(/\s+/g,' '); }
  function currentFacility(){ return normalize((window.currentSession||{}).facility || ''); }
  function currentInCharge(){ return normalize((window.currentSession||{}).inCharge || ''); }
  function currentDesignation(){ return normalize((window.currentSession||{}).designation || ''); }
  function currentRole(){ return normalize((window.currentSession||{}).role || ''); }
  function allowedDatasetsForCurrentRole(){
    var role=currentRole().toLowerCase(),fac=currentFacility().toUpperCase(),des=currentDesignation().toUpperCase(),text=(role+' '+fac+' '+des).toUpperCase();
    if(role==='superadmin'||role==='admin')return new Set(SCHOOL_WIDE_DATASETS);
    if(role==='librarian'||/LIBRAR/.test(text))return new Set(['logs','books','borrowLogs','reservations','auditLogs','clearances']);
    if(/GUARD|SECURITY|GATE/.test(text))return new Set(['logs','auditLogs']);
    return new Set(['logs','equipment','equipLogs','auditLogs','clearances']);
  }
  function eventRelevantToCurrentRole(datasets){var a=allowedDatasetsForCurrentRole();return (datasets||[]).some(function(x){return a.has(x)||GLOBAL_DATASETS.indexOf(x)!==-1;});}
  function currentScope(){ return currentFacility().toLowerCase() + '|' + currentInCharge().toLowerCase(); }
  function scopeLabel(){ return currentInCharge() + ' — ' + currentFacility(); }
  function hashScope(scope){
    var s = String(scope || '').toLowerCase();
    var h = 2166136261;
    for(var i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return (h>>>0).toString(16);
  }
  function scopeId(){ return hashScope(currentScope()); }
  function cacheKey(scope,dataset){ return CACHE_PREFIX + hashScope(scope) + '::' + dataset; }
  function reconcileKey(scope){ return RECONCILE_PREFIX + hashScope(scope); }
  function pendingKey(scope){ return PENDING_PREFIX + hashScope(scope); }
  function loadPending(scope){ try{var v=JSON.parse(localStorage.getItem(pendingKey(scope))||'[]');return new Set(Array.isArray(v)?v.filter(function(x){return SYNC_KEYS.indexOf(x)!==-1;}):[]);}catch(e){return new Set();} }
  function savePending(scope,p){ try{localStorage.setItem(pendingKey(scope),JSON.stringify(Array.from(p||[])));}catch(e){} }
  function clearPending(scope){ try{localStorage.removeItem(pendingKey(scope));}catch(e){} }

  function offlineQueueKey(scope){return OFFLINE_QUEUE_PREFIX+hashScope(scope);}
  function loadOfflineQueue(scope){try{var q=JSON.parse(localStorage.getItem(offlineQueueKey(scope))||'[]');return Array.isArray(q)?q:[];}catch(e){return [];}}
  function saveOfflineQueue(scope,q){try{localStorage.setItem(offlineQueueKey(scope),JSON.stringify(Array.isArray(q)?q:[]));}catch(e){}}
  function hasOfflineQueue(scope){return loadOfflineQueue(scope||currentScope()).length>0;}
  function stableId(){try{if(crypto&&crypto.randomUUID)return 'SYNC-'+crypto.randomUUID();}catch(e){}return 'SYNC-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12);}
  function ensureStableIds(dataset,value){
    if(!Array.isArray(value)||['logs','borrowLogs','reservations','auditLogs','equipLogs','clearances'].indexOf(dataset)===-1)return value;
    value.forEach(function(o){if(o&&typeof o==='object'&&!o._syncId)o._syncId=stableId();});
    return value;
  }
  function syncWindowArray(dataset,value){
    if(!Array.isArray(value))return;
    try{
      if(dataset==='logs')window.logs=value; else if(dataset==='books')window.books=value; else if(dataset==='borrowLogs')window.borrowLogs=value;
      else if(dataset==='reservations')window.reservations=value; else if(dataset==='auditLogs')window.auditLogs=value;
      else if(dataset==='equipment')window.equipment=value; else if(dataset==='equipLogs')window.equipLogs=value;
    }catch(e){}
  }
  function offlineLabel(dataset,obj){
    obj=obj||{};var name=obj.name||obj.learnerName||obj.borrowerName||obj.teacherName||obj.title||obj.eqName||obj.action||obj.id||obj.isbn||obj.eqId||'';
    var status=obj.s||obj.status||obj.category||'';return [dataset,name,status].filter(Boolean).join(' • ');
  }
  function queueOfflineDifference(dataset,before,after){
    if(['logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','clearances'].indexOf(dataset)===-1)return;
    var q=loadOfflineQueue(currentScope()),oldMap={},newMap={};
    if(Array.isArray(before))before.forEach(function(o,i){oldMap[recordIdentity(dataset,o,i)]=o;});
    if(Array.isArray(after))after.forEach(function(o,i){newMap[recordIdentity(dataset,o,i)]=o;});
    var ids={};Object.keys(oldMap).concat(Object.keys(newMap)).forEach(function(id){ids[id]=true;});
    Object.keys(ids).forEach(function(id){
      var b=Object.prototype.hasOwnProperty.call(oldMap,id)?oldMap[id]:null,a=Object.prototype.hasOwnProperty.call(newMap,id)?newMap[id]:null;
      if(JSON.stringify(b)===JSON.stringify(a))return;
      var op=!b?'ADD':(!a?'DELETE':'UPDATE');
      var existing=q.findIndex(function(x){return x.dataset===dataset&&x.identity===id;});
      var item={id:dataset+'|'+id,dataset:dataset,identity:id,operation:op,before:b,after:a,at:new Date().toISOString(),label:offlineLabel(dataset,a||b)};
      if(existing>=0){item.before=q[existing].before;q[existing]=item;}else q.push(item);
    });
    saveOfflineQueue(currentScope(),q);
  }
  function applyOfflineQueueToLocal(q){
    (q||[]).forEach(function(item){
      var arr=collectDataset(item.dataset);if(!Array.isArray(arr))return;
      arr=arr.slice();var idx=arr.findIndex(function(o,i){return recordIdentity(item.dataset,o,i)===item.identity;});
      if(item.after==null){if(idx>=0)arr.splice(idx,1);}else if(idx>=0)arr[idx]=item.after;else arr.push(item.after);
      setDatasetLocal(item.dataset,arr,true);
    });
  }
  function discardOfflineItem(id){
    var q=loadOfflineQueue(currentScope()),item=q.find(function(x){return x.id===id;});if(!item)return;
    var arr=collectDataset(item.dataset);if(Array.isArray(arr)){
      arr=arr.slice();var idx=arr.findIndex(function(o,i){return recordIdentity(item.dataset,o,i)===item.identity;});
      if(item.before==null){if(idx>=0)arr.splice(idx,1);}else if(idx>=0)arr[idx]=item.before;else arr.push(item.before);
      setDatasetLocal(item.dataset,arr,true);
    }
    q=q.filter(function(x){return x.id!==id;});saveOfflineQueue(currentScope(),q);renderOfflineQueue();refreshUi();
  }
  function renderOfflineQueue(){
    var body=document.getElementById('qlogOfflineQueueBody'),count=document.getElementById('qlogOfflineQueueCount');if(!body)return;
    var q=loadOfflineQueue(currentScope());if(count)count.textContent=String(q.length);
    body.innerHTML=q.length?q.map(function(x){var detail='';try{detail=JSON.stringify(x.after||x.before||{}).slice(0,260);}catch(e){}return '<div style="border:1px solid #e2e8f0;border-radius:12px;padding:10px;margin:8px 0;background:#f8fafc"><div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1"><b>'+escapeHtml(x.operation)+' · '+escapeHtml(x.label||x.dataset)+'</b><div style="font-size:11px;color:#64748b;margin-top:4px;word-break:break-word">'+escapeHtml(detail)+'</div></div><button type="button" style="background:#dc2626;flex:0 0 auto" onclick="QLogCentral.discardOfflineItem(\''+String(x.id).replace(/'/g,"\\'")+'\')">Delete</button></div></div>';}).join(''):'<div style="padding:16px;color:#166534;font-weight:700">No pending offline transactions.</div>';
  }
  function escapeHtml(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function showOfflineReview(){injectUI();renderOfflineQueue();var m=document.getElementById('qlogOfflineReviewModal');if(m)m.style.display='flex';}
  function closeOfflineReview(){var m=document.getElementById('qlogOfflineReviewModal');if(m)m.style.display='none';}
  async function syncReviewedOffline(){
    var q=loadOfflineQueue(currentScope());if(!q.length){closeOfflineReview();return true;}
    if(!navigator.onLine||!state.token){setStatus('Connect to Central before syncing reviewed offline data','warn');return false;}
    var names=Array.from(new Set(q.map(function(x){return x.dataset;})));
    state.allowOfflineFlush=true;
    try{names.forEach(function(n){state.pending.add(n);});savePending(currentScope(),state.pending);var ok=await sync(false);if(ok){saveOfflineQueue(currentScope(),[]);closeOfflineReview();saveProfileCache(currentScope());setStatus('Reviewed offline transactions synced to Central','ok');return true;}return false;}
    finally{state.allowOfflineFlush=false;}
  }

  function setStatus(text,kind,options){
    var el=document.getElementById('qlogCentralStatus');
    if(!el)return;
    options=options||{};
    var receipt=(kind||'idle')+'|'+String(text||'');
    // Success notices are event receipts, not a heartbeat. Never re-show the
    // exact same success message just because the 4s/30s reconcile timer ran.
    if((kind||'')==='ok' && !options.force && state.lastSuccessReceipt===receipt) return;
    if((kind||'')==='ok') state.lastSuccessReceipt=receipt;
    if(statusTimer) clearTimeout(statusTimer);
    el.textContent=text;
    el.dataset.kind=kind||'idle';
    el.title='Central database: '+text;
    el.classList.add('show');
    statusTimer=setTimeout(function(){
      el.classList.remove('show');
    },2600);
  }

  function injectUI(){
    if(document.getElementById('qlogCentralStatus')) return;
    var style=document.createElement('style');
    style.textContent='.qlog-central-status{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(14px);z-index:99999;padding:9px 14px;border-radius:999px;background:#0f172a;color:#fff;font:600 12px/1.2 Inter,Arial,sans-serif;box-shadow:0 4px 18px rgba(15,23,42,.2);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease}.qlog-central-status.show{opacity:.96;transform:translateX(-50%) translateY(0)}.qlog-central-status[data-kind="ok"]{background:#166534}.qlog-central-status[data-kind="warn"]{background:#a16207}.qlog-central-status[data-kind="err"]{background:#b91c1c}.qlog-central-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.55);z-index:100000;padding:20px}.qlog-central-card{width:min(460px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);font-family:Inter,Arial,sans-serif;color:#0f172a}.qlog-central-card h3{margin:0 0 8px}.qlog-central-card p{color:#475569;font-size:13px;line-height:1.5}.qlog-central-card input{width:100%;box-sizing:border-box;margin-top:10px}.qlog-central-card .actions{display:flex;gap:10px;margin-top:14px}.qlog-central-card button{flex:1}.qlog-offline-card{width:min(760px,100%);max-height:88vh;overflow:auto}.qlog-offline-actions{display:flex;gap:10px;position:sticky;bottom:-22px;background:#fff;padding:12px 0 0}';
    document.head.appendChild(style);
    var status=document.createElement('div');
    status.id='qlogCentralStatus';
    status.className='qlog-central-status';
    status.textContent='Central sync: starting…';
    document.body.appendChild(status);
    var modal=document.createElement('div');
    modal.id='qlogCentralAuthModal';
    modal.className='qlog-central-modal';
    modal.innerHTML='<div class="qlog-central-card"><h3>🔐 Connect to Central Database</h3><p>Central data is anchored to the authenticated In-Charge profile and assigned office/laboratory. This device can only fetch records for the profile shown below.</p><div id="qlogCentralProfile" style="margin:10px 0;padding:10px;background:#f1f5f9;border-radius:10px;font-size:13px;font-weight:700;"></div><input id="qlogCentralCode" type="password" autocomplete="off" placeholder="Office Access Code"><div id="qlogCentralAuthError" style="min-height:18px;color:#b91c1c;font-size:12px;margin-top:7px"></div><div class="actions"><button type="button" style="background:#64748b" onclick="window.QLogCentral.closeAuth()">Not now</button><button type="button" onclick="window.QLogCentral.connect()">Connect</button></div></div>';
    document.body.appendChild(modal);
    var offline=document.createElement('div');
    offline.id='qlogOfflineReviewModal'; offline.className='qlog-central-modal';
    offline.innerHTML='<div class="qlog-central-card qlog-offline-card"><h3>🔄 Review Offline Transactions (<span id="qlogOfflineQueueCount">0</span>)</h3><p>These records were created or changed while Central was unavailable. Review them first. Delete any incorrect transaction before the final sync.</p><div id="qlogOfflineQueueBody"></div><div class="qlog-offline-actions"><button type="button" style="background:#64748b" onclick="QLogCentral.closeOfflineReview()">Review later</button><button type="button" onclick="QLogCentral.syncReviewedOffline()">Sync Reviewed Data Now</button></div></div>';
    document.body.appendChild(offline);
  }
  function openAuth(){
    injectUI();
    var p=document.getElementById('qlogCentralProfile'); if(p)p.textContent=scopeLabel();
    var m=document.getElementById('qlogCentralAuthModal'); if(m)m.style.display='flex';
    var i=document.getElementById('qlogCentralCode'); if(i){i.value='';setTimeout(function(){i.focus();},50);}
  }
  function closeAuth(){ var m=document.getElementById('qlogCentralAuthModal'); if(m)m.style.display='none'; }
  function headers(){ var h={'Content-Type':'application/json'}; if(state.token)h.Authorization='Bearer '+state.token; return h; }
  function emitLiveStatus(){
    try{window.dispatchEvent(new CustomEvent('qlog-live-status'));}catch(e){}
  }
  function setServerReady(value){
    var next=!!value;
    if(state.serverReady!==next){state.serverReady=next;emitLiveStatus();}
    else state.serverReady=next;
  }
  async function checkServerHealth(timeoutMs){
    timeoutMs=Math.max(1000,Number(timeoutMs)||4500);
    if(!navigator.onLine){setServerReady(false);return false;}
    var candidates=API_CANDIDATES.slice();
    if(candidates.indexOf(API_BASE)!==0){candidates=candidates.filter(function(v){return v!==API_BASE;});candidates.unshift(API_BASE);}
    for(var ci=0;ci<candidates.length;ci++){
      var candidate=candidates[ci];
      var controller=(typeof AbortController==='function')?new AbortController():null;
      var timeoutHandle=null;
      try{
        var opts={cache:'no-store'};
        if(controller){opts.signal=controller.signal;timeoutHandle=setTimeout(function(){try{controller.abort();}catch(e){}},timeoutMs);}
        var res=await fetch(candidate+'/api/health',opts);
        if(timeoutHandle)clearTimeout(timeoutHandle);
        if(res&&res.ok){
          API_BASE=candidate;
          window.QLOG_API_BASE=candidate;
          try{localStorage.setItem('qlogApiUrl',candidate);}catch(e){}
          setServerReady(true);
          return true;
        }
      }catch(e){ if(timeoutHandle)clearTimeout(timeoutHandle); }
    }
    setServerReady(false);return false;
  }
  async function api(path,options){
    var opts=options||{};
    opts.headers=Object.assign(headers(),opts.headers||{});
    var res;
    try{
      res=await fetch(API_BASE+path,opts);
      setServerReady(true);
    }catch(e){
      setServerReady(false);
      throw e;
    }
    var data=null; try{data=await res.json();}catch(e){}
    if(!res.ok){var err=new Error(data&&data.error?data.error:('HTTP '+res.status));err.status=res.status;err.data=data;throw err;}
    return data;
  }

  function localInventoryFingerprint(o,name){
    o=o||{}; function n(v){return String(v==null?'':v).trim().toLowerCase();}
    if(name==='books'){
      var bid=n(o.id||o.bookId||o.bookID||o.productId||o.productID||o.inventoryId||o.itemId||o.itemID||o.accessionNo||o.accession||o.barcode||o.barCode||o.qrCode||o.isbn||o.ISBN);
      return bid ? 'book|'+bid : ['book-fallback',n(o.title||o.bookTitle||o.name),n(o.author)].join('|');
    }
    var eid=n(o.id||o.equipmentId||o.equipmentID||o.eqId||o.productId||o.productID||o.inventoryId||o.itemId||o.itemID||o.assetNo||o.asset||o.propertyNo||o.propertyID||o.serialNo||o.serial||o.barcode||o.barCode||o.qrCode||o.code);
    return eid ? 'equipment|'+eid : ['equipment-fallback',n(o.name||o.eqName||o.title),n(o.category||o.type),n(o.manufacturer),n(o.model)].join('|');
  }
  function logSemanticKey(o){
    o=o||{};
    function n(v){return String(v==null?'':v).trim().replace(/\s+/g,' ').toLowerCase();}
    return [n(o.id),n(o.date),n(o.timein||o.timeIn),n(o.category),n(o.facilityName||o.facility||currentFacility())].join('|');
  }
  function dedupeOperationalLogs(value){
    if(!Array.isArray(value))return value;
    var byKey=new Map(),order=[];
    value.forEach(function(obj){
      var k=logSemanticKey(obj);
      if(!k.replace(/\|/g,'')){order.push(obj);return;}
      if(!byKey.has(k)){byKey.set(k,obj);order.push(obj);return;}
      var prev=byKey.get(k);
      // Keep the richer lifecycle state (e.g. a timeout added to the same TIME-IN).
      if(!prev.timeout && obj.timeout){Object.assign(prev,obj);}
      else if(prev.timeout && !obj.timeout){/* keep previous */}
      else {Object.assign(prev,obj);}
    });
    return order;
  }
  function dedupeLocal(name,value){
    if((name!=='books'&&name!=='equipment')||!Array.isArray(value))return value;
    var seen=new Set(),out=[];
    value.forEach(function(obj){var fp=localInventoryFingerprint(obj,name);if(seen.has(fp))return;seen.add(fp);out.push(obj);});
    return out;
  }
  function collectDataset(name){
    if(name==='people')return Array.isArray(window.people)?window.people:[];
    if(name==='logs')return dedupeOperationalLogs(Array.isArray(window.logs)?window.logs:[]);
    if(name==='books')return dedupeLocal(name,Array.isArray(window.books)?window.books:[]);
    if(name==='borrowLogs')return Array.isArray(window.borrowLogs)?window.borrowLogs:[];
    if(name==='reservations')return Array.isArray(window.reservations)?window.reservations:[];
    if(name==='auditLogs')return Array.isArray(window.auditLogs)?window.auditLogs:[];
    if(name==='equipment')return dedupeLocal(name,Array.isArray(window.equipment)?window.equipment:[]);
    if(name==='equipLogs')return Array.isArray(window.equipLogs)?window.equipLogs:[];
    if(name==='clearances'){try{return JSON.parse(localStorage.getItem('clearances')||'[]')||[];}catch(e){return [];}}
    if(name==='configData')return window.configData||{};
    if(name==='dynamicFilterData')return window.dynamicFilterData||{};
    if(name==='borrowPolicies')return window.borrowPolicies||{};
    return null;
  }
  function snapshot(names){var out={};(names||SYNC_KEYS).forEach(function(n){out[n]=collectDataset(n);});return out;}

  function setDatasetLocal(name,value,cacheIt){
    try{
      state.suppress=true;
      if(name==='people')window.people=Array.isArray(value)?value:[];
      else if(name==='logs'){value=dedupeOperationalLogs(Array.isArray(value)?value:[]);window.logs=value;}
      else if(name==='books')window.books=Array.isArray(value)?value:[];
      else if(name==='borrowLogs')window.borrowLogs=Array.isArray(value)?value:[];
      else if(name==='reservations')window.reservations=Array.isArray(value)?value:[];
      else if(name==='auditLogs')window.auditLogs=Array.isArray(value)?value:[];
      else if(name==='equipment')window.equipment=Array.isArray(value)?value:[];
      else if(name==='equipLogs')window.equipLogs=Array.isArray(value)?value:[];
      else if(name==='clearances'){}
      else if(name==='configData')window.configData=value||{};
      else if(name==='dynamicFilterData')window.dynamicFilterData=value||{};
      else if(name==='borrowPolicies')window.borrowPolicies=value||{};
      localStorage.setItem(name,JSON.stringify(value));
      if(cacheIt!==false && state.activeProfileKey && PROFILE_DATASETS.indexOf(name)!==-1){
        localStorage.setItem(cacheKey(currentScope(),name),JSON.stringify(value));
      }
    }catch(e){}finally{state.suppress=false;}
  }
  function saveProfileCache(scope){
    if(!scope)return;
    PROFILE_DATASETS.forEach(function(name){try{localStorage.setItem(cacheKey(scope,name),JSON.stringify(collectDataset(name)));}catch(e){}});
  }
  function hasProfileCache(scope){
    return PROFILE_DATASETS.some(function(name){return localStorage.getItem(cacheKey(scope,name))!==null;});
  }
  function loadProfileCache(scope){
    PROFILE_DATASETS.forEach(function(name){
      var raw=localStorage.getItem(cacheKey(scope,name));
      if(raw!==null){try{setDatasetLocal(name,JSON.parse(raw),false);}catch(e){setDatasetLocal(name,[],false);}}
      else setDatasetLocal(name,[],false);
    });
  }

  function recordIdentity(dataset,o,index){
    o=o||{};
    if(o._syncId)return String(o._syncId);
    if(dataset==='people'||dataset==='books'||dataset==='equipment')return String(o.id||o.isbn||o.ISBN||o.assetNo||o.asset||o.ID||dataset+':'+index);
    if(dataset==='logs')return [o.id||'',o.date||'',o.timein||'',o.category||'',o.name||''].join('|');
    if(dataset==='borrowLogs')return String(o.ref||[o.l||'',o.b||'',o.borrowedAt||''].join('|'));
    if(dataset==='reservations')return String(o.id||[o.isbn||'',o.lId||o.learnerId||'',o.createdAt||o.reservedAt||''].join('|'));
    if(dataset==='auditLogs')return String(o.id||[o.timestamp||'',o.action||'',o.details||''].join('|'));
    if(dataset==='equipLogs')return String(o.ref||[o.eqId||'',o.borrowerId||'',o.borrowedMs||''].join('|'));
    if(dataset==='clearances')return String(o.id||[o.module||'',o.borrowerId||'',o.issuedMs||''].join('|'));
    return dataset;
  }
  function mergeProfileDatasets(dataset,rows){
    var map={},inventorySeen={};
    (rows||[]).forEach(function(r){
      if(r.deletedAt)return;
      var d=r.data||{},key=recordIdentity(dataset,d,0);
      if(dataset==='books'||dataset==='equipment'){
        var fp=String(r.fingerprint||localInventoryFingerprint(d,dataset));
        var logical=dataset+'|'+fp;
        if(inventorySeen[logical]){
          if((inventorySeen[logical].updatedAt||'') < (r.updatedAt||'')) inventorySeen[logical]=r;
          return;
        }
        inventorySeen[logical]=r; key=logical;
      }
      map[key]=r;
    });
    var out=Object.keys(map).sort(function(a,b){return String(map[a].updatedAt||'').localeCompare(String(map[b].updatedAt||''));}).map(function(k){return map[k].data;});
    return (dataset==='books'||dataset==='equipment')?dedupeLocal(dataset,out):out;
  }
  function applyFullState(resp){
    var datasets=resp&&resp.datasets||{};
    PROFILE_DATASETS.forEach(function(name){
      var rows=[],value=datasets[name];
      if(Array.isArray(value))rows=value.map(function(data){return {data:data,updatedAt:''};});
      else if(value&&typeof value==='object')rows=[{data:value,updatedAt:''}];
      setDatasetLocal(name,mergeProfileDatasets(name,rows),true);
    });
    // School-wide settings are intentionally shared across profiles/devices.
    GLOBAL_DATASETS.forEach(function(name){
      if(Object.prototype.hasOwnProperty.call(datasets,name) && datasets[name]!=null){
        setDatasetLocal(name,datasets[name],false);
      }
    });
    localStorage.setItem(reconcileKey(currentScope()),resp.snapshotAt||new Date().toISOString());
    clearDeleteQueue(currentScope());
    refreshUi();
  }
  function applyDelta(resp){
    var grouped={};
    (resp.records||[]).forEach(function(r){if(SYNC_KEYS.indexOf(r.dataset)!==-1)(grouped[r.dataset] ||= []).push(r);});
    Object.keys(grouped).forEach(function(dataset){
      // Local unsynced edits are newer from this device's point of view. Do not
      // overwrite them with a remote delta; after direct sync succeeds the next
      // reconcile will converge on the committed Central version.
      if(state.pending.has(dataset)) return;
      var changes=grouped[dataset];
      if(GLOBAL_DATASETS.indexOf(dataset)!==-1){
        var latest=changes.slice().sort(function(a,b){return String(a.updatedAt||'').localeCompare(String(b.updatedAt||''));}).pop();
        if(latest && !latest.deletedAt) setDatasetLocal(dataset,latest.data,false);
        return;
      }
      var current=collectDataset(dataset);
      if(!Array.isArray(current))return;
      var rows=current.map(function(data){return {data:data,updatedAt:''};});
      changes.forEach(function(r){
        var key=recordIdentity(dataset,r.data,0);
        rows=rows.filter(function(x){return recordIdentity(dataset,x.data,0)!==key;});
        if(!r.deletedAt)rows.push({data:r.data,updatedAt:r.updatedAt||''});
      });
      setDatasetLocal(dataset,mergeProfileDatasets(dataset,rows),true);
    });
    localStorage.setItem(reconcileKey(currentScope()),resp.serverTime||new Date().toISOString());
    refreshUi();
    if(grouped.logs && grouped.logs.length){
      try{window.dispatchEvent(new CustomEvent('qlog:visitor-directory-updated',{detail:{source:'reconcile',count:grouped.logs.length}}));}catch(e){}
    }
  }
  function refreshUi(){
    try{if(typeof renderPeople==='function')renderPeople();}catch(e){}
    try{if(typeof renderLogs==='function')renderLogs();}catch(e){}
    try{if(typeof renderBookInventory==='function')renderBookInventory();}catch(e){}
    try{if(typeof refreshEquipmentUI==='function')refreshEquipmentUI();}catch(e){}
    // Normal Central reconciliation must never clear an in-progress equipment borrow.
    // Staging inputs belong to the operator session, not the synchronized dataset.
    try{if(typeof equipDup!=='undefined')equipDup={};}catch(e){}
    try{if(typeof renderBorrow==='function')renderBorrow();}catch(e){}
    try{if(typeof renderReservations==='function')renderReservations();}catch(e){}
    try{if(typeof applyQlogBranding==='function')applyQlogBranding();}catch(e){}
  }

  function deleteQueueKey(scope){ return DELETE_QUEUE_PREFIX + hashScope(scope); }
  function readDeleteQueue(scope){
    try{return JSON.parse(localStorage.getItem(deleteQueueKey(scope))||'{}')||{};}catch(e){return {};}
  }
  function writeDeleteQueue(scope,q){ try{localStorage.setItem(deleteQueueKey(scope),JSON.stringify(q||{}));}catch(e){} }
  function clearDeleteQueue(scope){ try{localStorage.removeItem(deleteQueueKey(scope));}catch(e){} }
  function queueDeletedDifference(name,oldValue,newValue){
    if(PROFILE_DATASETS.indexOf(name)===-1 || !Array.isArray(oldValue) || !Array.isArray(newValue)) return;
    var now={},q=readDeleteQueue(currentScope());
    oldValue.forEach(function(item,i){now[recordIdentity(name,item,i)]=true;});
    newValue.forEach(function(item,i){delete now[recordIdentity(name,item,i)];});
    Object.keys(now).forEach(function(k){q[name] ||= [];if(q[name].indexOf(k)===-1)q[name].push(k);});
    writeDeleteQueue(currentScope(),q);
  }

  function clearLocalProfileData(){
    state.suppress=true;
    try{
      PROFILE_DATASETS.forEach(function(name){
        localStorage.removeItem(name);
        if(state.activeProfileKey) localStorage.removeItem(cacheKey(currentScope(),name));
      });
      localStorage.removeItem(RECONCILE_PREFIX+hashScope(currentScope()));
      state.pending.clear();
      window.people=[]; window.logs=[]; window.books=[]; window.borrowLogs=[]; window.reservations=[]; window.auditLogs=[]; window.equipment=[]; window.equipLogs=[];
      ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','clearances'].forEach(function(name){try{localStorage.setItem(name,'[]');}catch(e){}});
      clearDeleteQueue(currentScope());
      saveOfflineQueue(currentScope(),[]);
      /* Reset is LOCAL ONLY. It intentionally does not rebuild and does not send tombstones. */
      localStorage.setItem(RESET_HOLD_KEY+hashScope(currentScope()),new Date().toISOString());
      localStorage.removeItem(RESET_KEY);
    }finally{state.suppress=false;}
    refreshUi();
    try{ if(typeof renderEquipRegistry==='function') renderEquipRegistry(); }catch(e){}
    try{ if(typeof renderEquipLogs==='function') renderEquipLogs(); }catch(e){}
    try{ if(typeof refreshEquipmentUI==='function') refreshEquipmentUI(); }catch(e){}
  }

  function localResetHeld(scope){
    return !!localStorage.getItem(RESET_HOLD_KEY+hashScope(scope));
  }

  function clearLocalResetHold(scope){
    localStorage.removeItem(RESET_HOLD_KEY+hashScope(scope));
  }

  function clearAllCentralClientCaches(){
    if(state.socket){
      try{state.socket.disconnect();}catch(e){}
      state.socket=null;
    }
    state.syncing=false;
    state.reconciling=false;
    state.pending.clear();
    clearTimeout(state.timer);
    state.timer=null;
    var prefixes=[CACHE_PREFIX,RECONCILE_PREFIX,DELETE_QUEUE_PREFIX,RESET_HOLD_KEY,PENDING_PREFIX,OFFLINE_QUEUE_PREFIX];
    var exact=[RESET_KEY,TOKEN_KEY,ACTIVE_PROFILE_KEY,ACTIVE_FACILITY_KEY,ACCESS_HINT_KEY];
    var keys=[];
    for(var i=0;i<localStorage.length;i++){
      var key=localStorage.key(i);
      if(!key)continue;
      for(var p=0;p<prefixes.length;p++){
        if(key.indexOf(prefixes[p])===0){keys.push(key);break;}
      }
    }
    keys.forEach(function(key){localStorage.removeItem(key);});
    exact.forEach(function(key){localStorage.removeItem(key);});
    ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','clearances'].forEach(function(name){
      localStorage.removeItem(name);
      try{localStorage.setItem(name,'[]');}catch(e){}
    });
    state.token='';
    state.activeProfileKey='';
    state.activeFacility='';
    state.activeScope='';
    localStorage.removeItem('qlogCentralActiveScope');
    state.pending.clear();
    window.people=[];window.logs=[];window.books=[];window.borrowLogs=[];window.reservations=[];window.auditLogs=[];window.equipment=[];window.equipLogs=[];
    refreshUi();
  }

  async function activateSync(mode){
    if(!state.token || !navigator.onLine) throw new Error('PROFILE_AUTH_REQUIRED');
    var generation=Number(localStorage.getItem(CENTRAL_RESET_GENERATION_KEY)||0);
    return await api('/api/device/activate-sync',{method:'POST',body:JSON.stringify({mode:mode||'existing',centralResetGeneration:generation})});
  }

  async function requestProfileRebuild(){
    if(!state.token||!navigator.onLine||!currentFacility()||!currentInCharge()) throw new Error('PROFILE_AUTH_REQUIRED');
    try{
      return await api('/api/profile/rebuild');
    }catch(e){
      if(e.status===404||e.status===405){
        return await api('/api/profile/rebuild',{method:'POST',body:JSON.stringify({reason:'USER_REQUESTED_REBUILD'})});
      }
      throw e;
    }
  }

  async function rebuildMyOffice(){
    if(!state.token||!navigator.onLine||!currentFacility()||!currentInCharge()){
      openAuth();
      throw new Error('PROFILE_AUTH_REQUIRED');
    }
    try{
      setStatus('Rebuilding '+scopeLabel()+' from Central…','warn');
      var resp=await requestProfileRebuild();
      if(resp.profileKey&&state.activeProfileKey&&resp.profileKey!==state.activeProfileKey)throw Object.assign(new Error('PROFILE_SCOPE_MISMATCH'),{status:409});
      applyFullState(resp);
      clearLocalResetHold(currentScope());
      localStorage.removeItem(RESET_KEY);
      saveProfileCache(currentScope());
      setStatus('Office data rebuilt from Central','ok');
      return resp;
    }catch(e){
      if(e.status===401||e.status===403||e.status===409){
        state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);
        setStatus(e.data&&e.data.error==='PROFILE_ARCHIVED'?'Profile is archived — contact Central Admin':'Profile authentication required','warn');
        openAuth();
      }else{
        setStatus('Office rebuild failed — '+(e.data&&e.data.error||e.message||'Central unavailable'),'err');
      }
      throw e;
    }
  }

  async function resetThisDevice(){
    var label=scopeLabel();
    if(!state.token||state.activeProfileKey!==scopeId()){
      openAuth();
      return;
    }
    if(!confirm('Reset THIS DEVICE only for '+label+'?\n\nThis clears the local operational cache on this device only.\n\nCENTRAL RECORDS WILL NOT BE DELETED.\n\nIf Central is online, the authorized profile data will be restored automatically after the reset.')) return;
    try{
      clearLocalProfileData();
      clearLocalResetHold(currentScope());
      if(navigator.onLine){await fullProfileReconcile();saveProfileCache(currentScope());}
      setStatus('This device was reset. Central records are untouched and the authorized profile was restored.','ok');
      alert('This device has been reset.\n\nCentral records were NOT deleted.\n\nAuthorized profile data is restored automatically when Central is online. Rebuild My Office Data remains available only as a recovery tool.');
    }catch(e){
      setStatus('Device reset failed — '+(e.message||'Unknown error'),'err');
      throw e;
    }
  }

  async function fullProfileReconcile(){
    if(localResetHeld(currentScope())) return;
    if(!state.token||!navigator.onLine||!currentFacility()||!currentInCharge())return;
    try{
      // Never let an authoritative full pull erase a transaction that was just
      // created locally but has not reached Central yet. Flush live pending work
      // first; if the POST fails, keep the local state and postpone the full pull.
      if(state.pending.size){
        var flushed=await sync(false);
        if(!flushed && state.pending.size)return;
      }
      var resp=await api('/api/state');
      if(resp.profileKey && state.activeProfileKey && resp.profileKey!==state.activeProfileKey)throw Object.assign(new Error('PROFILE_SCOPE_MISMATCH'),{status:409});
      var offlineQueue=loadOfflineQueue(currentScope());
      applyFullState(resp); state.activeProfileKey=resp.profileKey||state.activeProfileKey; state.lastFullPullAt=Date.now();
      if(offlineQueue.length){applyOfflineQueueToLocal(offlineQueue);showOfflineReview();}
      if(state.activeProfileKey)localStorage.setItem(ACTIVE_PROFILE_KEY,state.activeProfileKey);
      if(offlineQueue.length){
        setStatus('Central loaded · '+offlineQueue.length+' offline change(s) waiting for review','warn');
      }else if(!state.initialSyncNoticeShown){
        setStatus('Central '+scopeLabel()+' synced','ok',{force:true});
        state.initialSyncNoticeShown=true;
      }
    }catch(e){
      if(e.status===401||e.status===403||e.status===409){state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);setStatus(e.status===403 && e.data && e.data.error==='PROFILE_ARCHIVED'?'Profile is archived — contact Central Admin':(e.status===409?'Profile scope changed — reconnect':'Access expired — reconnect'),'warn');openAuth();}
      else setStatus('Central reconcile waiting for connection','warn');
    }
  }
  async function reconcile(){
    if(localResetHeld(currentScope())) return;
    if(state.reconciling||!state.token||!navigator.onLine||!currentFacility()||!currentInCharge())return;
    state.reconciling=true;
    try{
      var since=localStorage.getItem(reconcileKey(currentScope()))||'1970-01-01T00:00:00.000Z';
      var resp=await api('/api/reconcile?since='+encodeURIComponent(since));
      if(resp.profileKey && state.activeProfileKey && resp.profileKey!==state.activeProfileKey)throw Object.assign(new Error('PROFILE_SCOPE_MISMATCH'),{status:409});
      applyDelta(resp);
    }catch(e){
      if(e.status===401||e.status===403||e.status===409){state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);setStatus('Profile authentication required','warn');openAuth();}
    }finally{state.reconciling=false;}
  }

  async function connectWithCode(code){
    if(state.authInFlight)return;
    state.authInFlight=true; setStatus('Authenticating '+scopeLabel()+'…','warn');
    try{
      var facility=currentFacility(),inCharge=currentInCharge();
      if(!facility||!inCharge)throw new Error('PROFILE_REQUIRED');
      // Resolve a reachable Central endpoint before authentication. This lets a
      // deployed client recover if the primary Cloudflare hostname is temporarily
      // unavailable but the compatible QLog API hostname is active.
      var reachable=await checkServerHealth(3500);
      if(!reachable) throw new Error('CENTRAL_API_UNREACHABLE');
      var d=await fetch(API_BASE+'/api/auth/device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessCode:code,sourceId:state.sourceId,facility:facility,inCharge:inCharge,designation:currentDesignation(),role:currentRole()})});
      var j=await d.json().catch(function(){return{};}); if(!d.ok)throw new Error(j.error||('HTTP '+d.status));
      state.token=j.token; state.activeFacility=facility; state.activeProfileKey=j.profileKey||scopeId(); state.activeScope=currentScope(); state.initialSyncNoticeShown=false; state.lastSuccessReceipt='';
      var serverGeneration=Number(j.centralResetGeneration||0);
      var storedGenerationRaw=localStorage.getItem(CENTRAL_RESET_GENERATION_KEY);
      var storedGeneration=storedGenerationRaw===null?null:Number(storedGenerationRaw);
      var resetGenerationMismatch=(serverGeneration>0 && storedGeneration!==serverGeneration);

      if(resetGenerationMismatch){
        clearAllCentralClientCaches();
        state.token=j.token;
        state.activeFacility=facility;
        state.activeProfileKey=j.profileKey||scopeId();
        state.activeScope=currentScope();
        state.pending=loadPending(currentScope());
      }

      localStorage.setItem(CENTRAL_RESET_GENERATION_KEY,String(serverGeneration));
      try{sessionStorage.setItem('qlogCentralOfficeCode',String(code||''));}catch(e){}
      localStorage.setItem(TOKEN_KEY,state.token);
      localStorage.setItem(ACTIVE_FACILITY_KEY,facility);
      localStorage.setItem(ACTIVE_PROFILE_KEY,state.activeProfileKey);
      localStorage.setItem('qlogCentralActiveScope',currentScope());
      state.pending=loadPending(currentScope());
      localStorage.setItem(ACCESS_HINT_KEY,new Date().toISOString());

      var resetRequested=!!localStorage.getItem(RESET_KEY);
      var held=localResetHeld(currentScope());
      var cached=hasProfileCache(currentScope());

      if(resetGenerationMismatch){
        PROFILE_DATASETS.forEach(function(name){setDatasetLocal(name,[],false);});
        localStorage.removeItem(RESET_KEY);
        clearLocalResetHold(currentScope());
        await activateSync('empty');
        setStatus('Central database was reset. '+scopeLabel()+' is EMPTY. Click Rebuild My Office Data only if you intentionally want to restore Central data.','warn');
      }else if(held){
        PROFILE_DATASETS.forEach(function(name){setDatasetLocal(name,[],false);});
        clearLocalResetHold(currentScope());
        await activateSync('existing');
        await fullProfileReconcile();
        saveProfileCache(currentScope());
        setStatus('Connected to Central. Authorized profile data restored automatically after device reset.','ok');
      }else if(resetRequested || !cached){
        await activateSync('existing');
        await fullProfileReconcile();
        saveProfileCache(currentScope());
        localStorage.removeItem(RESET_KEY);
      }else{
        loadProfileCache(currentScope());
        await activateSync('existing');
        await fullProfileReconcile();
      }
      closeAuth(); connectSocket();
      try{ window.dispatchEvent(new Event('qlog:central-ready')); }catch(e){}
    }catch(e){
      var er=document.getElementById('qlogCentralAuthError'); if(er)er.textContent='Connection failed: '+e.message;
      setStatus('Central not connected','err');
    }finally{state.authInFlight=false;}
  }

  async function switchProfile(){
    var scope=currentScope(); if(!scope||state.switchingProfile)return;
    state.switchingProfile=true;
    try{
      var targetProfileId=scopeId();
      var previousScope=state.activeScope||'';
      if(state.activeProfileKey && state.activeProfileKey!==targetProfileId){
        if(previousScope) saveProfileCache(previousScope);
        savePending(previousScope,state.pending);
        clearTimeout(state.timer); state.timer=null;

        // Fast profile handoff: reuse the already-authenticated device token.
        // No password/code dialog and no full re-authentication round trip.
        if(!state.token||!navigator.onLine) throw new Error('PROFILE_AUTH_REQUIRED');
        var switched=await api('/api/auth/switch-profile',{method:'POST',body:JSON.stringify({facility:currentFacility(),inCharge:currentInCharge(),designation:currentDesignation(),role:currentRole()})});
        state.activeProfileKey=switched.profileKey||targetProfileId;
        state.activeFacility=currentFacility();
        state.activeScope=scope;
        state.initialSyncNoticeShown=false; state.lastSuccessReceipt='';
        localStorage.setItem(TOKEN_KEY,state.token);
        localStorage.setItem(ACTIVE_PROFILE_KEY,state.activeProfileKey);
        localStorage.setItem(ACTIVE_FACILITY_KEY,state.activeFacility);
        localStorage.setItem('qlogCentralActiveScope',scope);
        state.pending=loadPending(scope);
        if(state.socket){try{state.socket.disconnect();}catch(e){} state.socket=null;}

        var cached=hasProfileCache(scope);
        if(cached) loadProfileCache(scope); else PROFILE_DATASETS.forEach(function(n){setDatasetLocal(n,[],false);});
        refreshUi();
        await activateSync('existing');
        // Central is authoritative on profile entry. Pull first; queued offline
        // work is replayed locally and waits for explicit review/sync.
        await fullProfileReconcile();
        if(!hasOfflineQueue(scope)) clearPending(scope);
        connectSocket();
        try{ window.dispatchEvent(new Event('qlog:central-profile-switched')); }catch(e){}
        setStatus('Central '+scopeLabel()+' switched instantly','ok');
        return;
      }
      state.activeFacility=currentFacility();
      state.activeScope=scope;
      localStorage.setItem(ACTIVE_FACILITY_KEY,state.activeFacility);
      localStorage.setItem('qlogCentralActiveScope',scope);
      state.pending=loadPending(scope);
      if(state.token){
        if(hasProfileCache(scope))loadProfileCache(scope);
        await fullProfileReconcile();saveProfileCache(scope);
        connectSocket();
      }
    }catch(e){
      if(e.status===401||e.status===403){state.token='';state.activeProfileKey='';state.activeScope='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);localStorage.removeItem('qlogCentralActiveScope');openAuth();}
      else setStatus('Central office switch waiting for connection','warn');
    }finally{state.switchingProfile=false;}
  }
  function profileChanged(){
    var scope=currentScope();
    if(!scope)return;
    clearTimeout(state.timer); state.timer=null;
    switchProfile();
  }

  async function sync(forceAll){
    if(state.syncing||!navigator.onLine||!state.token||!state.activeProfileKey)return false;
    // Pending Offline Review items are an independent lane. They must never block
    // a new transaction created while Central is currently reachable.
    if(state.activeProfileKey!==scopeId())return false;
    state.syncing=true;
    try{
      var names=forceAll?SYNC_KEYS.slice():Array.from(state.pending);
      var deleteQueue=readDeleteQueue(currentScope());
      var hasDeletes=Object.keys(deleteQueue).some(function(k){return Array.isArray(deleteQueue[k])&&deleteQueue[k].length;});
      if(!names.length && !hasDeletes)return true;
      var snap=snapshot(names);
      ['books','equipment'].forEach(function(n){
        if(Object.prototype.hasOwnProperty.call(snap,n)){
          var clean=dedupeLocal(n,snap[n]); if(clean.length!==snap[n].length)setDatasetLocal(n,clean); snap[n]=clean;
        }
      });
      var resp=await api('/api/sync',{method:'POST',body:JSON.stringify({version:'5.0.0',client:'QLog Pro Ultimate',datasets:snap,deletions:deleteQueue,device:{facility:currentFacility(),inCharge:currentInCharge(),designation:currentDesignation(),role:currentRole()}})});
      state.pending.clear(); savePending(currentScope(),state.pending); clearDeleteQueue(currentScope());
      // Socket.IO will invalidate remote peers; avoid an immediate second GET here.
      // The fallback reconcile timer remains responsible when sockets are unavailable.
      var changedCount=((resp.accepted||[]).length)+((resp.deleted||[]).length);
      if(changedCount>0){
        // One success toast per completed transaction batch. Background pulls are silent.
        state.lastSuccessReceipt='';
        setStatus('Synced '+changedCount+' data update'+(changedCount===1?'':'s')+' to Central','ok',{force:true});
      }
      return true;
    }catch(e){
      if(e.status===401||e.status===403){state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);setStatus('Profile authentication required','warn');openAuth();}
      else if(e.status===409 && e.data && (e.data.error==='SYNC_NOT_ACTIVATED'||e.data.error==='CENTRAL_RESET_REQUIRED')){setStatus('Central reset state detected. Reconnect before syncing.','warn');openAuth();}
      else setStatus('Central sync waiting for connection','warn');
      return false;
    }finally{state.syncing=false;}
  }
  function schedule(names){
    names=(names||SYNC_KEYS).filter(function(n){return SYNC_KEYS.indexOf(n)!==-1;});
    names.forEach(function(n){state.pending.add(n);});
    savePending(currentScope(),state.pending);
    clearTimeout(state.timer);
    if(!navigator.onLine){state.timer=null;return;}
    state.timer=setTimeout(function(){sync(false);},60);
  }
  function patchStorage(){
    var ls=window.localStorage;if(!ls||ls.__qlogCentralPatched)return;
    var os=ls.setItem.bind(ls),or=ls.removeItem.bind(ls);
    ls.setItem=function(k,v){
      if(k==='savedSession'){os(k,v);setTimeout(function(){profileChanged();},0);return;}
      var before=null,after=null,tracked=!state.suppress&&SYNC_KEYS.indexOf(k)!==-1;
      if(tracked){try{before=JSON.parse(ls.getItem(k)||'null');}catch(e){}}
      if(tracked){try{after=JSON.parse(v);if(Array.isArray(after)){ensureStableIds(k,after);if(k==='logs')after=dedupeOperationalLogs(after);v=JSON.stringify(after);syncWindowArray(k,after);}}catch(e){after=null;}}
      os(k,v);
      if(tracked){
        if(after===null){try{after=JSON.parse(v);}catch(e){}}
        if(!navigator.onLine){queueOfflineDifference(k,before,after);showOfflineReview();return;}
        try{queueDeletedDifference(k,before,after);}catch(e){}
        schedule([k]);
      }
    };
    ls.removeItem=function(k){
      var before=null,tracked=!state.suppress&&SYNC_KEYS.indexOf(k)!==-1;
      if(tracked){try{before=JSON.parse(ls.getItem(k)||'null');}catch(e){}}
      or(k);
      if(tracked){
        if(!navigator.onLine){queueOfflineDifference(k,before,[]);showOfflineReview();return;}
        if(Array.isArray(before)){var q=readDeleteQueue(currentScope());q[k]=(q[k]||[]).concat(before.map(function(item,i){return recordIdentity(k,item,i);}).filter(function(x){return q[k].indexOf(x)===-1;}));writeDeleteQueue(currentScope(),q);}
        schedule([k]);
      }
    };
    ls.__qlogCentralPatched=true;
  }
  function installSaveHooks(){
    if(typeof window.saveAll==='function'&&!window.saveAll.__qlogWrapped){var old=window.saveAll;window.saveAll=function(){var r=old.apply(this,arguments);schedule(['logs']);return r;};window.saveAll.__qlogWrapped=true;}
    if(typeof window.saveEquipData==='function'&&!window.saveEquipData.__qlogWrapped){var oldEq=window.saveEquipData;window.saveEquipData=function(){var r=oldEq.apply(this,arguments);schedule(['equipment','equipLogs']);return r;};window.saveEquipData.__qlogWrapped=true;}
  }
  function connectSocket(){
    if(state.socket||state.socketScriptLoading||!state.token||!navigator.onLine)return;
    state.socketScriptLoading=true;
    try{
      var s=document.createElement('script'); s.src=API_BASE+'/socket.io/socket.io.js';
      s.onload=function(){state.socketScriptLoading=false;
        try{
          if(typeof window.io!=='function')return;
          state.socket=window.io(API_BASE,{auth:{token:state.token},transports:['websocket','polling']});
          state.socket.on('connect',function(){
            window.dispatchEvent(new CustomEvent('qlog-live-status'));
            // Socket reconnect means Central may have changed while this client was
            // sleeping/backgrounded (common on iOS). Reconcile immediately.
            reconcile();
          });
          state.socket.on('disconnect',function(){window.dispatchEvent(new CustomEvent('qlog-live-status'));});
          state.socket.on('presence:count',function(m){window.QLOG_CONNECTED_CLIENTS=(m&&m.connectedClients)||0;window.dispatchEvent(new CustomEvent('qlog-live-status'));});
          state.socket.on('qlog:updated',function(evt){
            if(!evt)return;
            var ds=Array.isArray(evt.datasets)?evt.datasets:(Array.isArray(evt.changed)?evt.changed:[]);
            // Different accounts/devices reconcile only datasets allowed for the active role.
            // Shared Visitor identity still rides on the allowed 'logs' dataset; Guard devices
            // no longer wake up for Library/Equipment/Professional changes they cannot use.
            if(evt.profileKey && state.activeProfileKey && evt.profileKey!==state.activeProfileKey && !eventRelevantToCurrentRole(ds) && !evt.centralClientInventory && !evt.centralSettingsChanged)return;
            if(ds.indexOf('logs')!==-1){
              try{window.dispatchEvent(new CustomEvent('qlog:visitor-directory-updated',{detail:evt}));}catch(e){}
            }
            if(evt.centralClientInventory||evt.centralSettingsChanged)fullProfileReconcile(); else reconcile();
          });
          state.socket.on('qlog:central_reset',function(evt){
            try{
              state.suppress=true;
              if(state.socket){
                try{state.socket.disconnect();}catch(e){}
                state.socket=null;
              }
              clearAllCentralClientCaches();
              localStorage.setItem(CENTRAL_RESET_GENERATION_KEY,String((evt&&evt.centralResetGeneration)||0));
            }finally{state.suppress=false;}
            setStatus('Central database was reset. All local office caches were cleared. Sign in again.','warn');
            openAuth();
          });
          state.socket.on('qlog:central_restored',function(evt){
            try{state.suppress=true;clearAllCentralClientCaches();localStorage.setItem(CENTRAL_RESET_GENERATION_KEY,String((evt&&evt.centralResetGeneration)||0));}finally{state.suppress=false;}
            setStatus('Central operational backup restored. Reconnect to reload your bound profile.','warn');openAuth();
          });
          state.socket.on('connect_error',function(){/* polling fallback */});
        }catch(e){}
      };
      s.onerror=function(){state.socketScriptLoading=false;};
      document.head.appendChild(s);
    }catch(e){}
  }
  function watchProfile(){
    var scope=currentScope();
    if(!scope)return;
    if(state.activeProfileKey && state.activeProfileKey!==scopeId()&&!state.switchingProfile) switchProfile();
  }

  async function init(){
    injectUI(); patchStorage(); installSaveHooks();
    var facility=currentFacility(),inCharge=currentInCharge(),scope=currentScope();
    if(!facility||!inCharge){setStatus('Waiting for In-Charge profile…','warn');setTimeout(init,250);return;}
    state.activeFacility=facility;
    if(state.activeProfileKey && state.activeProfileKey!==scopeId() && state.token){
      // Keep the authenticated device session; switchProfile() will perform a fast server-side profile handoff.
    } else if(state.activeProfileKey && state.activeProfileKey!==scopeId()){
      state.token=''; state.activeProfileKey=''; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
    var resetRequested=!!localStorage.getItem(RESET_KEY);
    var held=localResetHeld(scope);
    var cached=hasProfileCache(scope);
    if(held){
      PROFILE_DATASETS.forEach(function(n){setDatasetLocal(n,[],false);});
    }else if(cached && !resetRequested) loadProfileCache(scope);
    else {PROFILE_DATASETS.forEach(function(n){setDatasetLocal(n,[],false);});}
    if(!navigator.onLine){setStatus(held?'Offline — device reset is held; use Rebuild when online':'Offline — '+scopeLabel()+' local data retained','warn');return;}
    if(state.token && state.activeProfileKey!==scopeId()){
      await switchProfile();
      connectSocket();
    }else if(state.token && state.activeProfileKey===scopeId()){
      state.activeScope=scope;
      localStorage.setItem('qlogCentralActiveScope',scope);
      state.pending=loadPending(scope);
      setStatus('Central '+scopeLabel()+' connection ready','warn');
      if(held){
        clearLocalResetHold(scope);
        await fullProfileReconcile(); saveProfileCache(scope);
        setStatus('Central '+scopeLabel()+' restored automatically after device reset','ok');
      }else if(resetRequested || !cached){ await fullProfileReconcile(); saveProfileCache(scope); localStorage.removeItem(RESET_KEY); }
      else { await fullProfileReconcile(); }
      connectSocket();
      try{ window.dispatchEvent(new Event('qlog:central-ready')); }catch(e){}
    }else{
      setStatus('Central profile authentication required','warn'); openAuth();
    }
    setInterval(function(){installSaveHooks();watchProfile();if(navigator.onLine){if(hasOfflineQueue(currentScope()))showOfflineReview();if(state.pending.size)sync(false);else reconcile();connectSocket();}},5000);
    window.addEventListener('online',function(){watchProfile();setStatus('Online — loading Central data for '+scopeLabel()+'…','warn');reconcile().then(function(){if(hasOfflineQueue(currentScope()))showOfflineReview();});connectSocket();});
  }

  async function lookupVisitorByQR(qr){
    var code=String(qr||'').trim();
    if(!code||!navigator.onLine)return null;
    // A QR can be scanned immediately after a cross-device/account login. Give the
    // Central authentication handoff a very short bounded window instead of
    // incorrectly treating the registered visitor as unknown.
    for(var i=0;i<6 && !state.token;i++) await new Promise(function(r){setTimeout(r,120);});
    if(!state.token)return null;
    try{
      var resp=await api('/api/visitors/lookup?qr='+encodeURIComponent(code));
      return resp&&resp.found?resp.visitor:null;
    }catch(e){ return null; }
  }

  function cachedVisitorFaces(){
    try{var v=JSON.parse(localStorage.getItem(VISITOR_FACE_CACHE_KEY)||'[]');return Array.isArray(v)?v:[];}catch(e){return [];}
  }
  function saveVisitorFaces(v){try{if(Array.isArray(v)&&v.length)localStorage.setItem(VISITOR_FACE_CACHE_KEY,JSON.stringify(v));}catch(e){}}
  async function lookupVisitorFaces(){
    var cached=cachedVisitorFaces();
    if(!navigator.onLine)return cached;
    // Never block the camera for ~10 seconds waiting for auth. A normal logged-in
    // session should already have a token; on a fast device/account handoff wait
    // only briefly, then use the last Central directory while auth finishes.
    for(var i=0;i<6 && !state.token;i++) await new Promise(function(r){setTimeout(r,200);});
    if(!state.token)return cached;
    try{
      var resp=await api('/api/visitors/faces');
      var faces=(resp&&Array.isArray(resp.visitors))?resp.visitors:[];
      if(faces.length)saveVisitorFaces(faces);
      return faces.length?faces:cached;
    }catch(e){
      if((e.status===401||e.status===403) && state.token){
        try{var retry=await api('/api/visitors/faces');var again=(retry&&Array.isArray(retry.visitors))?retry.visitors:[];if(again.length)saveVisitorFaces(again);return again.length?again:cached;}catch(_e){}
      }
      return cached;
    }
  }

  async function checkInventoryBatch(dataset,items){
    if(!state.token||!navigator.onLine) throw new Error('PROFILE_AUTH_REQUIRED');
    return await api('/api/inventory/check-batch',{method:'POST',body:JSON.stringify({dataset:dataset,items:Array.isArray(items)?items:[]})});
  }

  async function syncDatasetsNow(names){
    var wanted=(names||SYNC_KEYS).filter(function(n){return SYNC_KEYS.indexOf(n)!==-1;});
    schedule(wanted);
    clearTimeout(state.timer);
    state.timer=null;
    // Never race the normal background sync. If a sync is already in progress,
    // leave the datasets pending and let the active sync flush them.
    if(state.syncing){ return true; }
    var ok=await sync(false);
    if(!ok && navigator.onLine && state.token && state.activeProfileKey===scopeId()) {
      // One bounded retry covers the common case where a background reconciliation
      // briefly overlaps the caller's immediate sync request.
      await new Promise(function(resolve){setTimeout(resolve,350);});
      if(!state.syncing) ok=await sync(false);
    }
    return ok;
  }

  window.qlogCentralBoot=async function(){
    return await checkServerHealth(4500);
  };
  window.qlogCentralStatus=function(){return {serverReady:!!state.serverReady&&navigator.onLine,socketReady:!!(state.socket&&state.socket.connected),authenticated:!!state.token,clientId:state.sourceId,connectedClients:window.QLOG_CONNECTED_CLIENTS||0,profileKey:state.activeProfileKey};};

  window.QLogCentral={
    connect:function(){var i=document.getElementById('qlogCentralCode');if(i)connectWithCode(i.value.trim());},
    closeAuth:closeAuth,
    sync:function(){schedule(SYNC_KEYS);sync(true);if(hasOfflineQueue(currentScope()))showOfflineReview();},
    syncDatasets:function(names){schedule(names||SYNC_KEYS);sync(false);if(hasOfflineQueue(currentScope()))showOfflineReview();},
    syncDatasetsNow:syncDatasetsNow,
    resetDevice:resetThisDevice,
    rebuildMyOffice:rebuildMyOffice,
    getDeleteQueue:function(){return readDeleteQueue(currentScope());},
    newSyncId:stableId,
    getApiBase:function(){return API_BASE;},
    getSourceId:function(){return state.sourceId;},
    getFacility:function(){return state.activeFacility;},
    getProfileKey:function(){return state.activeProfileKey;},
    getProfile:function(){return {facility:currentFacility(),inCharge:currentInCharge(),profileKey:state.activeProfileKey};},
    checkInventoryBatch:checkInventoryBatch,
    lookupVisitorByQR:lookupVisitorByQR,
    lookupVisitorFaces:lookupVisitorFaces,
    profileChanged:profileChanged,
    showOfflineReview:showOfflineReview,
    closeOfflineReview:closeOfflineReview,
    discardOfflineItem:discardOfflineItem,
    syncReviewedOffline:syncReviewedOffline,
    getOfflineQueue:function(){return loadOfflineQueue(currentScope());}
  };

  function fastResumeCentral(){
    if(!navigator.onLine)return;
    checkServerHealth(2500);
    if(state.token){
      connectSocket();
      // Mobile resume is delta-only. Full state is reserved for login/profile switch/recovery.
      reconcile();
    }
  }
  window.addEventListener('load',function(){
    // Do not leave mobile/Safari waiting more than a second before Central auth/sync
    // begins. init() will retry briefly if the local role session is still loading.
    setTimeout(init,120);
    setTimeout(function(){checkServerHealth(2500);},120);
    if(!state.healthTimer){state.healthTimer=setInterval(function(){if(navigator.onLine)checkServerHealth(2000);else setServerReady(false);},20000);}
  });
  window.addEventListener('online',fastResumeCentral);
  window.addEventListener('focus',fastResumeCentral);
  window.addEventListener('pageshow',fastResumeCentral);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')fastResumeCentral();});
  window.addEventListener('offline',function(){setServerReady(false);});
})();
