const SystemState = {
  READY: 'ready',
  SCANNING_EMAIL: 'scanning_email',
  CODE_GENERATED: 'code_generated',
  SCANNING_PICKUP_CODE: 'scanning_pickup_code',
  OPENED: 'opened'
};

const areaID = window.SCBConfig.postCode;
const serID = window.SCBConfig.serial;

let currentState = SystemState.READY;
let generatedCode = null;
let html5QrcodeScanner = null;

const startBtn = document.getElementById('startBtn');
const scanPickupBtn = document.getElementById('scanPickupBtn');
const resetBtn = document.getElementById('resetBtn');
const statusIndicator = document.getElementById('statusIndicator');
const scannerView = document.getElementById('scannerView');
const scannerMessage = document.getElementById('scannerMessage');
const qrGenerator = document.getElementById('qrGenerator');
const qrCanvas = document.getElementById('qrCanvas');
const boxImage = document.getElementById('boxImage');
const unlockSound = document.getElementById('unlockSound');
const lockSound = document.getElementById('lockSound');
let codeExpiresAt = 0;
let deliveryId = null;
let scanBusy = false;
let pendingParcelId = null;
let recipientEmailQr = null;
function saveSession() {
  sessionStorage.setItem("scbDelivery", JSON.stringify({generatedCode,codeExpiresAt,deliveryId,pendingParcelId,recipientEmailQr}));
}

function initScanner() {
  html5QrcodeScanner = new Html5QrcodeScanner("scannerView", {
    fps: 10,
    qrbox: { width: 200, height: 200 },
    supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA]
  }, false);
}

function isValidEmail(email) {
  try {
    const decoded = atob(email);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(decoded);
  } catch { return false; }
}

function generatePickupCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return (100000 + bytes[0] % 900000).toString();
}

function updateSystemState(newState) {
  currentState = newState;
  switch (currentState) {
    case SystemState.READY:
      statusIndicator.className = "status-indicator status-waiting";
      statusIndicator.textContent = "System Ready";
      scannerMessage.textContent = 'Click "Start Delivery" to begin';
      startBtn.disabled = false;
      scanPickupBtn.disabled = true;
      resetBtn.disabled = true;
      qrGenerator.style.display = "none";
      boxImage.src = "images/unlocked.png";
      break;
    case SystemState.SCANNING_EMAIL:
      statusIndicator.className = "status-indicator status-scanning";
      statusIndicator.textContent = "Scanning Recipient Email QR";
      scannerMessage.textContent = "Point camera at recipient's email QR code";
      startBtn.disabled = true;
      scanPickupBtn.disabled = true;
      resetBtn.disabled = false;
      boxImage.src = "images/open.png";
      break;
    case SystemState.CODE_GENERATED:
      statusIndicator.className = "status-indicator status-success";
      statusIndicator.textContent = "Pickup Code Generated!";
      scannerMessage.textContent = "Recipient must scan the pickup QR code";
      scanPickupBtn.disabled = false;
      qrGenerator.style.display = "block";
      boxImage.src = "images/locked.png";
      //lockSound.play();

      break;
    case SystemState.SCANNING_PICKUP_CODE:
      statusIndicator.className = "status-indicator status-scanning";
      statusIndicator.textContent = "Verifying Pickup Code";
      scannerMessage.textContent = "Point camera at the pickup QR code";
      scanPickupBtn.disabled = true;
      break;
    case SystemState.OPENED:
      statusIndicator.className = "status-indicator status-success";
      statusIndicator.textContent = "Verified! Box Opened";
      scannerMessage.textContent = "Pickup completed";
      startBtn.disabled = true;
      scanPickupBtn.disabled = true;
      resetBtn.disabled = false;
      boxImage.src = "images/open.png";
      unlockSound.play().catch(() => {});
      setTimeout(resetSystem, 3000);
      break;
  }
}

