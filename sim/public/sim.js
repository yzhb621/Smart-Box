const SystemState = {
  READY: 'ready',
  SCANNING_EMAIL: 'scanning_email',
  CODE_GENERATED: 'code_generated',
  SCANNING_PICKUP_CODE: 'scanning_pickup_code',
  OPENED: 'opened'
};

const areaID = "0000";
const serID = 4;

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
const MASTER_CODE = "8080";

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
  return Math.floor(1000 + Math.random() * 9000).toString();
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
      unlockSound.play();
      setTimeout(resetSystem, 3000);
      break;
  }
}

async function onScanSuccess(decodedText) {
  if (currentState === SystemState.SCANNING_EMAIL) {
    if (isValidEmail(decodedText)) {
      generatedCode = generatePickupCode();
      QRCode.toCanvas(qrCanvas, "https://smart-courier-box.vercel.app/p?e=" + decodedText + "&c=" + btoa(generatedCode) + "&a=" + btoa(areaID) + "&s=" + btoa(serID), {
        width: 180, margin: 2
      });
      updateSystemState(SystemState.CODE_GENERATED);
      html5QrcodeScanner.clear();
      scannerView.innerHTML = '<p>Wait for the pickup code to be scanned</p>';
    } else {
      scannerMessage.textContent = "Invalid email QR code, try again";
    }
  } else if (currentState === SystemState.SCANNING_PICKUP_CODE) {
    try {
      const decoded = atob(decodedText);
      if (decoded === generatedCode || decoded === MASTER_CODE) {
        html5QrcodeScanner.clear();
        updateSystemState(SystemState.OPENED);
      } else {
        scannerMessage.textContent = "Invalid pickup code, try again";
      }
    } catch { scannerMessage.textContent = "Malformed QR code"; }
  }
}

function resetSystem() {
  if (html5QrcodeScanner) html5QrcodeScanner.clear();
  scannerView.innerHTML = '<p>Click “Start Delivery” to begin.</p>';
  updateSystemState(SystemState.READY);
}

startBtn.addEventListener('click', () => {
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

updateSystemState(SystemState.READY);
