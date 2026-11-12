/* =====================================================================
   QLog Pro - Continuous Scanning Reliability Patch (2026-11-12)
   Compatible with the existing Live Monitor, Library Borrowing, and
   Equipment Borrowing UI. No database/backend/API changes.
   Loaded after the original inline QLog scripts so their public callbacks
   (initCameraScanner, stopCameraScanner, etc.) remain available.
   ===================================================================== */
(function () {
  'use strict';

  var cfg = {
    decodeIntervalMs: 125,
    sameQrReleaseMs: 650,
    usbIdleMs: 200,
    maxDecodeWidth: 960
  };
  var camera = {
    generation: 0,
    owner: '',
    stream: null,
    frameId: null,
    retryTimer: null,
    retryCount: 0,
    deviceId: '',
    lastFrameAt: 0,
    lastCode: '',
    lastCodeAt: 0,
    audio: null
  };
  var liveReadyTimer = null;
  var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (fn) { return setTimeout(fn, 16); };
  var caf = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : clearTimeout;

  var kinds = {
    live: { tab: 'live', video: 'liveCamera', canvas: 'cameraCanvas', select: 'cameraSelect', mode: function () { return window.currentScanMode; } },
    borrow: { tab: 'borrow', video: 'borrowLiveCamera', canvas: 'borrowCameraCanvas', select: 'borrowCameraSelect', mode: function () { return window.currentBorrowScanMode; } },
    equipment: { tab: 'equipment', video: 'equipLiveCamera', canvas: 'equipCameraCanvas', select: 'equipCameraSelect', mode: function () { return window.currentEquipScanMode; } }
  };

  function isActive(kind) {
    var spec = kinds[kind], tab = spec && document.getElementById(spec.tab);
    return !!(spec && tab && tab.classList.contains('active') && !document.hidden && spec.mode() === 'CAMERA');
  }

  function liveMessage(text, color) {
    var message = document.getElementById('scanMsg');
    if (!message) return;
    message.textContent = text;
    message.style.color = color || '#16a34a';
  }

  function readyForNextLiveScan(delayMs) {
    clearTimeout(liveReadyTimer);
    liveReadyTimer = setTimeout(function () {
      if (document.getElementById('live') && document.getElementById('live').classList.contains('active')) {
        liveMessage('✓ READY FOR SCAN', '#16a34a');
      }
    }, delayMs == null ? 1900 : delayMs);
  }
  // Called only after a locally accepted attendance action.
  window.qlogLiveScanSuccess = function () { readyForNextLiveScan(1900); };

  function clearVideos() {
    ['liveCamera', 'borrowLiveCamera', 'equipLiveCamera'].forEach(function (id) {
      var v = document.getElementById(id);
      if (v && v.srcObject) {
        try { v.pause(); v.srcObject = null; } catch (ignore) {}
      }
    });
  }

  function stopEverything(resetRetries) {
    camera.generation++;
    if (camera.frameId != null) { caf(camera.frameId); camera.frameId = null; }
    if (camera.retryTimer != null) { clearTimeout(camera.retryTimer); camera.retryTimer = null; }
    if (camera.stream) {
      try { camera.stream.getTracks().forEach(function (track) { track.stop(); }); } catch (ignore) {}
    }
    clearVideos();
    camera.stream = null;
    window.activeCameraStream = null; // existing modules inspect this global
    window.cameraAnimationId = null;
    window.borrowCameraAnimationId = null;
    window.equipCameraAnimationId = null;
    camera.owner = '';
    camera.lastFrameAt = 0;
    camera.lastCode = '';
    camera.lastCodeAt = 0;
    if (resetRetries !== false) camera.retryCount = 0;
  }

  function stopOwner(kind) {
    // Important: a stale stop() call must never stop the new tab's camera.
    if (camera.owner === kind) stopEverything(true);
  }

  function playAcceptedScanBeep() {
    try {
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!camera.audio || camera.audio.state === 'closed') camera.audio = new AudioCtor();
      var context = camera.audio;
      if (context.state === 'suspended' && context.resume) context.resume().catch(function () {});
      var oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.type = 'sine'; oscillator.frequency.value = 800;
      gain.gain.setValueAtTime(0.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.10);
      oscillator.onended = function () { try { oscillator.disconnect(); gain.disconnect(); } catch (ignore) {} };
      oscillator.start(); oscillator.stop(context.currentTime + 0.11);
    } catch (err) { /* Browser may disallow audio until a user gesture. */ }
  }

  function accepted(kind, code) {
    try {
      var result;
      if (kind === 'live') result = window.processScan(code);
      else if (kind === 'borrow') result = window.processBorrowScan(code);
      else result = window.processEquipScan(code);
      return result === true;
    } catch (err) {
      console.error('[QLog continuous scanner] scan processing failed:', err);
      if (kind === 'live') {
        liveMessage('⚠️ Scan could not be processed. Ready for the next ID.', '#b45309');
        readyForNextLiveScan(2500);
      }
      return false;
    }
  }

  function decode(kind, now) {
    var spec = kinds[kind];
    var video = document.getElementById(spec.video);
    var canvas = document.getElementById(spec.canvas);
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || !video.videoHeight || typeof window.jsQR !== 'function') return;

    var scale = Math.min(1, cfg.maxDecodeWidth / video.videoWidth);
    var w = Math.max(1, Math.round(video.videoWidth * scale));
    var h = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    // Preserve the original mirrored camera reading behavior.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    var pixels = ctx.getImageData(0, 0, w, h);
    var qr = window.jsQR(pixels.data, w, h, { inversionAttempts: 'attemptBoth' });
    var value = qr && qr.data ? String(qr.data).trim() : '';
    if (!value) {
      if (now - camera.lastCodeAt > cfg.sameQrReleaseMs) camera.lastCode = '';
      return;
    }
    if (value === camera.lastCode && now - camera.lastCodeAt <= cfg.sameQrReleaseMs) {
      camera.lastCodeAt = now;
      return; // The same physical QR is still visible; do not re-submit it.
    }
    camera.lastCode = value;
    camera.lastCodeAt = now;
    if (accepted(kind, value)) playAcceptedScanBeep();
  }

  function frame(kind, generation) {
    if (generation !== camera.generation || camera.owner !== kind) return;
    camera.frameId = null;
    try {
      if (!isActive(kind)) { stopEverything(true); return; }
      if (!camera.stream || !camera.stream.active) {
        recover(kind, generation, new Error('Camera stream interrupted'));
        return;
      }
      var now = Date.now();
      if (now - camera.lastFrameAt >= cfg.decodeIntervalMs) {
        camera.lastFrameAt = now;
        decode(kind, now);
      }
    } catch (err) {
      // One QR/render failure must NEVER kill the requestAnimationFrame loop.
      console.warn('[QLog continuous scanner] recovering from frame failure:', err);
    } finally {
      if (generation === camera.generation && camera.owner === kind && isActive(kind)) {
        camera.frameId = raf(function () { frame(kind, generation); });
      }
    }
  }

  function cameraFailure(kind, err) {
    if (kind !== 'live') return;
    var reason = (err && err.name) || '';
    if (reason === 'NotAllowedError' || reason === 'PermissionDeniedError' || reason === 'SecurityError') {
      liveMessage('⚠️ Camera permission denied. Select Device Camera after allowing access.', '#b45309');
    } else {
      liveMessage('⚠️ Camera reconnecting…', '#b45309');
    }
  }

  function recover(kind, generation, err) {
    if (generation !== camera.generation || camera.owner !== kind) return;
    var reason = (err && err.name) || '';
    var device = camera.deviceId;
    var retries = camera.retryCount + 1;
    stopEverything(false);
    camera.retryCount = retries;
    cameraFailure(kind, err);
    if (!isActive(kind)) return;
    if (reason === 'NotAllowedError' || reason === 'PermissionDeniedError' || reason === 'SecurityError') return;
    camera.owner = kind;
    var recoveryGeneration = camera.generation;
    var backoff = Math.min(8000, 500 * Math.pow(2, Math.min(retries - 1, 4)));
    camera.retryTimer = setTimeout(function () {
      camera.retryTimer = null;
      if (camera.generation === recoveryGeneration && camera.owner === kind && isActive(kind)) {
        // A disconnected external camera may no longer have the old device ID.
        start(kind, retries > 2 ? '' : device, false);
      }
    }, backoff);
  }

  function start(kind, deviceId, resetRetries) {
    if (!isActive(kind)) return;
    stopEverything(resetRetries !== false);
    camera.owner = kind;
    camera.deviceId = deviceId || '';
    var generation = camera.generation;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFailure(kind, new Error('Camera not supported'));
      if (kind === 'live') liveMessage('⚠️ Camera unavailable on this browser.', '#b45309');
      return;
    }
    var constraints = { video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } } };
    navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      if (generation !== camera.generation || camera.owner !== kind || !isActive(kind)) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return;
      }
      camera.stream = stream;
      window.activeCameraStream = stream;
      var video = document.getElementById(kinds[kind].video);
      if (!video) { stopOwner(kind); return; }
      video.srcObject = stream;
      video.muted = true; // Allow reliable autoplay for camera-only preview on mobile.
      video.setAttribute('playsinline', 'true');
      stream.getVideoTracks().forEach(function (track) {
        track.addEventListener('ended', function () {
          if (generation === camera.generation && camera.owner === kind) {
            recover(kind, generation, new Error('Camera disconnected'));
          }
        });
      });
      Promise.resolve(video.play()).then(function () {
        if (generation !== camera.generation || camera.owner !== kind || !isActive(kind)) return;
        camera.retryCount = 0;
        if (kind === 'live') {
          var status = document.getElementById('scanMsg');
          if (status && (!status.textContent || /^(?:⚠️|READY|✓ READY)/.test(status.textContent))) {
            clearTimeout(liveReadyTimer);
            liveMessage('✓ READY FOR SCAN', '#16a34a');
          }
        }
        camera.frameId = raf(function () { frame(kind, generation); });
      }).catch(function (err) { recover(kind, generation, err); });
    }).catch(function (err) { recover(kind, generation, err); });
  }

  function init(kind) {
    if (!isActive(kind)) return;
    stopEverything(true); // Invalidates any earlier, still-pending device discovery.
    camera.owner = kind;
    var generation = camera.generation;
    var selector = document.getElementById(kinds[kind].select);
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      start(kind);
      return;
    }
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      if (generation !== camera.generation || !isActive(kind)) return;
      var cameras = devices.filter(function (device) { return device.kind === 'videoinput'; });
      var chosen = 0;
      if (selector) {
        selector.innerHTML = '';
        selector.style.display = cameras.length ? 'inline-block' : 'none';
        cameras.forEach(function (device, index) {
          var option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || ('Camera ' + (index + 1));
          if (/back|rear|environment/i.test(device.label)) chosen = index;
          selector.appendChild(option);
        });
        if (cameras.length) selector.selectedIndex = chosen;
      }
      // Blank device IDs occur before camera permission is granted.
      start(kind, cameras.length ? (cameras[chosen].deviceId || '') : '');
    }).catch(function (err) {
      if (generation === camera.generation && isActive(kind)) start(kind);
    });
  }

  // Preserve the existing scanner mode buttons, but reset the Live Monitor's
  // simple status label when the operator selects USB mode.
  var originalSetScanMode = window.setScanMode;
  window.setScanMode = function (mode) {
    originalSetScanMode.apply(this, arguments);
    if (mode === 'USB') {
      clearTimeout(liveReadyTimer);
      liveMessage('✓ READY FOR SCAN', '#16a34a');
    }
  };

  // Replace the old per-module camera loops with one ownership-safe engine.
  window.initCameraScanner = function () { init('live'); };
  window.switchCameraDevice = function () {
    var el = document.getElementById('cameraSelect');
    start('live', el ? el.value : '');
  };
  window.startCameraStream = function (deviceId) { start('live', deviceId); };
  window.stopCameraScanner = function () { stopOwner('live'); };
  window.scanCameraFrame = function () {
    if (camera.owner === 'live') frame('live', camera.generation);
  };

  window.initBorrowCameraScanner = function () { init('borrow'); };
  window.switchBorrowCameraDevice = function () {
    var el = document.getElementById('borrowCameraSelect');
    start('borrow', el ? el.value : '');
  };
  window.startBorrowCameraStream = function (deviceId) { start('borrow', deviceId); };
  window.stopBorrowCameraScanner = function () { stopOwner('borrow'); };
  window.scanBorrowCameraFrame = function () {
    if (camera.owner === 'borrow') frame('borrow', camera.generation);
  };

  window.initEquipCameraScanner = function () { init('equipment'); };
  window.switchEquipCameraDevice = function () {
    var el = document.getElementById('equipCameraSelect');
    start('equipment', el ? el.value : '');
  };
  window.startEquipCameraStream = function (deviceId) { start('equipment', deviceId); };
  window.stopEquipCameraScanner = function () { stopOwner('equipment'); };
  window.scanEquipCameraFrame = function () {
    if (camera.owner === 'equipment') frame('equipment', camera.generation);
  };

  // The three legacy QR-processing functions were originally void-returning.
  // Their existing duplicate guards, permissions, and business workflows stay
  // in charge; false indicates a suppressed/invalid scan (no success beep).
  var oldBorrow = window.processBorrowScan;
  window.processBorrowScan = function (code) {
    var before = window.borrowDup && window.borrowDup[code];
    oldBorrow.call(this, code);
    return !!(code && window.borrowDup && window.borrowDup[code] && window.borrowDup[code] !== before);
  };
  var oldEquipment = window.processEquipScan;
  window.processEquipScan = function (code) {
    var before = window.equipDup && window.equipDup[code];
    var recognized = !!((typeof window.findPerson === 'function' && window.findPerson(code)) ||
      (typeof window.findEquipment === 'function' && window.findEquipment(code)));
    oldEquipment.call(this, code);
    return !!(recognized && code && window.equipDup && window.equipDup[code] && window.equipDup[code] !== before);
  };

  function isActiveUsb(kind) {
    var spec = kinds[kind], el = document.getElementById(spec.tab);
    return !!(el && el.classList.contains('active') && spec.mode() === 'USB' && !document.hidden);
  }
  function userIsEditing() {
    var active = document.activeElement;
    return !!(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) &&
      ['scanner', 'borrowHiddenScanner', 'equipHiddenScanner'].indexOf(active.id) === -1) ||
      !!(active && active.isContentEditable);
  }
  function visibleDialog() {
    return Array.prototype.some.call(document.querySelectorAll('[role="dialog"],.modal,.overlay'), function (el) {
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && el.getClientRects().length > 0;
    });
  }
  function focusUsb(kind) {
    if (!isActiveUsb(kind) || userIsEditing() || visibleDialog()) return;
    var id = kind === 'live' ? 'scanner' : (kind === 'borrow' ? 'borrowHiddenScanner' : 'equipHiddenScanner');
    var el = document.getElementById(id);
    if (el && document.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (ignore) { el.focus(); }
    }
  }
  function wireUsb(kind, inputId, process) {
    var input = document.getElementById(inputId);
    if (!input) return;
    var idleTimer = null;
    function flush() {
      clearTimeout(idleTimer); idleTimer = null;
      var code = String(input.value || '').replace(/[\r\n]+/g, '').trim();
      input.value = '';
      if (!code || !isActiveUsb(kind)) return;
      try { process(code); } catch (err) { console.error('[QLog USB scanner] scan processing failed:', err); }
      setTimeout(function () { focusUsb(kind); }, 0);
    }
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        flush();
      }
    });
    input.addEventListener('input', function () {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(flush, cfg.usbIdleMs);
    });
    input.addEventListener('blur', function () { setTimeout(function () { focusUsb(kind); }, 75); });
  }
  wireUsb('live', 'scanner', function (code) { window.processScan(code); });
  wireUsb('borrow', 'borrowHiddenScanner', function (code) { window.processBorrowScan(code); });
  wireUsb('equipment', 'equipHiddenScanner', function (code) { window.processEquipScan(code); });
  document.addEventListener('click', function (event) {
    if (event.target && event.target.closest && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    setTimeout(function () {
      if (isActiveUsb('live')) focusUsb('live');
      if (isActiveUsb('borrow')) focusUsb('borrow');
      if (isActiveUsb('equipment')) focusUsb('equipment');
    }, 80);
  });
  window.addEventListener('focus', function () {
    if (isActiveUsb('live')) focusUsb('live');
    if (isActiveUsb('borrow')) focusUsb('borrow');
    if (isActiveUsb('equipment')) focusUsb('equipment');
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopEverything(true); return; }
    if (isActive('live')) init('live');
    else if (isActive('borrow')) init('borrow');
    else if (isActive('equipment')) init('equipment');
    else if (isActiveUsb('live')) focusUsb('live');
    else if (isActiveUsb('borrow')) focusUsb('borrow');
    else if (isActiveUsb('equipment')) focusUsb('equipment');
  });
  window.addEventListener('pagehide', function () { stopEverything(true); });

  // Read-only diagnostics for verification; deliberately no error/pending counters.
  window.qlogContinuousScannerStatus = function () {
    return {
      owner: camera.owner,
      cameraActive: !!(camera.stream && camera.stream.active),
      mode: camera.owner ? kinds[camera.owner].mode() : null
    };
  };
})();