async function handleScan(decodedText) {
  if (currentState === SystemState.SCANNING_EMAIL) {
    if (isValidEmail(decodedText)) {
      generatedCode = generatePickupCode();
      deliveryId = crypto.randomUUID();
      recipientEmailQr = decodedText;
      codeExpiresAt = Date.now() + window.SCBConfig.codeLifetimeMs;
      saveSession();
      const deliveryUrl = new URL("/p", window.SCBConfig.baseUrl);
      deliveryUrl.search = new URLSearchParams({e:decodedText,c:btoa(generatedCode),a:btoa(areaID),s:btoa(serID),d:deliveryId,t:String(codeExpiresAt)}).toString();
      await QRCode.toCanvas(qrCanvas, deliveryUrl.href, {
        width: 180, margin: 2
      });
      updateSystemState(SystemState.CODE_GENERATED);
      await html5QrcodeScanner.clear().catch(() => {});
      scannerView.innerHTML = '<p>Wait for the pickup code to be scanned</p>';
    } else {
      scannerMessage.textContent = "Invalid email QR code, try again";
    }
  } else if (currentState === SystemState.SCANNING_PICKUP_CODE) {
    try {
      const decoded = atob(decodedText);
      if (generatedCode && decoded === generatedCode && (Date.now() < codeExpiresAt || pendingParcelId)) {
        if (!pendingParcelId) {
          const verified = await SCBAuth.fetch('/api/pickups/verify', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deliveryId,qrKeyId:decodedText})});
          const verification = await verified.json();
          if (!verified.ok) throw new Error(verification.error);
          pendingParcelId = verification.id;
          saveSession();
        }
        const retrieved = await SCBAuth.fetch('/api/parcels/' + pendingParcelId + '/retrieve', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qrKeyId:decodedText})});
        if (!retrieved.ok) throw new Error((await retrieved.json()).error);
        await html5QrcodeScanner.clear().catch(() => {});
        updateSystemState(SystemState.OPENED);
      } else {
        scannerMessage.textContent = "Invalid pickup code, try again";
      }
    } catch (error) { scannerMessage.textContent = error.message || "Malformed QR code"; }
  }
}

async function onScanSuccess(text) {
  if (scanBusy) return;
  scanBusy = true;
  try { await handleScan(text); } catch (error) { scannerMessage.textContent = error.message; } finally { scanBusy = false; }
}

async function resetSystem() {
  if (scanBusy) return;
  sessionStorage.removeItem("scbDelivery");
  pendingParcelId = null;
  recipientEmailQr = null;
  generatedCode = null;
  deliveryId = null;
  codeExpiresAt = 0;
  if (html5QrcodeScanner) await html5QrcodeScanner.clear().catch(() => {});
  scannerView.innerHTML = '<p>Click “Start Delivery” to begin.</p>';
  updateSystemState(SystemState.READY);
}

startBtn.addEventListener('click', async () => {
  try { if (!await SCBAuth.getToken()) throw new Error('Sign in on the home page first.'); } catch (error) { scannerMessage.textContent = error.message; return; }
  if (currentState === SystemState.READY) {
    scannerView.innerHTML = '';
    initScanner();
    html5QrcodeScanner.render(onScanSuccess, () => {});
    updateSystemState(SystemState.SCANNING_EMAIL);
  }
});

scanPickupBtn.addEventListener('click', () => {
  if (currentState === SystemState.CODE_GENERATED) {
    scannerView.innerHTML = '';
    initScanner();
    html5QrcodeScanner.render(onScanSuccess, () => {});
    updateSystemState(SystemState.SCANNING_PICKUP_CODE);
  }
});

resetBtn.addEventListener('click', resetSystem);
try {
  const stored = JSON.parse(sessionStorage.getItem('scbDelivery') || 'null');
  if (stored && /^\d{6}$/.test(stored.generatedCode) && typeof stored.deliveryId === 'string') {
    ({generatedCode,codeExpiresAt,deliveryId,pendingParcelId,recipientEmailQr} = stored);
  }
} catch (_) { sessionStorage.removeItem('scbDelivery'); }

updateSystemState(generatedCode ? SystemState.CODE_GENERATED : SystemState.READY);
if (generatedCode) {
  const url = new URL('/p', window.SCBConfig.baseUrl);
  url.search = new URLSearchParams({e:recipientEmailQr,c:btoa(generatedCode),a:btoa(areaID),s:btoa(serID),d:deliveryId,t:String(codeExpiresAt)}).toString();
  QRCode.toCanvas(qrCanvas, url.href, {width:180,margin:2}).catch(error => {scannerMessage.textContent=error.message;});
  startBtn.disabled = true;
  resetBtn.disabled = false;
}
