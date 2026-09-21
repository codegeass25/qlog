/* QLog Pro V7 - Advanced Visitor Workflow restored from the first Centralized build.
   Loaded after the base app so visitor functions below intentionally override the simplified workflow only. */
(function(){
var visitorStream = null;
var faceRecogInterval = null;
var faceApiReady = false;
var faceApiLoading = false;
var faceDescriptorCache = []; // [{name, descriptor:Float32Array}]
var _lastFaceMatchName = null;
var _stableMatchCounter = 0;
var _faceDetectErrors = 0;
var _faceLoopRunning = false;
var _isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent||'') || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
var _isMobileDevice = _isIOSDevice || /Android|Mobile/i.test(navigator.userAgent||'');
var FACE_MATCH_THRESHOLD = 0.62;   // euclidean distance (lower = more similar)
var FACE_MATCH_STABLE_FRAMES = _isMobileDevice ? 2 : 3;

/* ---------- Offline Valid ID / OCR verification configuration ----------
   All thresholds are local; nothing here contacts the network. */
var VISITOR_OCR_REQUIRED_CONFIRMATIONS = 1;   // OCR runs on ONE manually captured image (no live OCR loop)
var VISITOR_OCR_MIN_CONFIDENCE         = 45;  // PP-OCR mean confidence (0-100) on the captured image
var VISITOR_OCR_MIN_WORD_CONFIDENCE    = 45;  // per-word confidence for the name words
var VISITOR_ID_AUTOCAPTURE_INTERVAL    = 220; // ms between cheap quality checks (no OCR)
var VISITOR_ID_AUTOCAPTURE_GOOD_FRAMES = 2;   // (legacy) readiness frames — capture is manual
var VISITOR_ID_MAX_OCR_PASSES          = 5;   // internal passes over the captured image
var VISITOR_OCR_NAME_SIMILARITY        = 0.90; // required similarity between frames (0-1)
var VISITOR_ID_MIN_SHARPNESS           = 55;  // Laplacian variance (blur rejection)
var VISITOR_ID_MIN_BRIGHTNESS          = 55;
var VISITOR_ID_MAX_BRIGHTNESS          = 225;
var VISITOR_ID_MAX_GLARE               = 0.14; // fraction of blown-out pixels
var VISITOR_ID_MAX_BORDER_INK          = 0.20; // ID clipped / larger than the frame
var VISITOR_ID_MIN_CENTER_INK          = 0.015; // nothing / ID too small in the frame
var VISITOR_ID_MAX_CENTER_INK          = 0.55;
var VISITOR_ID_MAX_MOTION              = 16;  // mean abs frame difference (excessive movement)
var VISITOR_ID_MIN_DOC_SIGNALS         = 0;   // document-agnostic: ANY legitimate ID/document is accepted
var VISITOR_ID_BARCODE_CONFIRMATIONS   = 2;   // machine-readable ID payload reads required
var FACE_MODELS_URL = './models';  // local models folder ONLY (fully offline)

function _setFaceHud(state, text, confidencePct){
    var hud = document.getElementById('faceHud');
    var txt = document.getElementById('faceHudText');
    var bar = document.getElementById('faceHudBar');
    if (!hud) return;
    hud.classList.remove('detecting','matched','error');
    if (state) hud.classList.add(state);
    if (txt && text != null) txt.textContent = text;
    if (bar) bar.style.width = (confidencePct != null ? Math.max(0, Math.min(100, confidencePct)) : 0) + '%';
}

async function _loadFaceApiModels(){
    if (faceApiReady || faceApiLoading) return faceApiReady;
    if (typeof faceapi === 'undefined') {
        // Wait briefly for the local script to finish parsing
        for (var i=0;i<20 && typeof faceapi==='undefined';i++) await new Promise(function(r){setTimeout(r,150);});
    }
    if (typeof faceapi === 'undefined') {
        _setFaceHud('error', 'Face-api.js failed to load. Recognition disabled.', 0);
        return false;
    }
    faceApiLoading = true;
    _setFaceHud('detecting', 'Loading AI face models…', 15);
    // Pick a backend that needs no external files: WebGL first, pure-JS CPU as fallback.
    try{
        var tf = faceapi.tf;
        if (tf && tf.setBackend){
            var ok = false;
            try { ok = await tf.setBackend('webgl'); } catch(e){ ok = false; }
            if (!ok) { try { ok = await tf.setBackend('cpu'); } catch(e){} }
            if (tf.ready) await tf.ready();
            console.log('[face-api] tf backend:', tf.getBackend && tf.getBackend());
        }
    }catch(e){ console.warn('[face-api] backend selection failed', e); }
    var sources = [FACE_MODELS_URL];
    for (var s = 0; s < sources.length; s++) {
        try {
            var url = sources[s];
            await faceapi.nets.tinyFaceDetector.loadFromUri(url);
            _setFaceHud('detecting', 'Loading facial landmarks…', 45);
            await faceapi.nets.faceLandmark68Net.loadFromUri(url);
            _setFaceHud('detecting', 'Loading recognition network…', 75);
            await faceapi.nets.faceRecognitionNet.loadFromUri(url);
            faceApiReady = true;
            faceApiLoading = false;
            _setFaceHud('detecting', 'Ready. Look at the camera.', 100);
            return true;
        } catch (err) {
            console.warn('[face-api] models failed from', sources[s], err);
        }
    }
    faceApiLoading = false;
    _setFaceHud('error', 'Local AI face models could not be loaded. Manual entry only.', 0);
    toast('Face recognition disabled: local models missing in ./models', 'yellow');
    return false;
}

async function _rebuildFaceDescriptorCache(){
    faceDescriptorCache = [];
    if (!faceApiReady) return;
    var visitors = logs.filter(function(v){ return v.category === 'VISITOR' && v.name && (v.face || (v.faceDescriptor && v.faceDescriptor.length)); });
    // Keep most recent face per name
    var byName = {};
    for (var i=0;i<visitors.length;i++) byName[visitors[i].name] = visitors[i];
    var names = Object.keys(byName);
    for (var n=0;n<names.length;n++){
        try{
            var name = names[n];
            // Backward compatible: older records only have the face image.
            if (byName[name].faceDescriptor && byName[name].faceDescriptor.length){
                faceDescriptorCache.push({ name: name, descriptor: Float32Array.from(byName[name].faceDescriptor), nameSource: getVisitorNameSource(name) || byName[name].nameSource || null, visitorId: byName[name].id || "" });
                continue;
            }
            if (!byName[name].face) continue;
            var img = await faceapi.fetchImage(byName[name].face);
            var det = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({inputSize: 224, scoreThreshold: 0.5}))
                                  .withFaceLandmarks().withFaceDescriptor();
            if (det && det.descriptor) faceDescriptorCache.push({ name: name, descriptor: det.descriptor, nameSource: getVisitorNameSource(name) || byName[name].nameSource || null, visitorId: byName[name].id || "" });
        }catch(e){ /* ignore individual failures */ }
    }
    console.log('[face-api] descriptor cache size:', faceDescriptorCache.length);
}

function _euclidean(a, b){
    var s = 0; for (var i=0;i<a.length;i++){ var d = a[i]-b[i]; s += d*d; } return Math.sqrt(s);
}
async function _loadCentralVisitorProfile(qr){
    var code=String(qr||'').trim();
    if(!code) return null;
    _visitorCentralLookupPending=true;
    try{
        var profile = null;
        for(var wait=0; wait<6 && !profile; wait++){
            if(window.QLogCentral && typeof window.QLogCentral.lookupVisitorByQR === 'function'){
                try{ profile=await window.QLogCentral.lookupVisitorByQR(code); }catch(e){ profile=null; }
            }
            if(profile) break;
            await new Promise(function(r){setTimeout(r,180);});
        }
        if(!profile || !profile.name){
            visitorRegistrationState.centralLookupPending=false;
            return null;
        }
        _visitorCentralProfile=profile;
        visitorRegistrationState.centralProfile=profile;
        visitorRegistrationState.centralLookupPending=false;
        visitorRegistrationState.mode='RETURNING';
        var hasDescriptor=Array.isArray(profile.faceDescriptor) && profile.faceDescriptor.length>=64;
        var isIdVerified=!!profile.idVerified || String(profile.nameSource||'').toUpperCase()==='ID_OCR';
        visitorRegistrationState.centralIdVerified=isIdVerified;
        visitorRegistrationState.requiresCentralFaceMatch=hasDescriptor;
        if(hasDescriptor){
            var found=false;
            for(var i=0;i<faceDescriptorCache.length;i++){
                if(faceDescriptorCache[i].visitorId===profile.id || faceDescriptorCache[i].name===profile.name){
                    faceDescriptorCache[i]={name:profile.name,descriptor:Float32Array.from(profile.faceDescriptor),nameSource:profile.nameSource||'ID_OCR',visitorId:profile.id||code};
                    found=true; break;
                }
            }
            if(!found) faceDescriptorCache.push({name:profile.name,descriptor:Float32Array.from(profile.faceDescriptor),nameSource:profile.nameSource||'ID_OCR',visitorId:profile.id||code});
            setVisitorFlowStatus('Registered Central visitor found: <b>'+profile.name+'</b>. Please look at the camera to verify the registered face.','');
        }else if(isIdVerified){
            visitorRegistrationState.idVerified=true;
            visitorRegistrationState.identityVerificationMethod='ID_OCR';
            visitorRegistrationState.nameSource='ID_OCR';
            visitorRegistrationState.requiresIdRecheck=false;
            setVisitorName(profile.name,'Central Valid-ID registration','id');
            setVisitorFlowStatus('Registered ID-verified visitor found: <b>'+profile.name+'</b>. No ID re-check required. Please look at the camera to register/verify the face.','ok');
        }else{
            setVisitorFlowStatus('Central visitor record found. Please look at the camera for face recognition.','');
        }
        return profile;
    }catch(e){
        console.warn('[visitor] central profile lookup skipped',e);
        visitorRegistrationState.centralLookupPending=false;
        return null;
    }finally{ _visitorCentralLookupPending=false; }
}


async function _loadCentralVisitorFaces(force){
    if(!navigator.onLine || !window.QLogCentral || typeof window.QLogCentral.lookupVisitorFaces!=='function') return centralFaceDirectory;
    if(_centralFaceDirectoryPromise && !force) return _centralFaceDirectoryPromise;
    var now=Date.now();
    if(!force && centralFaceDirectory.length && (now-_centralFaceDirectoryLastAttempt)<5000) return centralFaceDirectory;
    _centralFaceDirectoryPromise=(async function(){
        _visitorCentralLookupPending=true;
        try{
            var faces=[];
            for(var attempt=0; attempt<3 && !faces.length; attempt++){
                try{ faces=await window.QLogCentral.lookupVisitorFaces(); }catch(e){ faces=[]; }
                if(faces.length) break;
                await new Promise(function(r){setTimeout(r,180);});
            }
            var next=(Array.isArray(faces)?faces:[]).filter(function(v){
                return v && v.name && Array.isArray(v.faceDescriptor) && v.faceDescriptor.length>=64;
            }).map(function(v){
                return {
                    id:v.id||'', name:String(v.name||''),
                    nameSource:v.nameSource||'MANUAL',
                    descriptor:Float32Array.from(v.faceDescriptor),
                    profileKey:v.profileKey||'', updatedAt:v.updatedAt||''
                };
            });
            if(next.length || !centralFaceDirectory.length) centralFaceDirectory=next;
            _centralFaceDirectoryLastAttempt=Date.now();
            console.log('[visitor] Central face directory:', centralFaceDirectory.length);
            return centralFaceDirectory;
        }catch(e){
            console.warn('[visitor] central face directory unavailable',e);
            return centralFaceDirectory;
        }finally{
            _visitorCentralLookupPending=false;
            _centralFaceDirectoryPromise=null;
        }
    })();
    return _centralFaceDirectoryPromise;
}

