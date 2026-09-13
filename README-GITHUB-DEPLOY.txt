QLOG PRO ULTIMATE V7 - GITHUB PAGES FRONTEND

UPLOAD ALL CONTENTS OF THIS FOLDER to the root of the GitHub Pages repository.
Frontend API target:
  https://qlog-upgraded.mdmsportal.uk

Architecture:
  GitHub Pages / installed PWA
       -> HTTPS + Socket.IO + authenticated profile sync
  qlog-upgraded.mdmsportal.uk
       -> Cloudflare qlog-api tunnel
  127.0.0.1:7000 on server PC
       -> Node.js + SQLite Central backend

CENTRAL PROFILE BEHAVIOR
- The active Central identity is In-Charge + Facility/Office.
- The same profile can connect from another authorized device and rebuild/sync the same Central records.
- Different profiles keep their operational records isolated.
- Offline profile caches and pending changes reconcile when connection returns.
- Reset This Device does NOT erase Central records.

RESTORED FIRST-CENTRALIZED FEATURES
- Central profile/device authentication and fast profile switching
- Central Admin dashboard, device/profile monitoring and reset generation
- Record-level reconciliation, revisions/tombstones and deduplication
- Rebuild My Office Data
- Equipment Registry + Equipment Borrow/Return
- Cross-office visitor face directory
- Valid-ID offline OCR visitor registration/manual fallback
- Installation Password gate (optional build-time activation)

INSTALLATION PASSWORD
- install-gate.js contains placeholders in source/development copies, so the gate is skipped until compiled.
- For GitHub deployment, set repository secret QLOG_INSTALLATION_PASSWORD and use .github/workflows/deploy.yml.
- See INSTALLATION_PASSWORD_GITHUB_SETUP.md.

NEWER MODULES PRESERVED
- Teacher Certificates
- eIPCRF uploads/analysis
- Consolidated TNA
- Existing Library/Book, Reports, PWA and speech-input capabilities

Do NOT upload backend files, SQLite databases, uploads, logs, .env, or tunnel tokens to GitHub.
