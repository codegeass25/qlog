/* QLog Central policy bridge v2.0
   - Central-only Client Inventory UI
   - Explicit borrower-first Book Return
   - role visibility enforcement
*/
(function(global){
'use strict';
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function activeBook(l){return l&&(l.s==='BORROWED'||l.s==='OVERDUE');}
function makeId(){try{if(crypto&&crypto.randomUUID)return 'SYNC-'+crypto.randomUUID();}catch(e){}return 'SYNC-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);}
function borrower(id){return (global.people||[]).find(function(p){return String(p.id)===String(id);})||{};}
function bookFor(log){return (global.books||[]).find(function(b){return String(b.isbn)===String(log.b)||String(b.id)===String(log.b);})||{};}
function ensureModal(){
  if(document.getElementById('qlogBookReturnModal'))return;
  var m=document.createElement('div');m.id='qlogBookReturnModal';m.className='modal-overlay';m.style.display='none';
  m.innerHTML='<div class="modal-content" style="max-width:1050px"><div class="modal-header"><div><h3 style="margin:0">↩ Book Return</h3><div style="font-size:12px;color:#64748b;margin-top:4px">Search the borrower first, then return only books currently assigned to that borrower.</div></div><button class="modal-close" type="button" onclick="QLogBookReturn.close()">Close</button></div><div class="card" style="margin:0 0 12px"><label>Borrower ID / Name</label><input id="qlogBookReturnSearch" autocomplete="off" placeholder="Scan/type borrower ID or search name" oninput="QLogBookReturn.render()"></div><div class="full-table"><table><thead><tr><th>Borrower</th><th>ID</th><th>Book</th><th>ISBN</th><th>Qty Out</th><th>Borrowed</th><th>Due</th><th>Action</th></tr></thead><tbody id="qlogBookReturnBody"></tbody></table></div></div>';
  document.body.appendChild(m);
}
function render(){
  ensureModal();var q=String((document.getElementById('qlogBookReturnSearch')||{}).value||'').trim().toLowerCase();
  var rows=(global.borrowLogs||[]).map(function(l,i){return {l:l,i:i};}).filter(function(x){if(!activeBook(x.l))return false;var p=borrower(x.l.l),hay=[x.l.l,x.l.learnerName,p.name,x.l.b,x.l.title].join(' ').toLowerCase();return !q||hay.indexOf(q)>=0;});
  var body=document.getElementById('qlogBookReturnBody');if(!body)return;
  body.innerHTML=rows.length?rows.map(function(x){var l=x.l,b=bookFor(l),p=borrower(l.l);return '<tr><td>'+esc(l.learnerName||p.name||'')+'</td><td>'+esc(l.l)+'</td><td>'+esc(l.title||b.title||l.b)+'</td><td>'+esc(l.b)+'</td><td>'+esc(Number(l.qty)||1)+'</td><td>'+esc(l.borrowedAt||'')+'</td><td>'+esc(l.dueDateStr||'')+'</td><td><button type="button" style="background:#16a34a;padding:6px 10px" onclick="QLogBookReturn.process('+x.i+')">Return</button></td></tr>';}).join(''):'<tr><td colspan="8" style="text-align:center;color:#64748b;padding:18px">No active borrowed books match this borrower/search.</td></tr>';
}
function open(){ensureModal();document.getElementById('qlogBookReturnModal').style.display='flex';var i=document.getElementById('qlogBookReturnSearch');if(i){i.value='';setTimeout(function(){i.focus();},60);}render();}
function close(){var m=document.getElementById('qlogBookReturnModal');if(m)m.style.display='none';}
async function process(index){
  var logs=global.borrowLogs||[],log=logs[index];if(!activeBook(log)){if(global.toast)toast('This borrowing is already closed.','yellow');render();return;}
  var max=Math.max(1,Number(log.qty)||1),raw=prompt('Quantity to return (1-'+max+'):',String(max));if(raw===null)return;var qty=Number(raw);
  if(!Number.isInteger(qty)||qty<1||qty>max){alert('Enter a valid return quantity from 1 to '+max+'.');return;}
  var when=new Date(),returned={id:log.b,isbn:log.b,name:log.title||bookFor(log).title||log.b,title:log.title||bookFor(log).title||'',qty:qty,returnedAt:when.toLocaleString(),condition:'Returned'};
  if(qty===max){log.s='RETURNED';log.returnQty=max;log.returnedAt=when.toLocaleString();log.returnDate=when.toISOString().slice(0,10);log.remarks='Full Return Processed';}
  else{
    var clone=JSON.parse(JSON.stringify(log));clone._syncId=makeId();clone.s='RETURNED';clone.qty=qty;clone.returnQty=qty;clone.returnedAt=when.toLocaleString();clone.returnDate=when.toISOString().slice(0,10);clone.remarks='Partial Return Processed';
    log.qty=max-qty;log.remarks='Active balance after partial return';logs.push(clone);
  }
  try{for(var n=0;n<qty;n++)if(typeof global.triggerReservationFulfillment==='function')global.triggerReservationFulfillment(log.b);}catch(e){}
  localStorage.setItem('borrowLogs',JSON.stringify(logs));
  try{if(typeof global.logAudit==='function')global.logAudit('BOOK_RETURN','Returned '+qty+' copy/copies of '+log.b+' for '+log.l);}catch(e){}
  try{if(typeof global.renderBorrow==='function')global.renderBorrow();if(typeof global.renderBookInventory==='function')global.renderBookInventory();if(typeof global.renderReservations==='function')global.renderReservations();}catch(e){}
  if(global.QLogClearance){
    var p=borrower(log.l);
    try{var result=await global.QLogClearance.issue({module:'LIBRARY',borrowerId:log.l,borrowerName:log.learnerName||p.name,borrowerCategory:p.category||'',person:p,facilityName:'School Library',items:[returned],receivedBy:(global.currentSession&&currentSession.inCharge)||'',receivedByDesignation:(global.currentSession&&currentSession.designation)||'',autoPrint:true});if(result&&result.issued&&global.toast)toast('✅ Book returned and Library Clearance archived.','green');else if(global.toast)toast('✅ Book return saved. Clearance will be available after all borrowed books are returned.','green');}catch(e){console.error('[library-clearance]',e);if(global.toast)toast('Book return saved; Clearance archive could not be created: '+(e.message||e),'yellow');}
  }else if(global.toast)toast('✅ Book return saved.','green');
  render();
}
function isGuard(){try{return typeof global.isGuardWatchmanSession==='function'&&global.isGuardWatchmanSession();}catch(e){return /guard|watchman|security/i.test(String((global.currentSession||{}).role||''));}}
function enforce(){
  var inv=document.getElementById('clientInventoryTabBtn');if(inv)inv.style.display='none';
  var settings=document.getElementById('qlogSettingsNav');if(settings&&isGuard())settings.style.display='none';
  var cert=document.getElementById('certificatesTabBtn'),eip=document.getElementById('eipcrfTabBtn');if(isGuard()){if(cert)cert.style.display='none';if(eip)eip.style.display='none';}
  document.querySelectorAll('button').forEach(function(b){if((b.textContent||'').indexOf('Teacher Clearance')>=0)b.textContent=(b.textContent||'').replace('Teacher Clearance','Clearance');});
}
global.QLogBookReturn={open:open,close:close,render:render,process:process};
function lockCentralClientInventory(){
  if(global.showTab&&!global.showTab.__qlogCentralInventoryLocked){
    var old=global.showTab;
    var fn=function(id,btn){
      if(id==='inventory'){
        if(global.toast)global.toast('Client Inventory is managed only from the Central Hub.','blue');
        return;
      }
      return old.apply(this,arguments);
    };
    fn.__qlogCentralInventoryLocked=true;global.showTab=fn;
  }
  // Disable the legacy import entry point even if called from an old bookmark/UI.
  if(typeof global.importExcel==='function'&&!global.importExcel.__qlogCentralLocked){
    var blocked=function(){if(global.toast)global.toast('Client Inventory import is available only in the Central Hub.','blue');};blocked.__qlogCentralLocked=true;global.importExcel=blocked;
  }
}
function boot(){ensureModal();enforce();lockCentralClientInventory();setTimeout(function(){enforce();lockCentralClientInventory();},250);setTimeout(function(){enforce();lockCentralClientInventory();},1000);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
global.addEventListener('qlog:central-ready',function(){enforce();lockCentralClientInventory();render();});
global.addEventListener('qlog:central-profile-switched',enforce);
})(window);