async function _faceRecognitionTick(){
    if (!faceApiReady) return;
    var video = document.getElementById('visitorCamera');
    var overlay  = document.getElementById('faceOverlay');
    if (!video || !video.videoWidth) return;

    var st = visitorRegistrationState;
    if (st.logged) return;
    if (st.centralLookupPending && !centralFaceDirectory.length){
        if (window.QLogCentral && navigator.onLine && !_centralFaceDirectoryPromise) _loadCentralVisitorFaces(false).catch(function(){});
        _setFaceHud('detecting','Checking Central visitor faces…',20);
        return;
    }
    if (!centralFaceDirectory.length && window.QLogCentral && navigator.onLine && !_centralFaceDirectoryPromise){
        _loadCentralVisitorFaces(false).catch(function(){});
    }

    var dets;
    try{
        var inputSize=_isMobileDevice?224:320;
        var threshold=_isMobileDevice?0.42:0.50;
        dets = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({inputSize:inputSize, scoreThreshold:threshold}))
                            .withFaceLandmarks().withFaceDescriptors();
        _faceDetectErrors=0;
    }catch(e){
        _faceDetectErrors++;
        console.warn('[face-api] detection failed',e);
        if(_faceDetectErrors===2){
            try{
                var tf=faceapi.tf;
                if(tf&&tf.setBackend&&tf.getBackend&&tf.getBackend()!=='cpu'){
                    await tf.setBackend('cpu'); if(tf.ready)await tf.ready();
                    _setFaceHud('detecting','Mobile compatibility mode enabled. Look at the camera.',35);
                }
            }catch(_be){}
        }
        if(_faceDetectErrors>=4)_setFaceHud('error','Face engine is retrying. Keep this page active and camera visible.',0);
        return;
    }
    dets = dets || [];

    // Draw overlay
    if (overlay){
        try{
            var ctx = overlay.getContext('2d');
            overlay.width = video.videoWidth;
            overlay.height = video.videoHeight;
            ctx.clearRect(0,0,overlay.width, overlay.height);
            ctx.lineWidth = 3;
            for (var b=0;b<dets.length;b++){
                var box = dets[b].detection.box;
                ctx.strokeStyle = (dets.length === 1) ? '#22d3ee' : '#f59e0b';
                ctx.strokeRect(box.x, box.y, box.width, box.height);
            }
        }catch(e){}
    }

    // MULTIPLE FACE PROTECTION
    if (dets.length > 1){
        st.faceDetected = false;
        st.faceDescriptor = null;
        _stableMatchCounter = 0;
        _setFaceHud('error', '\u26a0 Multiple faces detected \u2014 only the visitor should be visible.', 0);
        setVisitorFlowStatus('\u26a0 <b>MULTIPLE FACES DETECTED</b><br>Please make sure only the visitor is visible in the camera.', 'warn');
        return;
    }

    if (dets.length === 0){
        st.faceDetected = false;
        st.faceDescriptor = null;
        _stableMatchCounter = 0;
        _setFaceHud('detecting', 'Searching for a face\u2026', 20);
        if (st.reason && !st.logged){
            setVisitorFlowStatus('\u26a0 <b>FACE REQUIRED</b><br>Please look at the camera. The visitor will be logged automatically once the face is detected.', 'warn');
        }
        return;
    }

    var det = dets[0];
    st.faceDetected = true;
    st.faceDescriptor = det.descriptor;
    if (!st.faceImage) { try { st.faceImage = _captureVisitorPhoto(); } catch(e){} }

    // Match against registered visitors
    var best = {dist: Infinity, name: null, entry: null};
    var second = Infinity;
    for (var i=0;i<faceDescriptorCache.length;i++){
        var d = _euclidean(det.descriptor, faceDescriptorCache[i].descriptor);
        if (d < best.dist){ second = best.dist; best = {dist:d, name: faceDescriptorCache[i].name, entry: faceDescriptorCache[i]}; }
        else if (d < second){ second = d; }
    }

    // Cross-office identity is FACE + registered NAME from the Centralized DB.
    // QR is NOT used as the identity key and must never be required to select
    // the Central candidate. Local-office faces cannot veto a valid Central match.
    var centralAuthoritativeMatch = false;
    var centralBest = {dist:Infinity, entry:null, name:null};
    if(_visitorCentralProfile && Array.isArray(_visitorCentralProfile.faceDescriptor) && _visitorCentralProfile.faceDescriptor.length>=64){
        try{
            var directEntry={id:_visitorCentralProfile.id||'',name:_visitorCentralProfile.name||'',nameSource:_visitorCentralProfile.nameSource||'MANUAL',descriptor:Float32Array.from(_visitorCentralProfile.faceDescriptor),profileKey:_visitorCentralProfile.profileKey||''};
            centralBest={dist:_euclidean(det.descriptor,directEntry.descriptor),entry:directEntry,name:directEntry.name};
        }catch(e){}
    }
    for (var c=0;c<centralFaceDirectory.length;c++){
        var cd = _euclidean(det.descriptor, centralFaceDirectory[c].descriptor);
        if (cd < centralBest.dist) centralBest = {dist:cd, entry:centralFaceDirectory[c], name:centralFaceDirectory[c].name};
    }
    var CENTRAL_FACE_THRESHOLD = (_visitorCentralProfile && centralBest.entry && String(centralBest.entry.id||'')===String(_visitorCentralProfile.id||'')) ? 0.70 : 0.66;
    if (centralBest.entry && centralBest.dist <= CENTRAL_FACE_THRESHOLD){
        best = {dist:centralBest.dist, name:centralBest.name, entry:centralBest.entry};
        second = Infinity;
        centralAuthoritativeMatch = true;
        visitorRegistrationState.centralProfile = {
            id:centralBest.entry.id||'',
            name:centralBest.entry.name,
            nameSource:centralBest.entry.nameSource||'MANUAL',
            faceDescriptor:Array.from(centralBest.entry.descriptor),
            profileKey:centralBest.entry.profileKey||''
        };
    }

    var confidence = Math.max(0, Math.min(1, 1 - (best.dist / 0.9)));
    var margin = (second === Infinity) ? 0.1 : (second - best.dist);
    var matched = best.name && best.dist <= (centralAuthoritativeMatch ? CENTRAL_FACE_THRESHOLD : FACE_MATCH_THRESHOLD) && (centralAuthoritativeMatch || margin >= 0.04);

    if (matched){
        _stableMatchCounter++;
        _setFaceHud('detecting', 'Matching: ' + best.name + ' (' + (confidence*100).toFixed(0) + '%)', confidence*100);
        if (_stableMatchCounter >= FACE_MATCH_STABLE_FRAMES){
            if (!st.faceRecognized){
                st.faceRecognized = true;
                st.mode = 'RETURNING';
                st.faceRegistered = true;
                st.requiresCentralFaceMatch = false;
                _lastFaceMatchName = best.name;
                _setFaceHud('matched', '\u2713 ' + best.name + ' (' + (confidence*100).toFixed(0) + '%)', confidence*100);
                toast('\U0001f916 Visitor recognized: ' + best.name, 'green');
                if (!st.idVerified && !st.manualNoId){
                    var prevSource = (best.entry && best.entry.nameSource) || getVisitorNameSource(best.name);
                    if (prevSource === 'ID_OCR'){
                        // Name was originally established through a successful ID OCR:
                        // reuse it. No ID, no OCR. Preserve the verified status on
                        // this new visit so Central never gets a downgraded record.
                        st.idVerified = true;
                        st.centralIdVerified = true;
                        st.identityVerificationMethod = null;
                        st.requiresIdRecheck = false;
                        st.nameSource = 'ID_OCR';
                        setVisitorName(best.name, 'Face recognition (ID-verified profile)', 'face');
                        setVisitorFlowStatus('\u2713 Visitor identified: <b>' + best.name + '</b> (ID-verified profile). Select a <b>Reason for Visit</b> to log automatically.', 'ok');
                        try { closeValidIdScreen(); } catch(e){}
                    } else {
                        // Name was originally entered manually -> require an ID this time.
                        st.nameSource = 'MANUAL';
                        _lastFaceMatchName = best.name;
                        _requireIdRecheckForReturningVisitor();
                    }
                } else {
                    setVisitorFlowStatus('\u2713 Visitor identified: <b>' + (st.name || best.name) + '</b>. Select a <b>Reason for Visit</b> to log automatically.', 'ok');
                }
            } else {
                _setFaceHud('matched', '\u2713 ' + best.name, confidence*100);
            }
        }
    } else {
        _stableMatchCounter = 0;
        if(st.requiresCentralFaceMatch && st.centralProfile){
            _setFaceHud('error','Face does not match the registered Central visitor yet.',0);
            setVisitorFlowStatus('Registered visitor <b>'+String(st.centralProfile.name||'')+'</b> was found, but the live face has not matched. Keep the face centered and well lit. The registered Valid ID will not be requested again.','warn');
            return;
        }
        if (st.idVerified || st.manualNoId){
            _setFaceHud('detecting', 'Face captured for registration \u2014 ' + (st.name || 'new visitor'), 70);
            setVisitorFlowStatus('\u2713 Face captured for <b>' + (st.name || 'visitor') + '</b>. Select a <b>Reason for Visit</b> to log automatically.', 'ok');
        } else {
            _unknownFaceStreak++;
            _setFaceHud('detecting', 'Unrecognized visitor \u2014 identity verification required', 40);
            if (_unknownFaceStreak >= 3 && !st.idVerified && !st.manualNoId && !_idScanActive &&
                !document.getElementById('validIdOverlay').classList.contains('open')){
                setVisitorFlowStatus('Visitor not recognized. Choose <b>PRESENT VALID ID</b> or <b>NO VALID ID AVAILABLE</b>.', 'warn');
                openIdentityVerificationScreen(st.qr);
            }
        }
    }

    // Auto-log as soon as every condition is satisfied (waits automatically otherwise).
    _tryAutoLogVisitor();
}

/* Returns 'ID_OCR' | 'MANUAL' | null for an already-registered visitor name.
   Reads from the persisted visitor logs (offline storage). */
function getVisitorNameSource(name){
    var key = _normalizeNameKey(name);
    if(!key) return null;
    var src = null;
    for(var i = 0; i < logs.length; i++){
        var l = logs[i];
        if(l.category !== 'VISITOR' || !l.name) continue;
        if(_normalizeNameKey(l.name) !== key) continue;
        var ls = l.nameSource ||
                 (l.identityVerificationMethod === 'ID_OCR' ? 'ID_OCR' :
                  l.identityVerificationMethod === 'MANUAL_NO_ID' ? 'MANUAL' : null);
        if(ls === 'ID_OCR') return 'ID_OCR';   // once ID-verified, always ID-verified
        if(ls) src = ls;
    }
    return src;
}

/* Upgrades every stored record of this visitor to ID_OCR after a successful read. */
function _upgradeVisitorNameSource(name){
    var key = _normalizeNameKey(name);
    if(!key) return;
    var changed = false;
    for(var i = 0; i < logs.length; i++){
        var l = logs[i];
        if(l.category !== 'VISITOR' || !l.name) continue;
        if(_normalizeNameKey(l.name) !== key) continue;
        if(l.nameSource !== 'ID_OCR'){ l.nameSource = 'ID_OCR'; changed = true; }
    }
    if(changed){ try { saveAll(); } catch(e){} }
}

/* Recognized visitor whose name was originally typed manually:
   restart the SAME first-visit sequence (choice screen), never jump straight to ID capture. */
function _requireIdRecheckForReturningVisitor(){
    var st = visitorRegistrationState;
    st.requiresIdRecheck = true;
    st.identityVerificationMethod = null;
    st.idVerified = false;
    st.manualNoId = false;
    st.idVerificationEvidence = null;
    setVisitorName('', '', 'clear');
    openIdentityVerificationScreen(st.qr);
    setVisitorFlowStatus('Visitor recognized, but the name was previously entered manually.<br>Choose <b>PRESENT VALID ID</b> or <b>NO VALID ID AVAILABLE</b>.', 'warn');
}


/* Starts a full visitor session for a scanned unknown QR. */
function startVisitorSession(code){
    resetVisitorRegistrationState();
    visitorRegistrationState.qr=code||'';
    visitorRegistrationState.centralLookupPending=!!(window.QLogCentral && navigator.onLine);
    visitorRegistrationState.mode='NEW';
    setVisitorFlowStatus('Checking Central visitor registration and face directory…','');
    showVisitorTab(); showTab('visitors',document.querySelector('#visitorTabBtn'));
    Promise.allSettled([_loadCentralVisitorProfile(code),_loadCentralVisitorFaces(false)]).then(function(){
        visitorRegistrationState.centralLookupPending=false;
        if(visitorRegistrationState.logged) return;
        if(visitorRegistrationState.centralProfile) return;
        if(!visitorRegistrationState.faceRecognized){
            setVisitorFlowStatus(centralFaceDirectory.length ? 'Central visitor directory loaded. Please look at the camera for face recognition.' : 'No registered Central profile was found yet. Please look at the camera — identity verification will start if needed.','');
        }
    });
    startVisitorCamera();
    _visitorIdentifyDeadline=Date.now()+15000;
    setTimeout(function(){
        var st=visitorRegistrationState;
        if(st.qr!==code || st.logged) return;
        if(st.requiresCentralFaceMatch && st.centralProfile){
            setVisitorFlowStatus('Registered visitor found, but face verification is still required. Keep the face centered and well lit.','warn');
            return;
        }
        if(!st.faceRecognized && !st.idVerified && !st.manualNoId && !document.getElementById('validIdOverlay').classList.contains('open')){
            setVisitorFlowStatus('Visitor not recognized. Choose <b>PRESENT VALID ID</b> or <b>NO VALID ID AVAILABLE</b>.','warn');
            openIdentityVerificationScreen(code);
        }
    }, 15000);
    toast('Visitor QR scanned — starting verification','yellow');
}


window.addEventListener('qlog:central-ready', function(){
    _loadCentralVisitorFaces(true).catch(function(e){ console.warn('[visitor] Central face preload after auth failed', e); });
});
window.addEventListener('qlog:central-profile-switched', function(){
    centralFaceDirectory=[];
    _centralFaceDirectoryLastAttempt=0;
    _loadCentralVisitorFaces(true).catch(function(e){ console.warn('[visitor] Central face preload after office switch failed', e); });
});
window.addEventListener('qlog:visitor-directory-updated', function(){
    _centralFaceDirectoryLastAttempt=0;
    _loadCentralVisitorFaces(true).catch(function(e){ console.warn('[visitor] live Central face refresh failed',e); });
});

async function _waitForVideoReady(video,timeoutMs){
    if(video && video.readyState>=2 && video.videoWidth>0)return true;
    return await new Promise(function(resolve){
        var done=false,t=setTimeout(function(){if(done)return;done=true;resolve(false);},timeoutMs||3500);
        function ok(){if(done)return;done=true;clearTimeout(t);video.removeEventListener('loadedmetadata',ok);video.removeEventListener('canplay',ok);resolve(true);}
        video.addEventListener('loadedmetadata',ok,{once:true});video.addEventListener('canplay',ok,{once:true});
    });
}
async function _visitorFaceLoop(){
    if(_faceLoopRunning || !visitorStream || !faceApiReady)return;
    _faceLoopRunning=true;
    try{await _faceRecognitionTick();}catch(e){console.warn('[visitor] face loop',e);}finally{
        _faceLoopRunning=false;
        if(visitorStream && faceApiReady)faceRecogInterval=setTimeout(_visitorFaceLoop,_isMobileDevice?650:450);
    }
}
async function startVisitorCamera(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        toast('Camera not supported on this device/browser.', 'red'); return;
    }
    stopVisitorCamera();
    var wrap = document.getElementById('visitorVideoWrap');
    var hud  = document.getElementById('faceHud');
    if (wrap) wrap.style.display = 'inline-block';
    if (hud)  hud.style.display  = 'flex';
    var vc = document.getElementById('visitorCamera');
    try{
        var constraints={audio:false,video:{facingMode:{ideal:'user'},width:{ideal:_isMobileDevice?480:640},height:{ideal:_isMobileDevice?640:480},frameRate:{ideal:24,max:30}}};
        try{visitorStream=await navigator.mediaDevices.getUserMedia(constraints);}
        catch(firstErr){
            try{visitorStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user'}});}
            catch(secondErr){visitorStream=await navigator.mediaDevices.getUserMedia({audio:false,video:true});}
        }
        vc.setAttribute('playsinline','true');vc.setAttribute('webkit-playsinline','true');vc.muted=true;vc.autoplay=true;
        vc.srcObject = visitorStream; vc.style.display = 'block';
        try{await vc.play();}catch(playErr){console.warn('[visitor] video play retry',playErr);}
        var ready=await _waitForVideoReady(vc,4500);
        if(!ready || !vc.videoWidth)throw new Error('Camera opened but Safari/browser did not provide a playable video frame.');
        await new Promise(function(r){(window.requestAnimationFrame||function(cb){setTimeout(cb,32);})(function(){r();});});
        var modelOk=await _loadFaceApiModels();
        if (modelOk && faceApiReady){
            await _rebuildFaceDescriptorCache();
            _loadCentralVisitorFaces(true).catch(function(e){ console.warn('[visitor] Central face preload failed', e); });
            if (faceRecogInterval) clearTimeout(faceRecogInterval);
            faceRecogInterval=setTimeout(_visitorFaceLoop,120);
            _setFaceHud('detecting','Camera ready. Detecting face…',25);
        }
    }catch(err){
        console.warn('camera error', err);
        toast('Camera unavailable: ' + (err && err.message ? err.message : err), 'red');
        _setFaceHud('error', 'Camera unavailable', 0);
    }
}


function stopVisitorCamera(){
    if(visitorStream){ visitorStream.getTracks().forEach(function(t){ t.stop(); }); }
    visitorStream = null;
    var vc = document.getElementById('visitorCamera');
    if (vc){ vc.style.display='none'; vc.srcObject = null; }
    var wrap = document.getElementById('visitorVideoWrap'); if (wrap) wrap.style.display='none';
    var hud  = document.getElementById('faceHud'); if (hud) hud.style.display='none';
    if(faceRecogInterval){ clearTimeout(faceRecogInterval); faceRecogInterval = null; }
    _faceLoopRunning=false;
    _stableMatchCounter = 0; _lastFaceMatchName = null;
    try { visitorRegistrationState.faceDetected = false; visitorRegistrationState.faceDescriptor = null; } catch(e){}
}

var visitorRegistrationState = {
    mode: 'NEW',
    qr: '',
    name: '',
    /* null | 'ID_OCR' | 'MANUAL_NO_ID' */
    identityVerificationMethod: null,
    manualNoId: false,
    idVerified: false,
    idVerificationEvidence: null,
    ocrConfidence: 0,
    confirmedFrames: 0,
    idSource: '',
    idNumber: '',
    idType: '',
    dob: '',
    faceDetected: false,
    faceRegistered: false,
    faceRecognized: false,
    faceDescriptor: null,
    faceImage: '',
    reason: '',
    /* 'ID_OCR' | 'MANUAL' - how the visitor's NAME was originally established */
    nameSource: null,
    nameEdited: false,
    nameEditedAt: '',
    requiresIdRecheck: false,
    autoLogInProgress: false,
    logged: false,
    centralProfile: null,
    centralLookupPending: false,
    centralIdVerified: false,
    requiresCentralFaceMatch: false
};
var visitorAutoLogInProgress = false;
var visitorSaveInProgress = false;
var _savingVisitor = false; // legacy alias
var _visitorIdentifyDeadline = 0;
var _unknownFaceStreak = 0;
var _visitorCentralProfile = null;
var _visitorCentralLookupPending = false;
var centralFaceDirectory = []; // Centralized identity source: FACE + NAME, never QR
var _centralFaceDirectoryPromise = null;
var _centralFaceDirectoryLastAttempt = 0;

function resetVisitorRegistrationState(){
    visitorRegistrationState = {
        mode: 'NEW', qr: '', name: '',
        identityVerificationMethod: null, manualNoId: false,
        idVerified: false, idVerificationEvidence: null, ocrConfidence: 0, confirmedFrames: 0,
        idSource: '', idNumber: '',
        idType: '', dob: '', faceDetected: false, faceRegistered: false, faceRecognized: false,
        faceDescriptor: null, faceImage: '', reason: '', nameSource: null, nameEdited: false, nameEditedAt: '', requiresIdRecheck: false,
        autoLogInProgress: false, logged: false, centralProfile: null, centralLookupPending: false,
        centralIdVerified: false, requiresCentralFaceMatch: false
    };
    _resetIdVerificationRuntime();
    visitorAutoLogInProgress = false;
    _visitorIdentifyDeadline = 0;
    _unknownFaceStreak = 0;
    _visitorCentralProfile = null;
    _visitorCentralLookupPending = false;
    centralFaceDirectory = [];
    _centralFaceDirectoryPromise = null;
    _centralFaceDirectoryLastAttempt = 0;
}

function setVisitorFlowStatus(text, kind){
    var el = document.getElementById('visitorFlowStatus');
    if(!el) return;
    el.className = 'visitor-flow-status' + (kind ? ' ' + kind : '');
    el.innerHTML = text;
}

function maskIdNumber(v){
    v = (v || '').toString().replace(/\s+/g, '');
    if(!v) return '';
    if(v.length <= 4) return v;
    return new Array(v.length - 3).join('*') + '*' + v.slice(-4);
}

/* Visitor name auto-fill remains authoritative for identity verification, but the
   operator may correct the populated display name afterward. The original
   verification evidence stays preserved for audit. */
function setVisitorName(name, source, trust){
    var f = document.getElementById('visitorName');
    if(!f) return;
    var st = visitorRegistrationState;
    if(name && trust !== 'face' && trust !== 'id' && trust !== 'manual'){
        console.warn('[visitor] refused untrusted name write');
        return;
    }
    if(name && trust === 'manual' && st.identityVerificationMethod !== 'MANUAL_NO_ID'){
        console.warn('[visitor] manual name refused: MANUAL_NO_ID mode is not active');
        return;
    }
    if(name && trust === 'id' && !st.idVerified){
        console.warn('[visitor] ID name refused: ID is not verified');
        return;
    }
    f.value = name || '';
    // The trusted state must be updated BEFORE the events fire, otherwise the
    // state is updated before events so auto-fill is not misclassified as an operator correction.
    visitorRegistrationState.name = name || '';
    try {
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.dispatchEvent(new Event('change', { bubbles: true }));
    } catch(e){
        var ev = document.createEvent('Event'); ev.initEvent('input', true, true); f.dispatchEvent(ev);
        var ev2 = document.createEvent('Event'); ev2.initEvent('change', true, true); f.dispatchEvent(ev2);
    }

    var note = document.getElementById('visitorNameSource');
    if(note){
        note.style.display = name ? 'block' : 'none';
        note.textContent = (trust === 'manual' ? '\u270e Manually entered ' : '\u2713 Captured automatically ')
            + (source ? '(' + source + ')' : '');
    }
    _syncVisitorNameEditability();
}

/* The visitor name field is ALWAYS editable after it is populated.
   Auto-fill still saves the trusted source/evidence; edits are treated as an
   operator correction to the display name, not as a loss of verification. */
function _syncVisitorNameEditability(){
    var f = document.getElementById('visitorName');
    if(!f) return;
    f.removeAttribute('readonly');
    f.removeAttribute('disabled');
    f.disabled = false;
    if(visitorRegistrationState.identityVerificationMethod === 'MANUAL_NO_ID'){
        f.placeholder = 'Full Name (manual entry \u2014 no valid ID presented)';
    } else {
        f.placeholder = 'Full Name (auto-filled \u2014 correct here if needed)';
    }
}

/* Keeps state in sync with operator corrections in ALL visitor modes.
   For ID/face-verified visitors the original verification evidence remains
   intact while the corrected name becomes the visit/display name. */
function onVisitorNameInput(){
    var f = document.getElementById('visitorName');
    if(!f) return;
    var st = visitorRegistrationState;
    var next = f.value.trim();
    var changed = next !== String(st.name || '').trim();
    st.name = next;
    if(st.identityVerificationMethod === 'MANUAL_NO_ID'){
        st.manualNoId = true;
        st.idVerified = false;
        st.idVerificationEvidence = null;
    } else if(changed){
        st.nameEdited = true;
        st.nameEditedAt = new Date().toISOString();
        var note = document.getElementById('visitorNameSource');
        if(note && next){
            note.style.display = 'block';
            note.textContent = '\u270e Auto-filled name corrected by operator';
        }
    }
}

/* ====================== OFFLINE OCR (PP-OCR / PaddleOCR) ======================
   PP-OCRv4 mobile detection + English recognition running locally through
   onnxruntime-web (WASM). Models live in ./models/ppocr and are precached by
   the service worker, so OCR keeps working with no internet at all.
   Tesseract is no longer part of the pipeline. */
var _ocrEngine = null;
var _ocrEnginePromise = null;
var _ocrBusy = false;

async function _getOcrWorker(){
    if(_ocrEngine) return _ocrEngine;
    if(_ocrEnginePromise) return _ocrEnginePromise;
    if(typeof PPOCR === 'undefined' || !PPOCR.available()){
        throw new Error('Local PP-OCR engine not available');
    }
    _ocrEnginePromise = (async function(){
        await PPOCR.init();
        _ocrEngine = {
            engine: PPOCR.engineName,
            recognize: function(canvas){ return PPOCR.recognize(canvas); }
        };
        return _ocrEngine;
    })();
    try { return await _ocrEnginePromise; }
    catch(err){ _ocrEnginePromise = null; throw err; }
}

async function _terminateOcrWorker(){
    _ocrEngine = null; _ocrEnginePromise = null; _ocrBusy = false;
    try { if(typeof PPOCR !== 'undefined') PPOCR.dispose(); } catch(e){}
}

/* Crop the ID guide region, then grayscale + contrast + light sharpening. */
function _prepareIdCanvas(video){
    var canvas = document.getElementById('validIdCanvas');
    if(!canvas || !video || !video.videoWidth) return null;
    var vw = video.videoWidth, vh = video.videoHeight;
    var sx = Math.round(vw * 0.08), sw = Math.round(vw * 0.84);
    var sy = Math.round(vh * 0.16), sh = Math.round(vh * 0.68);
    var scale = Math.min(2, Math.max(1, 1000 / sw));
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    try {
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var d = img.data, i, g;
        var sum = 0, n = d.length / 4;
        for(i = 0; i < d.length; i += 4){
            g = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
            d[i] = d[i+1] = d[i+2] = g;
            sum += g;
        }
        var mean = sum / n;
        var contrast = 1.35;
        for(i = 0; i < d.length; i += 4){
            g = (d[i] - mean) * contrast + mean;
            if(g < 0) g = 0; else if(g > 255) g = 255;
            d[i] = d[i+1] = d[i+2] = g;
        }
        ctx.putImageData(img, 0, 0);
    } catch(e){ /* tainted or unsupported: OCR the raw frame instead */ }
    return canvas;
}

/* ===================== NAME EXTRACTION FROM ID TEXT ===================== */
function _normalizeOcrText(text){
    return (text || '')
        .replace(/\r/g, '\n')
        .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
        .replace(/[|_~^*<>{}\[\]]+/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

function _looksLikeDate(l){
    return /\d{1,4}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{1,4}/.test(l) ||
           /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\w*\b\s*\d{1,2}/i.test(l);
}
function _looksLikeAddress(l){
    return /\b(BRGY|BARANGAY|STREET|\bST\b|AVENUE|\bAVE\b|ROAD|\bRD\b|CITY|PROVINCE|PUROK|PRK|BLOCK|\bBLK\b|\bLOT\b|SUBD|ZONE|MUNICIPALITY|PHILIPPINES|ADDRESS)\b/i.test(l);
}
function _looksLikeIdNumber(l){
    var digits = (l.match(/\d/g) || []).length;
    return digits >= 4 || /\b(NO|NUMBER|LIC|ID|SSS|TIN|PRC|UMID|PASSPORT|SERIAL|CODE)\b\s*[:.#]?/i.test(l) && digits > 0;
}

/* Document text that can never be part of a person's name. */
var _ID_NOISE_WORDS = /\b(REPUBLIC|REPUBLIKA|PILIPINAS|PHILIPPINE|PHILIPPINES|DEPARTMENT|KAGAWARAN|OFFICE|BUREAU|AUTHORITY|AGENCY|GOVERNMENT|PAMAHALAAN|LICENSE|LISENSYA|PERMIT|IDENTIFICATION|IDENTITY|CARD|PROFESSIONAL|REGULATION|COMMISSION|BOARD|DRIVER|DRIVERS|CONDUCTOR|PASSPORT|VOTER|POSTAL|NATIONAL|PHILSYS|UMID|SSS|GSIS|TIN|PHILHEALTH|PAGIBIG|PAG-IBIG|MEMBER|EMPLOYEE|EMPLOYER|STUDENT|FACULTY|SCHOOL|UNIVERSITY|COLLEGE|ACADEMY|COMPANY|CORPORATION|INC|DIVISION|REGION|DISTRICT|ADDRESS|TIRAHAN|NATIONALITY|CITIZENSHIP|SEX|GENDER|CIVIL|STATUS|DATE|BIRTH|BIRTHDATE|BIRTHDAY|PLACE|SIGNATURE|LAGDA|EXPIRATION|EXPIRY|EXPIRES|ISSUE|ISSUED|VALID|UNTIL|BLOOD|TYPE|HEIGHT|WEIGHT|EYES|HAIR|RESTRICTION|RESTRICTIONS|CONDITIONS|LICENSE|REGISTRATION|SERIAL|NUMBER|NUMERO|CODE|AGENCY|SPECIMEN|SAMPLE|EMERGENCY|CONTACT|POSITION|DESIGNATION|DEPARTMENTAL|VALIDITY|CLASSIFICATION|PROFESSION|OCCUPATION|REMARKS|SIGNATURES|HOLDER|BEARER|PROVINCE|CITY|MUNICIPALITY|BARANGAY|ATTY|SECRETARY|ASSISTANT|ASSSTANT|UNDERSECRETARY|CHAIRMAN|CHAIRPERSON|ADMINISTRATOR|COMMISSIONER|DIRECTOR|OFFICER|OFFICIAL|LICENSEE|SIGNATORY|APPROVED|NONE|MALE|FEMALE)\b/i;

/* Label table - MOST SPECIFIC FIRST. The generic NAME label must always be
   evaluated last so it can never swallow FIRST NAME / MIDDLE NAME / LAST NAME. */
var _ID_NAME_LABEL_SRC = [
    ['full',   "COMPLETE\\s*NAME"],
    ['full',   "FULL\\s*NAME"],
    ['full',   "FULLNAME"],
    ['full',   "NAME\\s*OF\\s*(?:HOLDER|BEARER|STUDENT|EMPLOYEE|MEMBER|OWNER|APPLICANT|CARDHOLDER)"],
    ['full',   "REGISTERED\\s*NAME"],
    ['full',   "PANGALAN\\s*NG\\s*MAY[\\s-]*HAWAK"],
    ['full',   "BUONG\\s*PANGALAN"],
    ['last',   "LAST\\s*NAME"],
    ['last',   "FAMILY\\s*NAME"],
    ['last',   "SURNAME"],
    ['last',   "APELYIDO"],
    ['last',   "APELLIDOS?"],
    ['first',  "FIRST\\s*NAME"],
    ['first',  "GIVEN\\s*NAMES?"],
    ['first',  "PANGALAN"],
    ['first',  "NOMBRES?"],
    ['first',  "PR[E\\u00c9]NOMS?"],
    ['middle', "MIDDLE\\s*NAME"],
    ['middle', "GITNANG\\s*APELYIDO"],
    ['middle', "MIDDLE\\s*INITIAL"],
    ['middle', "MIDDLE"],
    ['suffix', "SUFFIX"],
    ['suffix', "EXT(?:ENSION)?\\s*NAME"],
    ['generic',"NAME"]
];
var _ID_NAME_LABEL_RE = new RegExp('\\b(?:' + _ID_NAME_LABEL_SRC.map(function(p){ return p[1]; }).join('|') + ')\\b', 'gi');
var _ID_VALID_SUFFIX = /^(JR|SR|II|III|IV|V|VI)$/i;

function _idLabelKind(raw){
    var s = (raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
    for(var i = 0; i < _ID_NAME_LABEL_SRC.length; i++){
        if(new RegExp('^(?:' + _ID_NAME_LABEL_SRC[i][1] + ')$', 'i').test(s)) return _ID_NAME_LABEL_SRC[i][0];
    }
    return 'generic';
}

/* Philippine IDs print a small triangle/arrow between the label and the value
   ("LAST NAME > LONGAKIT"). OCR reads that glyph as a stray P, D, >, » or
   a bullet. Those stand-alone markers are stripped from the FRONT of a value
   only, so a genuine middle initial ("JUAN P SANTOS") is never touched. */
var _ID_ARROW_MARKER = /^(?:[pPdDbB>\u00bb\u203a\u25b6\u25ba\u2023\u2022\u00b7\u2219\u2013\u2014\-:.,]|PP|DP|P>|B>)$/;
/* Leading-only markers: the printed triangle is also read as A, 4, 7, V or a
   dot. Stripped from the FRONT of a value only, so a genuine middle initial
   ("JUAN A SANTOS") is never touched. */
var _ID_LEAD_MARKER = /^(?:[AaVv47\u00b0]|A\.|>>|A>|\u25b8)$/;
function _idStripLeadMarkers(v){
    var parts = String(v || '').trim().split(/\s+/);
    while(parts.length > 1 && (_ID_ARROW_MARKER.test(parts[0]) || _ID_LEAD_MARKER.test(parts[0]))) parts.shift();
    while(parts.length > 1 && _ID_ARROW_MARKER.test(parts[parts.length - 1])) parts.pop();
    return parts.join(' ').trim();
}

/* Keeps letters, N-tilde, apostrophes, hyphens, commas and periods. Never
   dictionary-corrects: Philippine names are far too variable for that. */
function _idCleanNameValue(v){
    return _idStripLeadMarkers((v || '')
        .replace(/[0-9]/g, ' ')
        .replace(/[^A-Za-z\u00c0-\u017f'\-.,\s]/g, ' ')
        .replace(/\.(?=\S)/g, '. ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,.:;'\-]+|[\s,.:;'\-]+$/g, '')
        .trim());
}

function _idNameWords(v){
    return _idCleanNameValue(v)
        .replace(/,/g, ' ')
        .split(' ')
        .filter(function(w){ return w.replace(/[^A-Za-z\u00c0-\u017f]/g, '').length >= 1; });
}

/* "DELA CRUZ, JUAN PEDRO" -> "JUAN PEDRO DELA CRUZ" (nothing is dropped). */
function _idNormalizeCommaName(v){
    var parts = _idCleanNameValue(v).split(',');
    if(parts.length < 2) return _idCleanNameValue(v);
    var lastPart = parts[0].trim();
    var rest = parts.slice(1).join(' ').trim();
    if(!lastPart || !rest) return _idCleanNameValue(v).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    return (rest + ' ' + lastPart).replace(/\s+/g, ' ').trim();
}

function _idIsPlausibleName(v){
    var c = _idCleanNameValue(v);
    if(!c) return false;
    if(_ID_NOISE_WORDS.test(c)) return false;
    if(_looksLikeDate(c) || _looksLikeAddress(c)) return false;
    var letters = c.replace(/[^A-Za-z\u00c0-\u017f]/g, '').length;
    if(letters < 4) return false;
    var words = _idNameWords(c);
    if(words.length < 1 || words.length > 8) return false;
    return true;
}

/* Splits one OCR line into { kind, value } segments. Handles several labels
   sharing a single line, e.g.
   "LAST NAME LONGAKIT FIRST NAME ANGEL ROY MIDDLE NAME ANUNCIADO". */
function _idLineSegments(line){
    var segs = [], m;
    _ID_NAME_LABEL_RE.lastIndex = 0;
    var found = [];
    while((m = _ID_NAME_LABEL_RE.exec(line)) !== null){
        found.push({ label: m[0], start: m.index, end: m.index + m[0].length });
        if(_ID_NAME_LABEL_RE.lastIndex === m.index) _ID_NAME_LABEL_RE.lastIndex++;
    }
    for(var i = 0; i < found.length; i++){
        var stop = (i + 1 < found.length) ? found[i + 1].start : line.length;
        segs.push({
            kind: _idLabelKind(found[i].label),
            label: found[i].label,
            value: line.slice(found[i].end, stop).replace(/^[\s:.\-\u2013]+/, '').trim(),
            index: found[i].start
        });
    }
    return segs;
}

/* Collects every plausible name candidate from one OCR text, each with a
   structural score. Higher score = stronger structural evidence. */
function extractNameCandidatesFromIdText(text){
    var norm = _normalizeOcrText(text);
    var out = [];
    if(!norm) return out;
    var lines = norm.split('\n').map(function(l){ return l.trim(); });
    var slots = { full:'', last:'', first:'', middle:'', suffix:'' };
    var claimed = {};            // lines already consumed by the column-block pass
    var segsOf = lines.map(function(l){ return l ? _idLineSegments(l) : []; });

    function isLabelOnlyLine(i){
        var sg = segsOf[i];
        if(!sg || sg.length !== 1) return false;
        if(_idCleanNameValue(sg[0].value).length >= 2) return false;
        // the label must be practically the whole line (no stray value text)
        var residue = _idCleanNameValue(lines[i].replace(_ID_NAME_LABEL_RE, ' '));
        _ID_NAME_LABEL_RE.lastIndex = 0;
        return residue.length < 2;
    }
    function isValueLine(i){
        if(claimed[i]) return false;
        var l = lines[i];
        if(!l) return false;
        if(segsOf[i].length) return false;
        if(_looksLikeDate(l) || _looksLikeAddress(l)) return false;
        var c = _idCleanNameValue(l);
        if(!c || _ID_NOISE_WORDS.test(c)) return false;
        if(_idNameWords(c).length < 1) return false;
        return true;
    }
    function assignSlot(kind, value){
        var v = _idCleanNameValue(value);
        if(!v || _ID_NOISE_WORDS.test(v)) return;
        if(kind === 'suffix'){
            var sw = (_idNameWords(v)[0] || '').replace(/[^A-Za-z]/g, '');
            if(_ID_VALID_SUFFIX.test(sw) && !slots.suffix) slots.suffix = sw;
            return;
        }
        if(kind === 'generic' || kind === 'full'){
            if(_idIsPlausibleName(v) && !slots.full) slots.full = v;
            if(_idIsPlausibleName(v)) out.push({ name: _idNormalizeCommaName(v), score: (kind === 'full' ? 100 : 78), evidence: (kind === 'full' ? 'complete-name field' : 'NAME field') });
            return;
        }
        if(!slots[kind]) slots[kind] = v;   // first (most specific) wins
    }

    /* -----------------------------------------------------------------
       PASS 1 - two-column IDs (PRC Professional ID, PhilSys, school IDs)
       where OCR emits a block of labels first and the values afterwards:
         LAST NAME / FIRST NAME / MIDDLE NAME -> LONGAKIT / ANGEL ROY / ANUNCIADO
       Labels are paired with values IN ORDER, so the field each value
       belongs to is never guessed. This runs BEFORE the inline pass so a
       label row can never steal the value line of the next label.
       ----------------------------------------------------------------- */
    for(var ci = 0; ci < lines.length; ci++){
        if(!isLabelOnlyLine(ci)) continue;
        var kinds = [], kIdx = [], cj = ci;
        while(cj < lines.length && isLabelOnlyLine(cj)){
            kinds.push(segsOf[cj][0].kind); kIdx.push(cj); cj++;
        }
        if(kinds.length < 2){ continue; }
        var vals = [], vIdx = [], ck = cj;
        for(; ck < lines.length && vals.length < kinds.length; ck++){
            if(!lines[ck]) continue;
            if(segsOf[ck].length) break;                                  // another label row: stop
            if(_looksLikeDate(lines[ck]) || _looksLikeAddress(lines[ck])) continue;
            if(!isValueLine(ck)) continue;
            vals.push(_idCleanNameValue(lines[ck])); vIdx.push(ck);
        }
        var pairs = Math.min(kinds.length, vals.length);
        if(pairs < 2) continue;
        for(var cp = 0; cp < pairs; cp++){
            assignSlot(kinds[cp], vals[cp]);
            claimed[kIdx[cp]] = true; claimed[vIdx[cp]] = true;
        }
        for(var cq = pairs; cq < kinds.length; cq++) claimed[kIdx[cq]] = true;
        ci = cj - 1;   // continue after this label block
    }

    /* -----------------------------------------------------------------
       PASS 2 - inline labels ("LAST NAME > LONGAKIT") and single labels
       whose value sits on the next line.
       ----------------------------------------------------------------- */
    function valueAfter(i, segValue){
        if(segValue && _idCleanNameValue(segValue).length >= 2) return segValue;
        for(var k = i + 1; k < Math.min(lines.length, i + 3); k++){
            if(!lines[k]) continue;
            if(segsOf[k].length) return '';                 // next line is another label row
            if(claimed[k]) return '';                       // already paired by the column pass
            if(_looksLikeDate(lines[k]) || _looksLikeAddress(lines[k])) return '';
            var c = _idCleanNameValue(lines[k]);
            if(c.length >= 2 && !_ID_NOISE_WORDS.test(c)){ claimed[k] = true; return c; }
        }
        return '';
    }

    for(var i = 0; i < lines.length; i++){
        if(claimed[i]) continue;
        var line = lines[i];
        if(!line) continue;
        var segs = segsOf[i];
        if(!segs.length) continue;

        // A header row carrying only labels ("Last Name, First Name: Middle Name")
        // means the complete name sits on the following line.
        var hasValue = segs.some(function(s){ return _idCleanNameValue(s.value).length >= 2; });
        if(!hasValue && segs.length >= 2){
            var below = valueAfter(i, '');
            if(below && _idIsPlausibleName(below)){
                out.push({ name: _idNormalizeCommaName(below), score: 96, evidence: 'labelled complete-name row' });
            }
            continue;
        }

        for(var s = 0; s < segs.length; s++){
            var val = valueAfter(i, segs[s].value);
            if(!val) continue;
            assignSlot(segs[s].kind, val);
        }
    }

    /* -----------------------------------------------------------------
       STRUCTURED COMBINATION - whenever separate name fields exist the
       visitor name is ALWAYS rebuilt as FIRST + MIDDLE + LAST (+ SUFFIX),
       regardless of the order they were printed in on the card. Nothing
       else on the ID (registration no., dates, validity, profession,
       agency, barcode text) can reach this value.
       ----------------------------------------------------------------- */
    if(slots.first && slots.last){
        var joined = [slots.first, (slots.middle || ''), slots.last, (slots.suffix || '')]
            .join(' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
        if(_idIsPlausibleName(joined)){
            out.push({ name: joined, score: 150, structured: true, evidence: 'first + middle + last fields' });
        }
    } else if(slots.first && slots.middle && !slots.last){
        out.push({ name: (slots.first + ' ' + slots.middle).replace(/\s+/g, ' ').trim(), score: 74, evidence: 'partial name fields' });
    } else if(slots.last && slots.middle && !slots.first){
        out.push({ name: (slots.middle + ' ' + slots.last).replace(/\s+/g, ' ').trim(), score: 70, evidence: 'partial name fields' });
    } else if(slots.last && !slots.first && !slots.middle && !slots.full){
        out.push({ name: slots.last, score: 60, evidence: 'partial name fields' });
    }

    // Heuristic sweep for IDs that print the name without any usable label.
    for(var j = 0; j < lines.length; j++){
        var l0 = lines[j];
        if(!l0) continue;
        if(_looksLikeDate(l0) || _looksLikeAddress(l0)) continue;
        var digits = (l0.match(/\d/g) || []).length;
        if(digits && digits >= l0.replace(/\s/g, '').length * 0.2) continue;
        var stripped = l0.replace(_ID_NAME_LABEL_RE, ' ');
        _ID_NAME_LABEL_RE.lastIndex = 0;
        var c0 = _idCleanNameValue(stripped);
        if(!_idIsPlausibleName(c0)) continue;
        var words0 = _idNameWords(c0);
        if(words0.length < 2) continue;
        var score0 = 24 + words0.length * 4;
        var uppers = words0.filter(function(w){ return w === w.toUpperCase(); }).length;
        if(uppers === words0.length) score0 += 10;
        if(/,/.test(c0)) score0 += 8;
        if(j < 8) score0 += 3;
        out.push({ name: _idNormalizeCommaName(c0), score: score0, evidence: 'name-like line' });
    }

    // De-duplicate, keeping the strongest evidence per distinct name.
    var seen = {}, uniq = [];
    for(var u = 0; u < out.length; u++){
        var cand = out[u];
        cand.name = cand.name.replace(/\s+/g, ' ').trim();
        if(!_idIsPlausibleName(cand.name)) continue;
        var key = _normalizeNameKey(cand.name);
        if(!key) continue;
        if(seen[key] !== undefined){
            if(cand.structured) uniq[seen[key]].structured = true;
            if(cand.score > uniq[seen[key]].score){
                var wasStructured = uniq[seen[key]].structured;
                uniq[seen[key]] = cand;
                if(wasStructured) uniq[seen[key]].structured = true;
            }
        } else {
            seen[key] = uniq.length;
            uniq.push(cand);
        }
    }
    // A longer, structurally complete name beats a shorter fragment of itself.
    for(var a = 0; a < uniq.length; a++){
        for(var b = 0; b < uniq.length; b++){
            if(a === b) continue;
            var ka = _normalizeNameKey(uniq[a].name), kb = _normalizeNameKey(uniq[b].name);
            if(ka.length > kb.length && ka.indexOf(kb) !== -1) uniq[a].score += 6;
        }
    }
    uniq.sort(function(x, y){
        if(!!y.structured !== !!x.structured) return (y.structured ? 1 : 0) - (x.structured ? 1 : 0);
        return y.score - x.score;
    });
    return uniq;
}

/* Backwards-compatible single-name helper used elsewhere in the app. */
function extractNameFromIdText(text){
    var c = extractNameCandidatesFromIdText(text);
    return c.length ? _capitalizeName(c[0].name) : '';
}


function extractIdNumberFromText(text){
    var norm = _normalizeOcrText(text).toUpperCase();
    var m = norm.match(/\b(?:ID|LICENSE|LIC|NO|NUMBER|SERIAL|CRN)\b[^A-Z0-9]{0,4}([A-Z0-9\-]{5,20})/);
    if(m) return m[1];
    var lines = norm.split('\n');
    for(var i = 0; i < lines.length; i++){
        var c = lines[i].replace(/\s/g, '');
        if(/^[A-Z0-9\-]{7,20}$/.test(c) && /\d{4,}/.test(c)) return c;
    }
    return '';
}

function extractDobFromText(text){
    var norm = _normalizeOcrText(text).toUpperCase();
    var m = norm.match(/\b(?:DATE\s*OF\s*BIRTH|BIRTH\s*DATE|BIRTHDAY|DOB|D\.?O\.?B\.?)\b[^0-9A-Z]{0,6}([0-9A-Z\/\-. ]{6,20})/);
    if(m){
        var v = m[1].trim().replace(/\s{2,}/g, ' ');
        if(_looksLikeDate(v)) return v;
    }
    var d = norm.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/);
    return d ? d[1] : '';
}

/* =====================================================================
   IDENTITY VERIFICATION (fully offline)
   Stage 1  choose method  -> [PRESENT VALID ID] | [NO VALID ID AVAILABLE]
   Stage 2  ID_OCR         -> quality -> OCR -> confidence -> fields ->
                              supporting ID evidence -> multi-frame
                              consistency -> ID VERIFIED
   Stage 3  verified
   Stage 4  MANUAL_NO_ID   -> explicit manual entry by the guard/operator
   An OCR failure NEVER switches to manual entry by itself.
   ===================================================================== */
var _idStream = null;
var _idScanTimer = null;
var _idOcrTimer = null;
var _idCaptureTimer = null;
var _idGoodFrames = 0;
var _idCaptureDone = false;
var _idBarcodeDetector = null;
var _idScanActive = false;

/* runtime verification accumulators */
var _idConfirmName = '';
var _idConfirmCount = 0;
var _idConfirmSamples = [];
var _idBarcodeConfirmCount = 0;
var _idPrevGray = null;
var _idDocSignalFrames = 0;

function _resetIdVerificationRuntime(){
    _idConfirmName = '';
    _idConfirmCount = 0;
    _idConfirmSamples = [];
    _idBarcodeConfirmCount = 0;
    _idPrevGray = null;
    _idDocSignalFrames = 0;
    _updateIdConfirmProgress();
}

function _showIdStage(stage){
    var ids = { choice:'idStageChoice', scan:'idStageScan', verified:'idStageVerified', noid:'idStageNoId' };
    for(var k in ids){
        var el = document.getElementById(ids[k]);
        if(el) el.classList.toggle('active', k === stage);
    }
    var title = document.getElementById('validIdTitle');
    if(title){
        title.textContent = stage === 'noid' ? 'Manual Registration (No Valid ID)'
                          : stage === 'verified' ? 'Valid ID Verified'
                          : stage === 'scan' ? 'Valid ID Verification'
                          : 'Identity Verification';
    }
}

function _updateIdConfirmProgress(){
    _setIdProgress(0, 'Waiting for a clear ID\u2026');
}

/* ---------- Stage 1: identity verification choice ---------- */
async function openValidIdScreen(qr){ return openIdentityVerificationScreen(qr); }

function openIdentityVerificationScreen(qr){
    var ov = document.getElementById('validIdOverlay');
    if(!ov) return;
    var st = visitorRegistrationState;
    st.identityVerificationMethod = null;
    st.manualNoId = false;
    st.idVerified = false;
    st.idVerificationEvidence = null;
    st.ocrConfidence = 0;
    st.confirmedFrames = 0;
    _resetIdVerificationRuntime();
    _resetValidIdFields();
    _syncVisitorNameEditability();
    document.getElementById('validIdQr').textContent = qr || '\u2014';
    _showIdStage('choice');
    ov.classList.add('open');
    setVisitorFlowStatus('Visitor not recognized. Choose an identity verification method.', 'warn');
}

function backToIdentityChoice(){
    _stopIdCamera();
    _clearCapturedIdImage();

    var st = visitorRegistrationState;
    st.identityVerificationMethod = null;
    st.manualNoId = false;
    st.idVerified = false;
    st.idVerificationEvidence = null;
    setVisitorName('', '', 'clear');
    _resetIdVerificationRuntime();
    _resetValidIdFields();
    _syncVisitorNameEditability();
    _showIdStage('choice');
}

/* ---------- Stage 2: PRESENT VALID ID ---------- */
async function chooseValidIdVerification(){
    var st = visitorRegistrationState;
    st.identityVerificationMethod = 'ID_OCR';
    st.manualNoId = false;
    st.idVerified = false;
    st.idVerificationEvidence = null;
    setVisitorName('', '', 'clear');
    _syncVisitorNameEditability();
    _resetIdVerificationRuntime();
    _resetValidIdFields();
    _clearCapturedIdImage();
    _showIdStage('scan');
    _setIdStatus('Starting camera\u2026', '');



    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        _setIdStatus('\u26a0 Camera is not supported on this device.', 'err');
        return;
    }
    try {
        _idStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
    } catch(err){
        try {
            _idStream = await navigator.mediaDevices.getUserMedia({ video: true });
        } catch(err2){
            var msg = (err2 && err2.name === 'NotAllowedError') ? 'Camera permission denied.' :
                      (err2 && err2.name === 'NotFoundError') ? 'No camera detected.' :
                      (err2 && err2.name === 'NotReadableError') ? 'Camera is busy or unavailable.' :
                      'Camera unavailable: ' + (err2 && err2.message ? err2.message : err2);
            _setIdStatus('\u26a0 ' + msg, 'err');
            return;
        }
    }
    var v = document.getElementById('validIdCamera');
    try { v.srcObject = _idStream; } catch(e){ _setIdStatus('\u26a0 Invalid camera stream.', 'err'); return; }
    _idScanActive = true;
    _setIdStatus('READING VALID ID\u2026 keep the ID inside the frame and hold it steady.', '');

    if(!_idBarcodeDetector && typeof window.BarcodeDetector !== 'undefined'){
        try {
            var supported = [];
            try { supported = await window.BarcodeDetector.getSupportedFormats(); } catch(e){ supported = []; }
            var wanted = ['pdf417', 'qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'data_matrix'].filter(function(f){
                return !supported.length || supported.indexOf(f) !== -1;
            });
            _idBarcodeDetector = new window.BarcodeDetector(wanted.length ? { formats: wanted } : undefined);
        } catch(e){ _idBarcodeDetector = null; }
    }

    if(_idScanTimer) clearInterval(_idScanTimer);
    _idScanTimer = setInterval(_idBarcodeTick, 400);
    // NO live OCR. Only a cheap quality check; the operator captures manually.
    _idGoodFrames = 0;
    _idCaptureDone = false;
    if(_idCaptureTimer) clearInterval(_idCaptureTimer);
    _idCaptureTimer = setInterval(_idAutoCaptureTick, VISITOR_ID_AUTOCAPTURE_INTERVAL);
    // Warm the local OCR worker up front so the capture -> OCR step is instant.
    _getOcrWorker().catch(function(e){ console.warn('[OCR] worker init failed', e && e.message); });
}

/* ---------- Stage 4: NO VALID ID AVAILABLE (explicit operator choice) ---------- */
function chooseNoValidId(){
    _stopIdCamera();
    _clearCapturedIdImage();

    var st = visitorRegistrationState;
    st.identityVerificationMethod = 'MANUAL_NO_ID';
    st.manualNoId = true;
    st.idVerified = false;
    st.nameSource = 'MANUAL';
    st.idVerificationEvidence = null;
    st.idNumber = '';
    st.idType = '';
    st.dob = '';
    st.idSource = '';
    st.ocrConfidence = 0;
    st.confirmedFrames = 0;
    _resetIdVerificationRuntime();
    _resetValidIdFields();
    setVisitorName('', '', 'clear');
    _syncVisitorNameEditability();
    _showIdStage('noid');
    var f = document.getElementById('noIdVisitorName');
    if(f){ f.value = ''; setTimeout(function(){ try { f.focus(); } catch(e){} }, 60); }
    setVisitorFlowStatus('NO VALID ID PRESENTED \u2014 manual registration. Enter the visitor\u2019s complete name.', 'warn');
}

function confirmNoIdManualEntry(){
    var st = visitorRegistrationState;
    if(st.identityVerificationMethod !== 'MANUAL_NO_ID'){
        toast('\u274c Manual entry is not active.', 'red'); return;
    }
    var f = document.getElementById('noIdVisitorName');
    var name = ((f && f.value) || '').replace(/\s+/g, ' ').trim();
    var letters = name.replace(/[^A-Za-z\u00d1\u00f1]/g, '').length;
    if(letters < 4 || name.split(' ').length < 2){
        toast('\u274c Please enter the visitor\u2019s complete name (first and last name).', 'red');
        return;
    }
    st.manualNoId = true;
    st.idVerified = false;
    st.nameSource = 'MANUAL';
    st.idVerificationEvidence = null;
    setVisitorName(_capitalizeName(name), 'Manual entry \u2014 no ID presented', 'manual');
    closeValidIdScreen();
    setVisitorFlowStatus('\u270e Manual registration for <b>' + st.name +
        '</b> (NO VALID ID PRESENTED). Please look at the camera and select a <b>Reason for Visit</b>.', 'warn');
    toast('\u270e Manual (no ID) registration: ' + st.name, 'yellow');
    _tryAutoLogVisitor();
}

/* ---------- shared UI helpers ---------- */
function _resetValidIdFields(){
    var map = { validIdName:'\u2014', validIdSource:'\u2014', validIdConfidence:'\u2014' };
    for(var k in map){ var el = document.getElementById(k); if(el) el.textContent = map[k]; }
    _updateIdConfirmProgress();
}

function _setIdStatus(text, kind){
    var el = document.getElementById('validIdStatus');
    if(!el) return;
    el.className = 'id-status' + (kind ? ' ' + kind : '');
    el.innerHTML = text;
}

/* TRY AGAIN: restarts the ID scan only. It never enables manual entry. */
/* ---------- TEMPORARY captured-ID image (memory only) ---------- */
var _idCapturedCanvas = null;     // in-memory copy of the exact captured frame
var _idCapturedUrl = '';          // object URL used only by the on-screen preview

/* Shows the EXACT captured frame that OCR will read. */
function _showCapturedIdPreview(canvas){
    var wrap = document.getElementById('idCapturedWrap');
    var live = document.getElementById('idLiveWrap');
    var img = document.getElementById('idCapturedPreview');
    if(!wrap || !img) return;
    try {
        if(_idCapturedUrl){ URL.revokeObjectURL(_idCapturedUrl); _idCapturedUrl = ''; }
    } catch(e){}
    var done = function(src){
        img.src = src;
        wrap.classList.add('show');
        if(live) live.classList.add('hidden');
    };
    if(canvas.toBlob){
        canvas.toBlob(function(blob){
            if(!blob){ try { done(canvas.toDataURL('image/jpeg', 0.9)); } catch(e){} return; }
            _idCapturedUrl = URL.createObjectURL(blob);
            done(_idCapturedUrl);
        }, 'image/jpeg', 0.9);
    } else {
        try { done(canvas.toDataURL('image/jpeg', 0.9)); } catch(e){}
    }
}

/* Wipes every trace of the temporary captured ID image. */
function _clearCapturedIdImage(){
    var wrap = document.getElementById('idCapturedWrap');
    var live = document.getElementById('idLiveWrap');
    var img = document.getElementById('idCapturedPreview');
    if(img){ try { img.removeAttribute('src'); } catch(e){} }
    if(wrap) wrap.classList.remove('show');
    if(live) live.classList.remove('hidden');
    try { if(_idCapturedUrl) URL.revokeObjectURL(_idCapturedUrl); } catch(e){}
    _idCapturedUrl = '';
    if(_idCapturedCanvas){
        try {
            _idCapturedCanvas.getContext('2d').clearRect(0, 0, _idCapturedCanvas.width, _idCapturedCanvas.height);
            _idCapturedCanvas.width = 1; _idCapturedCanvas.height = 1;
        } catch(e){}
    }
    _idCapturedCanvas = null;
    var mb = document.getElementById('idManualFallbackBtn');
    if(mb) mb.style.display = 'none';
}

function retryIdScan(){
    var st = visitorRegistrationState;
    st.idVerified = false;
    st.idVerificationEvidence = null;
    st.idNumber = ''; st.idSource = ''; st.dob = ''; st.idType = '';
    st.ocrConfidence = 0; st.confirmedFrames = 0;
    setVisitorName('', '', 'clear');
    _resetIdVerificationRuntime();
    _resetValidIdFields();
    _clearCapturedIdImage();                       // drop the old preview first
    if(!_idStream){ chooseValidIdVerification(); return; }
    _showIdStage('scan');
    _idScanActive = true;
    _idGoodFrames = 0;
    _idCaptureDone = false;
    if(_idCaptureTimer) clearInterval(_idCaptureTimer);
    _idCaptureTimer = setInterval(_idAutoCaptureTick, VISITOR_ID_AUTOCAPTURE_INTERVAL);
    _setIdStatus('READING VALID ID\u2026 keep the ID inside the frame and hold it steady.', '');
}
/* legacy alias */
function rescanValidId(){ retryIdScan(); }

/* Explicit, unambiguous transition to MANUAL_NO_ID after an OCR failure.
   Never triggered automatically - the operator must press the button. */
function switchToManualNoId(){
    if(!confirm('Switch to NO VALID ID AVAILABLE?\n\nThis visitor will be recorded as MANUAL ENTRY \u2014 NO ID PRESENTED and will NOT be marked as ID verified.')) return;
    _clearCapturedIdImage();
    chooseNoValidId();
}

function continueAfterIdVerified(){
    var st = visitorRegistrationState;
    _clearCapturedIdImage();
    closeValidIdScreen();
    setVisitorFlowStatus('\u2713 Valid ID verified for <b>' + st.name + '</b>. Please look at the camera.', 'ok');
    _tryAutoLogVisitor();
}

function cancelValidIdVerification(){
    var ov = document.getElementById('validIdOverlay');
    var choiceEl = document.getElementById('idStageChoice');
    var onChoiceStage = !!(choiceEl && choiceEl.classList.contains('active'));

    // Cancelling a VALID ID capture (or a manual no-ID entry) must NEVER end the
    // visitor session: it returns to the very first step of the first-visit
    // sequence -> PRESENT VALID ID | NO VALID ID AVAILABLE.
    if(!onChoiceStage && ov && ov.classList.contains('open')){
        backToIdentityChoice();
        setVisitorFlowStatus('\u26a0 Verification cancelled. Choose <b>PRESENT VALID ID</b> or <b>NO VALID ID AVAILABLE</b>.', 'warn');
        toast('Verification cancelled \u2014 back to identity verification choice', 'yellow');
        return;
    }

    // Cancelling on the first step itself closes the identity verification screen.
    _clearCapturedIdImage();
    closeValidIdScreen();
    var st = visitorRegistrationState;
    if(!st.idVerified && !st.manualNoId){
        st.identityVerificationMethod = null;
        _syncVisitorNameEditability();
    }
    setVisitorFlowStatus('\u26a0 Identity verification cancelled. Re-scan the visitor QR to start again.', 'warn');
}

function _stopIdCamera(){
    _idScanActive = false;
    if(_idScanTimer){ clearInterval(_idScanTimer); _idScanTimer = null; }
    if(_idOcrTimer){ clearInterval(_idOcrTimer); _idOcrTimer = null; }
    if(_idCaptureTimer){ clearInterval(_idCaptureTimer); _idCaptureTimer = null; }
    _idGoodFrames = 0;
    if(_idStream){ try { _idStream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){} }
    _idStream = null;
    var v = document.getElementById('validIdCamera');
    if(v){ try { v.srcObject = null; } catch(e){} }
    var canvas = document.getElementById('validIdCanvas');
    if(canvas){ // discard the temporary working canvas immediately
        try { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); canvas.width = 1; canvas.height = 1; } catch(e){}
    }
    _idPrevGray = null;
    // The OCR worker is intentionally kept warm (preloaded) for the next visitor.
}

/* Stops the live camera but keeps the captured preview on screen. */
function _stopIdLiveCameraOnly(){
    _idScanActive = false;
    if(_idScanTimer){ clearInterval(_idScanTimer); _idScanTimer = null; }
    if(_idCaptureTimer){ clearInterval(_idCaptureTimer); _idCaptureTimer = null; }
    if(_idStream){ try { _idStream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){} }
    _idStream = null;
    var v = document.getElementById('validIdCamera');
    if(v){ try { v.pause(); } catch(e){} try { v.srcObject = null; } catch(e){} }
    _idPrevGray = null;
}

function closeValidIdScreen(){
    _stopIdCamera();
    _clearCapturedIdImage();
    var ov = document.getElementById('validIdOverlay');
    if(ov) ov.classList.remove('open');
}


function _idFrameCanvas(){
    var v = document.getElementById('validIdCamera');
    if(!v || !v.videoWidth) return null;
    return _prepareIdCanvas(v);
}

/* ================= IMAGE QUALITY / DOCUMENT PRESENCE CHECKS ================= */
function _idFrameMetrics(canvas){
    var out = { ok:false, reason:'', sharpness:0, brightness:0, glare:0, borderInk:0, centerInk:0, motion:0 };
    var ctx, img;
    try { ctx = canvas.getContext('2d'); img = ctx.getImageData(0, 0, canvas.width, canvas.height); }
    catch(e){ out.ok = true; out.reason = 'metrics-unavailable'; return out; } // never block if unreadable
    var w = canvas.width, h = canvas.height, d = img.data;
    var gw = 96, gh = Math.max(24, Math.round(gw * h / w));
    var gray = new Float32Array(gw * gh);
    var x, y, sx, sy, i, px;
    for(y = 0; y < gh; y++){
        sy = Math.min(h - 1, Math.round(y * h / gh));
        for(x = 0; x < gw; x++){
            sx = Math.min(w - 1, Math.round(x * w / gw));
            px = (sy * w + sx) * 4;
            gray[y * gw + x] = d[px] * 0.299 + d[px+1] * 0.587 + d[px+2] * 0.114;
        }
    }
    // brightness + glare
    var sum = 0, blown = 0;
    for(i = 0; i < gray.length; i++){ sum += gray[i]; if(gray[i] > 248) blown++; }
    out.brightness = sum / gray.length;
    out.glare = blown / gray.length;
    // sharpness: variance of the Laplacian
    var lsum = 0, lsq = 0, ln = 0, lap;
    for(y = 1; y < gh - 1; y++){
        for(x = 1; x < gw - 1; x++){
            lap = -4 * gray[y*gw+x] + gray[(y-1)*gw+x] + gray[(y+1)*gw+x] + gray[y*gw+x-1] + gray[y*gw+x+1];
            lsum += lap; lsq += lap * lap; ln++;
        }
    }
    out.sharpness = ln ? (lsq / ln - (lsum / ln) * (lsum / ln)) : 0;
    // ink distribution: border band vs centre (frame coverage / ID size)
    var bx = Math.max(2, Math.round(gw * 0.05)), by = Math.max(2, Math.round(gh * 0.05));
    var binkN = 0, bink = 0, cinkN = 0, cink = 0, dark = out.brightness * 0.62;
    for(y = 0; y < gh; y++){
        for(x = 0; x < gw; x++){
            var isBorder = (x < bx || x >= gw - bx || y < by || y >= gh - by);
            var v = gray[y*gw+x];
            if(isBorder){ binkN++; if(v < dark) bink++; }
            else { cinkN++; if(v < dark) cink++; }
        }
    }
    out.borderInk = binkN ? bink / binkN : 0;
    out.centerInk = cinkN ? cink / cinkN : 0;
    // motion between consecutive frames
    if(_idPrevGray && _idPrevGray.length === gray.length){
        var diff = 0;
        for(i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - _idPrevGray[i]);
        out.motion = diff / gray.length;
    } else {
        out.motion = 0;
    }
    _idPrevGray = gray;

    if(out.brightness < VISITOR_ID_MIN_BRIGHTNESS){ out.reason = 'too dark'; return out; }
    if(out.brightness > VISITOR_ID_MAX_BRIGHTNESS){ out.reason = 'too bright'; return out; }
    if(out.glare > VISITOR_ID_MAX_GLARE){ out.reason = 'glare on the ID'; return out; }
    if(out.sharpness < VISITOR_ID_MIN_SHARPNESS){ out.reason = 'blurry'; return out; }
    if(out.motion > VISITOR_ID_MAX_MOTION){ out.reason = 'moving'; return out; }
    if(out.borderInk > VISITOR_ID_MAX_BORDER_INK){ out.reason = 'ID is partially outside the frame or too large'; return out; }
    if(out.centerInk < VISITOR_ID_MIN_CENTER_INK){ out.reason = 'no ID detected / ID too small'; return out; }
    if(out.centerInk > VISITOR_ID_MAX_CENTER_INK){ out.reason = 'unclear image'; return out; }
    out.ok = true;
    return out;
}

/* ================= SUPPORTING ID DOCUMENT EVIDENCE ================= */
var _ID_DOC_KEYWORDS = [
    /\bREPUBLIC\s+OF\b/i, /\bPHILIPPINES?\b/i, /\bIDENTIFICATION\s+CARD\b/i, /\bIDENTITY\s+CARD\b/i,
    /\bDRIVER'?S?\s+LICENSE\b/i, /\bLICENSE\b/i, /\bPASSPORT\b/i, /\bUMID\b/i, /\bPHILSYS\b/i,
    /\bNATIONAL\s+ID\b/i, /\bPOSTAL\s+ID\b/i, /\bVOTER'?S?\b/i, /\bPRC\b/i, /\bPROFESSIONAL\s+REGULATION\b/i,
    /\bSSS\b/i, /\bGSIS\b/i, /\bTIN\b/i, /\bPHILHEALTH\b/i, /\bPAG-?IBIG\b/i,
    /\bEMPLOYEE\s+ID\b/i, /\bSTUDENT\s+ID\b/i, /\bSCHOOL\s+ID\b/i, /\bCOMPANY\s+ID\b/i,
    /\bDATE\s+OF\s+BIRTH\b/i, /\bD\.?O\.?B\b/i, /\bNATIONALITY\b/i, /\bCITIZENSHIP\b/i,
    /\bSEX\b/i, /\bBLOOD\s+TYPE\b/i, /\bHEIGHT\b/i, /\bWEIGHT\b/i, /\bSIGNATURE\b/i,
    /\bDATE\s+OF\s+ISSUE\b/i, /\bISSUED\b/i, /\bEXPIR\w+\b/i, /\bVALID\s+UNTIL\b/i,
    /\bID\s*(NO|NUMBER)\b/i, /\bCARD\s*(NO|NUMBER)\b/i, /\bSERIAL\b/i, /\bAGENCY\b/i, /\bGOVERNMENT\b/i
];

/* Counts how many independent signals say "this really is an identity document".
   A plain sheet of paper with only a name scores 0 and can never be accepted. */
function _idDocumentSignals(text, extra){
    var signals = [], i;
    var norm = _normalizeOcrText(text || '');
    var hits = 0;
    for(i = 0; i < _ID_DOC_KEYWORDS.length; i++){
        if(_ID_DOC_KEYWORDS[i].test(norm)){ hits++; }
    }
    if(hits >= 1) signals.push('document wording');
    if(hits >= 3) signals.push('multiple document fields');
    if(extra && extra.idNumber) signals.push('ID number');
    if(extra && extra.dob) signals.push('date of birth');
    if(extra && extra.barcode) signals.push('machine-readable ID payload');
    return signals;
}

/* ================= NAME CONSISTENCY ACROSS FRAMES ================= */
function _normalizeNameKey(n){
    return (n || '').toUpperCase().replace(/[^A-Z\u00d1 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function _levenshtein(a, b){
    if(a === b) return 0;
    if(!a.length) return b.length;
    if(!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for(j = 0; j <= b.length; j++) prev[j] = j;
    for(i = 1; i <= a.length; i++){
        cur[0] = i;
        for(j = 1; j <= b.length; j++){
            cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a.charAt(i-1) === b.charAt(j-1) ? 0 : 1));
        }
        for(j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}
function _nameSimilarity(a, b){
    a = _normalizeNameKey(a); b = _normalizeNameKey(b);
    if(!a || !b) return 0;
    var max = Math.max(a.length, b.length);
    return 1 - (_levenshtein(a, b) / max);
}

/* ================= BARCODE / MACHINE-READABLE ID ================= */
async function _idBarcodeTick(){
    if(!_idScanActive) return;
    if(visitorRegistrationState.identityVerificationMethod !== 'ID_OCR') return;
    var v = document.getElementById('validIdCamera');
    if(!v || !v.videoWidth) return;
    var parsed = null;
    // 1) Native BarcodeDetector (PDF417 / Code128 / Code39 / EAN / DataMatrix / QR)
    if(_idBarcodeDetector){
        try {
            var codes = await _idBarcodeDetector.detect(v);
            if(codes && codes.length){
                parsed = _parseIdPayload(codes[0].rawValue || '', codes[0].format || 'barcode');
            }
        } catch(e){ /* detector may fail on a frame; ignore */ }
    }
    // 2) Local jsQR fallback for QR-coded IDs
    if(!parsed && typeof jsQR !== 'undefined'){
        try {
            var c = document.createElement('canvas');
            c.width = Math.min(640, v.videoWidth); c.height = Math.round(c.width * v.videoHeight / v.videoWidth);
            var cx = c.getContext('2d');
            cx.drawImage(v, 0, 0, c.width, c.height);
            var img = cx.getImageData(0, 0, c.width, c.height);
            var qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if(qr && qr.data) parsed = _parseIdPayload(qr.data, 'qr_code');
        } catch(e){}
    }
    if(!parsed || !parsed.name) return;

    // Machine-readable payloads are still confirmed across several reads.
    if(_nameSimilarity(parsed.name, _idConfirmName) >= VISITOR_OCR_NAME_SIMILARITY){
        _idBarcodeConfirmCount++;
    } else {
        _idConfirmName = parsed.name;
        _idBarcodeConfirmCount = 1;
        _idConfirmCount = 0;
        _idConfirmSamples = [];
    }
    _setIdName(parsed.name);
    var srcEl = document.getElementById('validIdSource');
    if(srcEl) srcEl.textContent = parsed.source || 'Machine-readable ID';
    _setIdStatus('\u23f3 Reading machine-readable ID (' + _idBarcodeConfirmCount + '/' + VISITOR_ID_BARCODE_CONFIRMATIONS + ')\u2026', '');

    if(_idBarcodeConfirmCount >= VISITOR_ID_BARCODE_CONFIRMATIONS){
        _markIdVerified({
            name: parsed.name,
            idType: parsed.idType || 'Machine-readable ID',
            source: parsed.source || 'Camera barcode',
            confidence: 100,
            confirmedFrames: _idBarcodeConfirmCount
        });
    }
}

function _parseIdPayload(raw, format){
    if(!raw) return null;
    var out = { name: '', idNumber: '', dob: '', source: 'Camera barcode (' + format + ')', idType: format };
    // AAMVA PDF417 driver licence
    if(/DCS|DAC|DAQ|ANSI /.test(raw)){
        var last = (raw.match(/DCS([^\n\r]*)/) || [])[1] || '';
        var first = (raw.match(/DAC([^\n\r]*)/) || [])[1] || '';
        var mid = (raw.match(/DAD([^\n\r]*)/) || [])[1] || '';
        var num = (raw.match(/DAQ([^\n\r]*)/) || [])[1] || '';
        var bd = (raw.match(/DBB([^\n\r]*)/) || [])[1] || '';
        var nm = (first + ' ' + (mid && mid.trim() !== 'NONE' ? mid + ' ' : '') + last).replace(/\s+/g, ' ').trim();
        if(nm){
            out.name = _capitalizeName(nm);
            out.idNumber = num.trim();
            if(bd && bd.length >= 8) out.dob = bd.slice(4, 6) + '/' + bd.slice(6, 8) + '/' + bd.slice(0, 4);
            out.idType = 'PDF417 / AAMVA';
            return out;
        }
    }
    // Generic delimited or labelled payloads (must carry an explicit NAME field)
    var nameM = raw.match(/(?:NAME|FULLNAME|FULL_NAME)\s*[:=]\s*([^\n\r|;,]+)/i);
    if(nameM){
        out.name = _capitalizeName(nameM[1].trim());
        var idM = raw.match(/(?:ID|IDNO|ID_NO|NUMBER)\s*[:=]\s*([A-Za-z0-9\-]+)/i);
        if(idM) out.idNumber = idM[1];
        var dobM = raw.match(/(?:DOB|BIRTH|BIRTHDATE)\s*[:=]\s*([0-9\/\-.]{6,12})/i);
        if(dobM) out.dob = dobM[1];
        return out;
    }
    // No structured identity payload: never guess a name out of an arbitrary code.
    return null;
}

/* ============ MANUAL CAPTURE + INTERNAL NAME-ONLY OCR PIPELINE ============
   The live camera is NEVER OCR'd. A cheap quality check reports readiness and
   the operator manually captures the frame, and only then the captured image is processed internally
   (offline) to extract the visitor's COMPLETE NAME ONLY. The captured image
   and the raw OCR text are discarded immediately afterwards. ==================== */

function _idSnapshotFrom(canvas){
    var out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    out.getContext('2d').drawImage(canvas, 0, 0);
    return out;
}

/* The unprocessed ID-guide crop of the accepted frame. This exact image is
   both previewed to the operator and fed to every OCR variant. */
function _idRawCropCanvas(video){
    if(!video || !video.videoWidth) return null;
    var vw = video.videoWidth, vh = video.videoHeight;
    var sx = Math.round(vw * 0.08), sw = Math.round(vw * 0.84);
    var sy = Math.round(vh * 0.16), sh = Math.round(vh * 0.68);
    var scale = Math.min(2, Math.max(1, 1000 / sw));
    var c = document.createElement('canvas');
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    try {
        c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    } catch(e){ return null; }
    return c;
}

/* Grayscale + contrast stretch of the captured image. */
function _idGrayscale(ctx, w, h, contrast){
    try {
        var img = ctx.getImageData(0, 0, w, h), d = img.data, i, g, sum = 0, n = d.length / 4;
        for(i = 0; i < d.length; i += 4){
            g = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
            d[i] = d[i+1] = d[i+2] = g;
            sum += g;
        }
        if(contrast && contrast !== 1){
            var mean = sum / n;
            for(i = 0; i < d.length; i += 4){
                g = (d[i] - mean) * contrast + mean;
                if(g < 0) g = 0; else if(g > 255) g = 255;
                d[i] = d[i+1] = d[i+2] = g;
            }
        }
        ctx.putImageData(img, 0, 0);
    } catch(e){ /* tainted or unsupported: keep the raw pixels */ }
}

/* Preprocessing variants used for the internal passes (orientation-agnostic).
   Every variant is derived from the SAME captured image. */
function _idVariantCanvas(src, mode){
    var c = document.createElement('canvas'), ctx;
    if(mode === 'rot90' || mode === 'rot270'){
        c.width = src.height; c.height = src.width;
        ctx = c.getContext('2d');
        if(mode === 'rot90'){ ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); }
        else { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); }
        ctx.drawImage(src, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        _idGrayscale(ctx, c.width, c.height, 1.35);
        return c;
    }
    if(mode === 'upscale'){
        var f = Math.min(1.5, Math.max(1, 1200 / src.width));
        c.width = Math.round(src.width * f); c.height = Math.round(src.height * f);
        ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(src, 0, 0, c.width, c.height);
        _idGrayscale(ctx, c.width, c.height, 1.35);
        return c;
    }
    c.width = src.width; c.height = src.height;
    ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    if(mode === 'gray'){
        _idGrayscale(ctx, c.width, c.height, 1.35);
        return c;
    }
    if(mode === 'binary'){
        _idGrayscale(ctx, c.width, c.height, 1.2);
        try {
            var img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, i, sum = 0, n = d.length / 4;
            for(i = 0; i < d.length; i += 4) sum += d[i];
            var t = (sum / n) * 0.92;
            for(i = 0; i < d.length; i += 4){
                var v = d[i] < t ? 0 : 255;
                d[i] = d[i+1] = d[i+2] = v;
            }
            ctx.putImageData(img, 0, 0);
        } catch(e){}
    }
    return c;   // 'base' = the untouched captured image
}


/* Cheap, OCR-free quality gate. It only reports readiness — capture is MANUAL. */
function _idAutoCaptureTick(){
    if(!_idScanActive || _ocrBusy || _idCaptureDone) return;
    var st = visitorRegistrationState;
    if(st.identityVerificationMethod !== 'ID_OCR' || st.idVerified) return;
    var canvas = _idFrameCanvas();
    if(!canvas) return;
    var q = _idFrameMetrics(canvas);
    if(!q.ok){
        _idGoodFrames = 0;
        _setIdStatus('\u23f3 Align the ID inside the frame (' + q.reason + '). Press ENTER to capture.', 'warn');
        _setIdProgress(0, 'Waiting for a clear ID \u2014 press ENTER to capture');
        return;
    }
    _idGoodFrames++;
    _setIdProgress(100, '\u2713 Image looks clear \u2014 press ENTER to capture');
    _setIdStatus('\u2713 ID looks clear \u2014 press ENTER to capture and read it.', 'ok');
}

/* ============================ ENTER TO CAPTURE ============================
   The Valid ID capture screen has NO capture button. While that screen is
   active the ENTER key performs the capture, and nothing else: the event is
   swallowed so it can never submit a form or trigger an unrelated button.
   A lock prevents duplicate captures from rapid/repeated ENTER presses. */
var _idEnterLocked = false;

/* Detect real mobile/tablet profiles only. Desktop/laptop systems keep using
   the existing ENTER-to-capture behavior and never receive the new button. */
function _isMobileOrTabletDevice(){
    try {
        var ua = (navigator.userAgent || '').toLowerCase();
        var isIPadOS = /macintosh/.test(ua) && Number(navigator.maxTouchPoints || 0) > 1;
        var isIOS = /iphone|ipod/.test(ua);
        var isAndroid = /android/.test(ua);
        var isWindowsPhone = /windows phone/.test(ua);
        var isMobileUA = /mobile/.test(ua);
        var isAndroidTablet = isAndroid && !isMobileUA;
        return isIPadOS || isIOS || isAndroidTablet || isWindowsPhone || (isAndroid && isMobileUA);
    } catch(e) {
        return false;
    }
}

function _setupMobileTabletIdCapture(){
    var mobileTablet = _isMobileOrTabletDevice();
    document.body.classList.toggle('mobile-tablet-id-capture', mobileTablet);
    var btn = document.getElementById('idMobileCaptureBtn');
    var hint = document.getElementById('idCaptureHint');
    if(btn) btn.setAttribute('aria-hidden', mobileTablet ? 'false' : 'true');
    if(hint && mobileTablet){
        hint.innerHTML = 'Position the ID inside the frame and tap <b>📸 Capture ID</b>. The live camera stops on capture and the captured image is shown above. Reading happens internally and offline on that captured image only — no ID number, address or date of birth is read, shown or stored. The captured image is cleared from memory when verification finishes, is cancelled or is restarted.';
    }
}

function captureIdFromMobileButton(){
    if(!_isMobileOrTabletDevice()) return;
    if(!_idCaptureScreenActive()) return;
    if(_idCaptureDone || _ocrBusy) return;
    captureIdNow();
}

function _idCaptureScreenActive(){
    if(!_idScanActive) return false;
    if(typeof visitorRegistrationState === 'undefined') return false;
    if(visitorRegistrationState.identityVerificationMethod !== 'ID_OCR') return false;
    if(visitorRegistrationState.idVerified) return false;
    var stage = document.getElementById('idStageScan');
    if(stage && stage.offsetParent === null && stage.style.display === 'none') return false;
    return true;
}

document.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.keyCode !== 13) return;
    if(!_idCaptureScreenActive()) return;
    var t = e.target;
    if(t && (t.tagName === 'TEXTAREA')) return;   // never steal a multi-line edit
    // ENTER belongs to the ID capture only: never submit or click anything else.
    e.preventDefault();
    e.stopPropagation();
    if(typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    if(_idEnterLocked || _idCaptureDone || _ocrBusy) return;   // no duplicate captures
    _idEnterLocked = true;
    try { captureIdNow(); }
    finally { setTimeout(function(){ _idEnterLocked = false; }, 1200); }
}, true);

/* MANUAL CAPTURE. The operator decides exactly when the ID image is taken. */
function captureIdNow(){
    var st = visitorRegistrationState;
    if(_idCaptureDone || _ocrBusy) return;
    if(!_idScanActive || st.identityVerificationMethod !== 'ID_OCR'){
        _setIdStatus('\u26a0 Camera is not running. Press Re-scan ID first.', 'warn');
        return;
    }
    var video = document.getElementById('validIdCamera');
    if(!video || !video.videoWidth){
        _setIdStatus('\u26a0 Camera is not ready yet.', 'warn');
        return;
    }

    _idCaptureDone = true;
    if(_idCaptureTimer){ clearInterval(_idCaptureTimer); _idCaptureTimer = null; }

    // 1) In-memory copy of the EXACT frame the operator captured.
    var shot = _idRawCropCanvas(video) || _idSnapshotFrom(_idFrameCanvas());
    if(!shot){
        _idCaptureDone = false;
        if(!_idCaptureTimer) _idCaptureTimer = setInterval(_idAutoCaptureTick, VISITOR_ID_AUTOCAPTURE_INTERVAL);
        _setIdStatus('\u26a0 Could not capture the frame. Please try again.', 'warn');
        return;
    }
    _idCapturedCanvas = shot;

    // 2) The live camera stops right away - nothing else is filmed.
    _stopIdLiveCameraOnly();

    // 3) The operator sees the exact image that OCR is about to read.
    _showCapturedIdPreview(shot);
    _setIdStatus('\u2713 ID CAPTURED \u2014 PROCESSING OCR\u2026', 'ok');
    _setIdProgress(15, 'Reading name from captured ID\u2026');
    _setIdName('processing\u2026');
    var srcEl = document.getElementById('validIdSource');
    if(srcEl) srcEl.textContent = 'Manually captured ID \u2014 offline OCR';
    var confEl = document.getElementById('validIdConfidence');
    if(confEl) confEl.textContent = 'processing\u2026';

    // 4) OCR runs internally, offline, on the captured image only.
    _processCapturedId(shot);
}

/* Runs the internal OCR passes on the CAPTURED image only. Name-only output. */
async function _processCapturedId(shot){
    var st = visitorRegistrationState;
    if(_ocrBusy) return;
    _ocrBusy = true;
    var modes = ['base', 'upscale', 'rot90', 'rot270'];
    var maxPasses = Math.max(VISITOR_ID_MAX_OCR_PASSES, 4);
    var pool = [];          // aggregated candidates across every OCR variant
    var docSignals = [];
    var passes = 0;

    function addCandidate(cand, conf, mode){
        var key = _normalizeNameKey(cand.name);
        if(!key) return;
        for(var i = 0; i < pool.length; i++){
            if(_nameSimilarity(pool[i].name, cand.name) >= VISITOR_OCR_NAME_SIMILARITY){
                pool[i].agree++;
                if(conf > pool[i].conf) pool[i].conf = conf;
                if(cand.structured) pool[i].structured = true;
                if(cand.score > pool[i].structural){
                    pool[i].structural = cand.score;
                    pool[i].evidence = cand.evidence;
                    // Keep the most complete spelling of the same person's name
                    // (FIRST + MIDDLE + LAST beats any shorter fragment).
                    if(key.length > _normalizeNameKey(pool[i].name).length) pool[i].name = cand.name;
                }
                return;
            }
        }
        pool.push({ name: cand.name, structural: cand.score, evidence: cand.evidence, structured: !!cand.structured, conf: conf, agree: 1, mode: mode });
    }

    try {
        var worker = await _getOcrWorker();
        for(var m = 0; m < modes.length && passes < maxPasses; m++){
            if(st.identityVerificationMethod !== 'ID_OCR') break;
            passes++;
            _setIdProgress(15 + Math.round(70 * passes / Math.min(modes.length, maxPasses)),
                'Reading name from captured ID\u2026');
            var variant = _idVariantCanvas(shot, modes[m]);
            var text = '', data = {};
            try {
                var res = await worker.recognize(variant);
                data = (res && res.data) ? res.data : {};
                text = data.text || '';
            } catch(err){ console.warn('[OCR] pass failed', err && err.message); }
            finally { try { variant.width = 1; variant.height = 1; } catch(e){} }

            var meanConf = (typeof data.confidence === 'number') ? data.confidence : 0;
            // Supporting document evidence (never proof on its own).
            var sig = _idDocumentSignals(text, {});
            for(var s = 0; s < sig.length; s++){ if(docSignals.indexOf(sig[s]) === -1) docSignals.push(sig[s]); }

            var cands = extractNameCandidatesFromIdText(text).slice(0, 4);
            for(var c = 0; c < cands.length; c++){
                var wordConf = _nameWordConfidence(data, cands[c].name);
                var effConf = (wordConf === null) ? meanConf : Math.max(meanConf, wordConf);
                addCandidate(cands[c], effConf, modes[m]);
            }
            // Wipe the raw OCR text as soon as the names have been extracted.
            text = ''; data.text = ''; data.words = null;

            var lead = _bestIdCandidate(pool);
            if(lead){ _setIdName(_capitalizeName(lead.name)); _setIdConfidence(lead.conf); }
            // Stop early only once two independent variants agree on the same name:
            // a single pass can merge or split words on a slightly blurred frame.
            if(lead && lead.structural >= 96 && lead.conf >= VISITOR_OCR_MIN_CONFIDENCE && lead.agree >= 1) break;
        }
    } catch(err){
        console.warn('[OCR] engine unavailable:', err && err.message);
    } finally {
        _ocrBusy = false;
    }

    var best = _bestIdCandidate(pool);
    var accepted = false;
    if(best){
        // Structurally complete names may be accepted slightly below the raw
        // confidence floor; weak, unstructured guesses may not.
        var floor = (best.structural >= 96) ? Math.max(30, VISITOR_OCR_MIN_CONFIDENCE - 12)
                  : (best.structural >= 70) ? VISITOR_OCR_MIN_CONFIDENCE
                  : VISITOR_OCR_MIN_CONFIDENCE + 10;
        if(best.agree >= 2) floor -= 4;
        accepted = best.conf >= floor;
    }

    if(accepted){
        _idScanActive = false;
        _setIdProgress(100, '\u2713 NAME EXTRACTED');
        _setIdStatus('\u2713 NAME EXTRACTED', 'ok');
        _markIdVerified({
            name: _capitalizeName(best.name),
            idType: 'Valid ID (offline OCR)',
            source: 'Manually captured ID \u2014 offline OCR',
            confidence: Math.round(best.conf),
            confirmedFrames: passes,
            evidence: docSignals,
            structural: best.evidence
        });
        return;
    }

    // FAILURE: no name is ever invented. The captured preview STAYS visible.
    _idScanActive = false;
    _setIdName('\u2014');
    _setIdConfidence(best ? best.conf : 0);
    _setIdProgress(0, 'Name could not be read from the ID');
    _setIdStatus('\u26a0 NAME COULD NOT BE READ CONFIDENTLY<br>Could not confidently read the name. Please try again.', 'warn');
    var mb = document.getElementById('idManualFallbackBtn');
    if(mb) mb.style.display = '';
    _offerManualNameFallback('');
}

/* Ranks pooled candidates: structure first, then confidence and agreement.
   A name rebuilt from separate FIRST / MIDDLE / LAST fields ALWAYS wins over
   any single-field fragment or loose OCR line, no matter how confident the
   fragment looks. */
function _bestIdCandidate(pool){
    if(!pool || !pool.length) return null;
    var structuredOnly = pool.filter(function(p){ return p.structured; });
    var usable = structuredOnly.length ? structuredOnly : pool;
    var scored = usable.map(function(p){
        var words = _idNameWords(p.name).length;
        var alpha = p.name.replace(/[^A-Za-z\u00c0-\u017f]/g, '').length / Math.max(1, p.name.replace(/\s/g, '').length);
        var total = p.structural * 1.0
                  + p.conf * 0.45
                  + (p.agree - 1) * 14
                  + ((words >= 2 && words <= 7) ? 12 : -18)
                  + (alpha >= 0.9 ? 8 : 0);
        return { ref: p, total: total };
    });
    scored.sort(function(a, b){ return b.total - a.total; });
    return scored[0].ref;
}

/* OCR failure path: manual entry is offered (never silently applied). */
function _offerManualNameFallback(suggestion){
    var st = visitorRegistrationState;
    if(st.idVerified) return;
    setVisitorFlowStatus('\u26a0 The ID could not be read. Press <b>Re-scan ID</b>, or explicitly switch to NO VALID ID AVAILABLE.', 'warn');
    var f = document.getElementById('noIdVisitorName');
    if(f) f.value = suggestion || '';
}


function _setIdProgress(pct, label){
    var bar = document.getElementById('idConfirmBar');
    var lab = document.getElementById('idConfirmLabel');
    if(bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if(lab) lab.textContent = label;
}
function _setIdName(v){ var el = document.getElementById('validIdName'); if(el) el.textContent = v || '\u2014'; }
function _setIdConfidence(v){ var el = document.getElementById('validIdConfidence'); if(el) el.textContent = Math.round(v || 0) + '%'; }

/* Mean confidence of the PP-OCR text segments that make up the candidate name. */
function _nameWordConfidence(data, candidate){
    var words = data && data.words;
    if(!words || !words.length) return null;
    var wanted = _normalizeNameKey(candidate).split(' ').filter(function(w){ return w.length >= 2; });
    if(!wanted.length) return null;
    var total = 0, n = 0;
    for(var i = 0; i < words.length; i++){
        var t = _normalizeNameKey(words[i].text || '');
        if(!t) continue;
        if(wanted.indexOf(t) !== -1 && typeof words[i].confidence === 'number'){
            total += words[i].confidence; n++;
        }
    }
    return n ? total / n : null;
}

/* Any rejected read invalidates the running confirmation streak. */
function _noteInconsistentRead(){
    _idConfirmName = '';
    _idConfirmCount = 0;
    _idConfirmSamples = [];
    _updateIdConfirmProgress();
    var el = document.getElementById('validIdName');
    if(el) el.textContent = '\u2014';
}

/* The ONLY place allowed to declare an ID verified and to publish the name. */
function _markIdVerified(result){
    var st = visitorRegistrationState;
    if(!result || !result.name) return;
    if(st.identityVerificationMethod !== 'ID_OCR') return;
    if(st.idVerified) return;

    _idScanActive = false;
    if(_idCaptureTimer){ clearInterval(_idCaptureTimer); _idCaptureTimer = null; }
    st.idVerified = true;
    st.manualNoId = false;
    st.nameSource = 'ID_OCR';
    st.idSource = result.source || 'Camera';
    st.idNumber = '';
    st.idType = result.idType || 'Valid ID';
    st.dob = '';
    st.ocrConfidence = result.confidence || 0;
    st.confirmedFrames = result.confirmedFrames || 0;
    st.idVerificationEvidence = {
        verified: true,
        source: result.source || 'Camera OCR',
        confidence: result.confidence || 0,
        confirmedFrames: result.confirmedFrames || 0,
        name: result.name,
        idType: result.idType || 'Valid ID',
        /* SUPPORTING evidence only - never proof of a government ID by itself.
           No image, raw OCR text, ID number, address or date of birth is kept. */
        supportingSignals: (result.evidence && result.evidence.length) ? result.evidence.slice(0, 6) : [],
        nameEvidence: result.structural || '',
        verifiedAt: new Date().toISOString()
    };

    setVisitorName(result.name, 'Valid ID \u2014 verified', 'id');

    var _sv = function(id, v){ var e = document.getElementById(id); if(e) e.textContent = v; };
    _sv('idVerifiedName', result.name);
    _sv('idVerifiedType', result.idType || 'Valid ID');
    _sv('idVerifiedFrames', String(result.confirmedFrames || 0));
    _sv('idVerifiedConfidence', Math.round(result.confidence || 0) + '%');
    _upgradeVisitorNameSource(result.name);
    _setIdStatus('\u2713 NAME READ FROM VALID ID', 'ok');
    _showIdStage('verified');
    toast('\u2713 Valid ID verified: ' + result.name, 'green');

    setTimeout(function(){
        if(!visitorRegistrationState.idVerified) return; // guard re-scan
        var ov = document.getElementById('validIdOverlay');
        if(ov && ov.classList.contains('open')) continueAfterIdVerified();
    }, 2200);
}

/* ===================== AUTOMATIC VISITOR LOGGING ===================== */
function onVisitorReasonChanged(){
    var sel = document.getElementById('visitorReason');
    var other = document.getElementById('visitorReasonOther');
    if(!sel) return;
    if(sel.value === 'Others'){
        if(other) other.style.display = 'block';
    } else if(other){
        other.style.display = 'none';
    }
    var reason = sel.value.trim();
    if(reason === 'Others') reason = other ? other.value.trim() : '';
    visitorRegistrationState.reason = reason;
    if(reason) _tryAutoLogVisitor();
}

/* ================= FINAL IDENTITY VALIDATION BEFORE LOGGING =================
   Enforced in application logic (not only through the UI) so that a NEW
   visitor can never be logged by tampering with HTML fields. */
function _validateVisitorIdentityForLogging(st){
    var name = (st.name || '').trim();
    if(st.identityVerificationMethod === 'ID_OCR'){
        var ev = st.idVerificationEvidence;
        if(!st.idVerified) return { ok:false, message:'Valid ID verification is required before logging.' };
        if(!name) return { ok:false, message:'The visitor name has not been verified from the ID yet.' };
        if(!ev || ev.verified !== true || !ev.name) return { ok:false, message:'Valid ID verification evidence is missing.' };
        // The auto-filled name may be corrected after verification; ev.name remains the original verified-ID name for audit.
        if(!ev.confirmedFrames || ev.confirmedFrames < 1) return { ok:false, message:'Valid ID verification evidence is incomplete.' };
        if(st.manualNoId) return { ok:false, message:'Conflicting identity verification state. Please restart verification.' };
        return { ok:true, message:'' };
    }
    if(st.identityVerificationMethod === 'MANUAL_NO_ID'){
        if(!st.manualNoId) return { ok:false, message:'Manual (no ID) registration was not confirmed.' };
        if(st.idVerified || st.idVerificationEvidence) return { ok:false, message:'Conflicting identity verification state. Please restart verification.' };
        if(!name || name.replace(/[^A-Za-z\u00d1\u00f1]/g, '').length < 4){
            return { ok:false, message:'Please enter the visitor\u2019s complete name for the manual (no ID) registration.' };
        }
        return { ok:true, message:'' };
    }
    return { ok:false, message:'Identity verification is required: choose PRESENT VALID ID or NO VALID ID AVAILABLE.' };
}

function _tryAutoLogVisitor(){
    var st = visitorRegistrationState;
    if(st.logged || st.autoLogInProgress || visitorAutoLogInProgress) return;
    if(!st.qr){ return; }
    if(!st.reason){
        if(st.faceDetected) setVisitorFlowStatus('Face detected. Please select a <b>Reason for Visit</b> to log automatically.', '');
        return;
    }
    if(st.mode === 'NEW' || st.requiresIdRecheck){
        var g = _validateVisitorIdentityForLogging(st);
        if(!g.ok){ setVisitorFlowStatus('\u26a0 ' + g.message, 'warn'); return; }
    }
    if(!st.name){
        setVisitorFlowStatus('\u26a0 Visitor identity not established yet.', 'warn');
        return;
    }
    if(!st.faceDetected || !st.faceDescriptor){
        setVisitorFlowStatus('\u26a0 <b>FACE REQUIRED</b><br>Please look at the camera. The visitor will be logged automatically once the face is detected.', 'warn');
        return;
    }
    autoLogVisitorAfterReason();
}

async function autoLogVisitorAfterReason(){
    var st = visitorRegistrationState;
    if(st.logged || visitorAutoLogInProgress) return;
    visitorAutoLogInProgress = true;
    st.autoLogInProgress = true;
    try {
        setVisitorFlowStatus('\u23f3 Verifying visitor\u2026', '');
        // Re-validate every condition at execution time.
        if(!st.qr || !st.reason || !st.name || !st.faceDetected || !st.faceDescriptor){
            setVisitorFlowStatus('\u26a0 Visitor could not be verified yet. Waiting\u2026', 'warn');
            return;
        }
        if(st.mode === 'NEW' || st.requiresIdRecheck){
            var guard = _validateVisitorIdentityForLogging(st);
            if(!guard.ok){ setVisitorFlowStatus('\u26a0 ' + guard.message, 'warn'); return; }
        }
        if(isDupBlocked(st.qr)){ dupBlockToast(); return; }
        var already = logs.filter(function(l){
            return l.id === st.qr && l.category === 'VISITOR' && !l.timeout;
        });
        if(already.length){
            setVisitorFlowStatus('\u26a0 This visitor already has an open TIME-IN record.', 'warn');
            return;
        }

        var faceImage = st.faceImage || _captureVisitorPhoto();
        if(st.mode === 'NEW' && !st.faceRegistered){
            setVisitorFlowStatus('\u23f3 Registering face\u2026', '');
            await new Promise(function(r){ setTimeout(r, 60); });
            st.faceRegistered = true;
        }

        setVisitorFlowStatus('\u23f3 Saving visitor log\u2026', '');
        var rec = saveVisitorLog({
            id: st.qr,
            name: st.name,
            reason: st.reason,
            face: faceImage,
            faceDescriptor: st.faceDescriptor,
            idNumber: st.idNumber,
            idType: st.idType,
            idSource: st.idSource,
            mode: st.mode,
            identityVerificationMethod: st.identityVerificationMethod,
            nameSource: st.nameSource,
            requireIdentity: st.requiresIdRecheck === true,
            idVerified: st.idVerified === true,
            manualNoId: st.manualNoId === true,
            ocrConfidence: st.ocrConfidence,
            confirmedFrames: st.confirmedFrames,
            idVerificationEvidence: st.idVerificationEvidence,
            nameEdited: st.nameEdited === true,
            nameEditedAt: st.nameEditedAt || ''
        });
        if(!rec) return;

        st.logged = true;
        setVisitorFlowStatus(
            '\u2713 <b>VISITOR LOGGED</b><br>' + rec.name +
            '<br>Reason: ' + rec.reason + '<br>Time In: ' + rec.timein, 'ok');
        toast('\u2705 ' + rec.name + ' \u2014 TIME IN at ' + rec.timein, 'green');
        setTimeout(finishVisitorSession, 1800);
    } catch(err){
        console.warn('[visitor] auto-log failed', err);
        setVisitorFlowStatus('\u274c Automatic logging failed: ' + (err && err.message ? err.message : err), 'err');
    } finally {
        st.autoLogInProgress = false;
        if(!st.logged) visitorAutoLogInProgress = false;
    }
}

/* THE single authoritative visitor logging routine. */
function saveVisitorLog(data){
    if(visitorSaveInProgress) return null;
    visitorSaveInProgress = true; _savingVisitor = true;
    try {
        var name = (data.name || '').trim();
        var reason = (data.reason || '').trim();
        if(!name || !reason){ toast('\u274c Visitor information incomplete.', 'red'); return null; }
        var vid = data.id || ('VIS-' + Date.now());
        // Final authoritative identity guard (application logic, not UI).
        if((data.mode || 'NEW') === 'NEW' || data.requireIdentity === true){
            var vg = _validateVisitorIdentityForLogging({
                name: name,
                identityVerificationMethod: data.identityVerificationMethod || null,
                idVerified: data.idVerified === true,
                manualNoId: data.manualNoId === true,
                idVerificationEvidence: data.idVerificationEvidence || null
            });
            if(!vg.ok){ toast('\u274c ' + vg.message, 'red'); return null; }
        }
        if(isDupBlocked(vid)){ dupBlockToast(); return null; }

        var rec = {
            id: vid,
            name: name,
            category: 'VISITOR',
            gs: '',
            reason: reason,
            timein: new Date().toLocaleTimeString(),
            timeout: '',
            date: new Date().toLocaleDateString(),
            face: data.face || '',
            facilityName: (window.currentSession && currentSession.facility) || '',
            facilityId: (window.QLogScope && QLogScope.unitKey) ? QLogScope.unitKey((window.currentSession && currentSession.facility) || '') : '',
            _syncId: (window.QLogCentral && typeof window.QLogCentral.newSyncId==='function') ? window.QLogCentral.newSyncId() : ('SYNC-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10))
        };
        // Backward-compatible optional metadata (old records simply omit these).
        if(data.faceDescriptor){
            try { rec.faceDescriptor = Array.prototype.slice.call(data.faceDescriptor); } catch(e){}
        }
        if(data.idType)   rec.visitorIdType = data.idType;
        if(data.idSource) rec.visitorIdSource = data.idSource;
        // How the visitor's NAME was established (drives the returning-visitor flow).
        rec.nameSource = (data.nameSource === 'ID_OCR' || data.identityVerificationMethod === 'ID_OCR')
            ? 'ID_OCR'
            : (data.nameSource === 'MANUAL' || data.identityVerificationMethod === 'MANUAL_NO_ID')
              ? 'MANUAL'
              : (getVisitorNameSource(name) || 'MANUAL');
        // Auditable identity-verification method (never faked).
        if(data.identityVerificationMethod === 'MANUAL_NO_ID'){
            rec.identityVerificationMethod = 'MANUAL_NO_ID';
            rec.identityVerification = 'MANUAL ENTRY \u2014 NO ID PRESENTED';
            rec.idVerified = false;
        } else if(data.identityVerificationMethod === 'ID_OCR'){
            rec.identityVerificationMethod = 'ID_OCR';
            rec.identityVerification = 'VALID ID / OCR';
            rec.idVerified = data.idVerified === true;
            if(data.ocrConfidence) rec.idOcrConfidence = data.ocrConfidence;
            if(data.confirmedFrames) rec.idConfirmedFrames = data.confirmedFrames;
            if(data.idVerificationEvidence){
                rec.idVerificationEvidence = {
                    verified: true,
                    source: data.idVerificationEvidence.source || '',
                    confidence: data.idVerificationEvidence.confidence || 0,
                    confirmedFrames: data.idVerificationEvidence.confirmedFrames || 0,
                    idType: data.idVerificationEvidence.idType || '',
                    verifiedAt: data.idVerificationEvidence.verifiedAt || '',
                    verifiedName: data.idVerificationEvidence.name || ''
                };
            }
            if(data.nameEdited === true){
                rec.nameEdited = true;
                rec.nameEditedAt = data.nameEditedAt || new Date().toISOString();
                rec.verifiedIdName = (data.idVerificationEvidence && data.idVerificationEvidence.name) || '';
            }
        } else if(data.identityVerificationMethod){
            rec.identityVerificationMethod = String(data.identityVerificationMethod);
        }

        logs.push(rec); visitorTempLogs[vid] = rec;
        try {
            saveAll();
            // Push a newly registered visitor immediately so another office can identify the same face from Central.
            if(window.QLogCentral && navigator.onLine && typeof window.QLogCentral.syncDatasetsNow === 'function'){
                window.QLogCentral.syncDatasetsNow(['logs']).catch(function(e){ console.warn('[visitor] immediate central sync skipped', e); });
            }
        } catch(e){
            logs.pop(); delete visitorTempLogs[vid];
            toast('\u274c Failed to save visitor log: ' + (e && e.message ? e.message : e), 'red');
            return null;
        }
        markDup(vid, Date.now());
        // Keep the in-memory recognition cache current for the next visit.
        try {
            if(data.faceDescriptor){
                var replaced = false;
                for(var i = 0; i < faceDescriptorCache.length; i++){
                    if(faceDescriptorCache[i].name === name){ faceDescriptorCache[i].descriptor = data.faceDescriptor; faceDescriptorCache[i].nameSource = rec.nameSource || null; faceDescriptorCache[i].visitorId = rec.id || ""; replaced = true; break; }
                }
                if(!replaced) faceDescriptorCache.push({ name: name, descriptor: data.faceDescriptor, nameSource: rec.nameSource || null, visitorId: rec.id || "" });
            }
        } catch(e){}
        try { renderLogs(); } catch(e){}
        return rec;
    } catch(e){
        toast('\u274c Failed to save visitor log: ' + (e && e.message ? e.message : e), 'red');
        return null;
    } finally {
        visitorSaveInProgress = false; _savingVisitor = false;
    }
}

/* Full reset so nothing leaks into the next visitor session. */
function finishVisitorSession(){
    try { closeValidIdScreen(); } catch(e){}
    try { stopVisitorCamera(); } catch(e){}
    visitorRegistrationState.identityVerificationMethod = null;
    setVisitorName('', '', 'clear');
    try { _syncVisitorNameEditability(); } catch(e){}
    var sel = document.getElementById('visitorReason'); if(sel) sel.value = '';
    var oth = document.getElementById('visitorReasonOther'); if(oth){ oth.value = ''; oth.style.display = 'none'; }
    var vp = document.getElementById('visitorPhoto'); if(vp) vp.value = '';
    pendingVisitorQR = '';
    resetVisitorRegistrationState();
    setVisitorFlowStatus('Waiting for a visitor QR scan\u2026', '');
    try { hideVisitorTab(); showTab('live', document.querySelector('.nav button:nth-child(1)')); } catch(e){}
    try { renderLogs(); } catch(e){}
    try {
        var scanMsg = document.getElementById('scanMsg');
        if(scanMsg){ scanMsg.innerHTML = '\u2705 VISITOR LOGGED IN'; scanMsg.style.color = '#16a34a'; }
        if(scannerInput){ scannerInput.value = ''; if(currentScanMode === 'USB') scannerInput.focus(); }
    } catch(e){}
}

function _capitalizeName(s){
    return (s||'').toLowerCase().replace(/(^|\s|[-'])\p{L}/gu, function(c){ return c.toUpperCase(); }).trim();
}

function _captureVisitorPhoto(){
    // Fast, non-blocking-safe capture. Returns existing value if camera not ready.
    var c = document.getElementById('visitorCanvas');
    var vc = document.getElementById('visitorCamera');
    var vp = document.getElementById('visitorPhoto');
    if(!c || !vp) return '';
    try {
        var ready = vc && vc.readyState >= 2 && vc.videoWidth > 0 && !vc.paused;
        if(!ready) return vp.value || '';
        c.width = 320; c.height = 240;
        var ctx = c.getContext('2d');
        ctx.setTransform(1,0,0,1,0,0);
        ctx.drawImage(vc, 0, 0, c.width, c.height);
        vp.value = c.toDataURL('image/jpeg', 0.6);
        return vp.value;
    } catch(e){ return vp.value || ''; }
}

function _visitorExportSignatories(){
    try{
        var m=(typeof QLogExport!=='undefined'&&QLogExport.sessionMeta)?QLogExport.sessionMeta():{};
        return {preparedBy:m.preparedBy||'',preparedPosition:m.designation||'',checkedBy:m.checkedBy||'',checkedPosition:m.checkedPosition||'',approvedBy:m.approvedBy||'',approvedPosition:m.approvedPosition||''};
    }catch(e){return {};}
}
function _visitorAllExportSelection(){
    var list=Array.isArray(logs)?logs.filter(function(v){return String(v&&v.category||'').toUpperCase()==='VISITOR';}):[];
    return {recordKeys:list.map(function(v){return String(v._syncId||v.syncId||v.transactionId||'');}).filter(Boolean),scopeLabel:'All Visitor Records',filters:{}};
}
function _visitorFilteredExportSelection(){
    try{if(typeof renderReports==='function')renderReports();}catch(e){}
    var m=(typeof _currentReportModel!=='undefined')?_currentReportModel:null;
    if(!m||m.type!=='VISITOR')return _visitorAllExportSelection();
    var keys=(m.rows||[]).map(function(r){return String(r._recordKey||'');}).filter(Boolean);
    var reason=(document.getElementById('reportCategory')||{}).value||'ALL';
    var from=(document.getElementById('reportDateFrom')||{}).value||'';
    var to=(document.getElementById('reportDateTo')||{}).value||'';
    var search=(document.getElementById('reportSearch')||{}).value||'';
    var bits=[];
    if(reason&&reason!=='ALL')bits.push('Reason: '+reason);
    if(from||to)bits.push('Date: '+(from||'…')+' to '+(to||'…'));
    if(search)bits.push('Search: '+search);
    if(!bits.length)bits.push('All Visitor Records');
    return {recordKeys:keys,scopeLabel:bits.join(' · '),filters:{reason:reason,dateFrom:from,dateTo:to,search:search}};
}
async function _visitorFetchRecordHtml(selection){
    if(!window.QLogCentral||typeof QLogCentral.exportVisitorRecordsHtml!=='function')throw new Error('Connect this device to Central before exporting Visitor records.');
    var payload={recordKeys:(selection&&selection.recordKeys)||[],filters:(selection&&selection.filters)||{},scopeLabel:(selection&&selection.scopeLabel)||'Visitor Records',signatories:_visitorExportSignatories()};
    return await QLogCentral.exportVisitorRecordsHtml(payload);
}
function _visitorOpenPrintHtml(html){
    var w=window.open('','_blank','width=1200,height=900');
    if(!w)throw new Error('POPUP_BLOCKED');
    var auto='<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},300);});<\\/script>';
    w.document.open();w.document.write(String(html||'').replace('</body>',auto+'</body>'));w.document.close();w.focus();
}
function _visitorWaitImages(node){
    var imgs=Array.prototype.slice.call(node.querySelectorAll('img'));
    return Promise.all(imgs.map(function(img){return new Promise(function(resolve){if(img.complete)return resolve();img.onload=resolve;img.onerror=resolve;setTimeout(resolve,3500);});}));
}
async function _visitorSavePdfFromHtml(html,filename){
    if(typeof html2pdf==='undefined'){
        var b=new Blob([html],{type:'text/html;charset=utf-8'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=String(filename||'QLOG_Visitor_Records.pdf').replace(/\.pdf$/i,'.html');document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u);},1200);return;
    }
    var parsed=new DOMParser().parseFromString(String(html||''),'text/html');
    var wrap=document.createElement('div');wrap.style.cssText='position:absolute;left:-100000px;top:0;width:794px;background:#fff;';
    Array.prototype.forEach.call(parsed.querySelectorAll('style'),function(s){wrap.appendChild(s.cloneNode(true));});
    var content=document.createElement('div');content.innerHTML=parsed.body?parsed.body.innerHTML:'';wrap.appendChild(content);document.body.appendChild(wrap);
    await _visitorWaitImages(wrap);
    try{
        await html2pdf().from(wrap).set({margin:0,filename:filename||'QLOG_Visitor_Records.pdf',image:{type:'jpeg',quality:0.97},html2canvas:{scale:2,useCORS:true,logging:false},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'},pagebreak:{mode:['css','legacy']}}).save();
    }finally{wrap.remove();}
}
async function printVisitorRecordsFromReports(){
    try{var sel=_visitorFilteredExportSelection();if(!sel.recordKeys.length && !(sel.filters&&Object.keys(sel.filters).some(function(k){return sel.filters[k]&&sel.filters[k]!=='ALL';}))){alert('No Visitor records match the selected filters.');return;}var html=await _visitorFetchRecordHtml(sel);_visitorOpenPrintHtml(html);toast('✅ Visitor records opened for A4 printing with backend photos.','green');}catch(err){console.error('[visitor-print]',err);toast('❌ Visitor print failed: '+(err.message||err),'red');alert('Visitor print failed.\n\n'+(err.message||err));}
}
async function exportVisitorRecordsFilteredPDF(){
    try{var sel=_visitorFilteredExportSelection();if(!sel.recordKeys.length && !(sel.filters&&Object.keys(sel.filters).some(function(k){return sel.filters[k]&&sel.filters[k]!=='ALL';}))){alert('No Visitor records match the selected filters.');return;}var html=await _visitorFetchRecordHtml(sel);await _visitorSavePdfFromHtml(html,'QLOG_Visitor_Records_Filtered.pdf');toast('✅ Filtered Visitor Records PDF exported with backend photos.','green');}catch(err){console.error('[visitor-filtered-pdf]',err);toast('❌ Visitor PDF export failed: '+(err.message||err),'red');alert('Visitor PDF export failed.\n\n'+(err.message||err));}
}
async function exportVisitorPDF(){
    try{
        var sel=_visitorAllExportSelection();
        if(!sel.recordKeys.length){alert('No visitor records found.');return;}
        var html=await _visitorFetchRecordHtml(sel);
        await _visitorSavePdfFromHtml(html,'QLOG_Visitor_Records_All.pdf');
        toast('✅ All Visitor Records exported with backend photos.','green');
    }catch(err){
        console.error('[visitor-export]',err);
        var msg=(err&&err.message)?err.message:String(err||'Unknown error');
        toast('❌ Visitor record export failed: '+msg,'red');
        alert('Visitor record export failed.\n\n'+msg);
    }
}


document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible' && visitorStream){
        var v=document.getElementById('visitorCamera');
        if(v){try{var p=v.play();if(p&&p.catch)p.catch(function(){});}catch(e){}}
        if(faceApiReady && !faceRecogInterval)faceRecogInterval=setTimeout(_visitorFaceLoop,120);
    }
});

window.addEventListener('load', function(){
  try{ _setupMobileTabletIdCapture(); }catch(e){}
  // Warm the bundled/local face models before the first Visitor QR scan. This
  // does NOT request camera permission; it only removes first-scan model latency,
  // which is especially noticeable on iPhone/Android browsers.
  try{
    var warm=function(){_loadFaceApiModels().catch(function(e){console.warn('[visitor] face model warmup failed',e);});};
    if('requestIdleCallback' in window) requestIdleCallback(warm,{timeout:1800});
    else setTimeout(warm,450);
  }catch(e){}
  try{ if(window.QLogCentral && navigator.onLine) _loadCentralVisitorFaces(false).catch(function(){}); }catch(e){}
});
Object.assign(window,{
  startVisitorSession:startVisitorSession,startVisitorCamera:startVisitorCamera,stopVisitorCamera:stopVisitorCamera,
  onVisitorNameInput:onVisitorNameInput,onVisitorReasonChanged:onVisitorReasonChanged,
  chooseValidIdVerification:chooseValidIdVerification,chooseNoValidId:chooseNoValidId,
  confirmNoIdManualEntry:confirmNoIdManualEntry,backToIdentityChoice:backToIdentityChoice,
  retryIdScan:retryIdScan,rescanValidId:rescanValidId,switchToManualNoId:switchToManualNoId,
  continueAfterIdVerified:continueAfterIdVerified,cancelValidIdVerification:cancelValidIdVerification,
  captureIdFromMobileButton:captureIdFromMobileButton,captureIdNow:captureIdNow,
  finishVisitorSession:finishVisitorSession,saveVisitorLog:saveVisitorLog,exportVisitorPDF:exportVisitorPDF,printVisitorRecordsFromReports:printVisitorRecordsFromReports,exportVisitorRecordsFilteredPDF:exportVisitorRecordsFilteredPDF
});
})();
