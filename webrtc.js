const ADMIN_PEER_ID = 'admin-dashboard-xyz';

let peer = null;
let currentCall = null;
let timerInterval = null;
let seconds = 0;
let isDestroyed = false;

// UI elements
const idleState     = document.getElementById('idleState');
const incomingState = document.getElementById('incomingState');
const activeState   = document.getElementById('activeState');
const callTimer     = document.getElementById('callTimer');
const remoteAudio   = document.getElementById('remoteAudio');
const callBanner    = document.getElementById('callBanner');
const statusMain    = document.getElementById('status');

const isDashboard = idleState && incomingState && activeState;

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

function setStatus(text) {
    if (statusMain) statusMain.textContent = text;
}

// ───────────────────────── SAFE INIT ─────────────────────────
function initPeer() {

    if (peer && !peer.destroyed) return; // prevent duplicates
    isDestroyed = false;

    peer = new Peer(ADMIN_PEER_ID);

    peer.on('open', () => {
        setStatus('Call not Active');
    });

    peer.on('call', (call) => {
        currentCall = call;

        if (isDashboard) {
            hide(idleState);
            show(incomingState);
        }

        setStatus('📲 Incoming call...');
    });

    peer.on('disconnected', () => {
        setStatus('⚠ Reconnecting...');

        // SAFE reconnect check
        if (!peer.destroyed && !isDestroyed) {
            setTimeout(() => {
                try {
                    peer.reconnect();
                } catch (e) {
                    console.warn('Reconnect failed:', e);
                }
            }, 3000);
        }
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
    });
}

// ───────────────────────── ACCEPT CALL ────────────────────────
function acceptCall() {
    if (!currentCall || !isDashboard) return;

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {

            currentCall.answer(stream);

            currentCall.on('stream', (remoteStream) => {
                remoteAudio.srcObject = remoteStream;

                hide(incomingState);
                show(activeState);
                show(callBanner);

                setStatus('📞 Call active');

                seconds = 0;
                clearInterval(timerInterval);

                timerInterval = setInterval(() => {
                    seconds++;
                    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
                    const s = String(seconds % 60).padStart(2, '0');
                    if (callTimer) callTimer.textContent = `${m}:${s}`;
                }, 1000);
            });

            currentCall.on('close', resetUI);
            currentCall.on('error', resetUI);

        })
        .catch((err) => {
            console.error(err);
            rejectCall();
        });
}

// ───────────────────────── REJECT / END ───────────────────────
function rejectCall() {
    currentCall?.close();
    resetUI();
}

function endCall() {
    currentCall?.close();
    resetUI();
}

// ───────────────────────── RESET ──────────────────────────────
function resetUI() {
    clearInterval(timerInterval);

    if (remoteAudio) remoteAudio.srcObject = null;
    if (callTimer) callTimer.textContent = '00:00';

    hide(incomingState);
    hide(activeState);
    hide(callBanner);
    show(idleState);

    setStatus('Waiting for call...');

    currentCall = null;
}

// ───────────────────────── SAFE DESTROY ───────────────────────
function destroyPeer() {
    isDestroyed = true;

    try {
        peer?.destroy();
    } catch (e) {
        console.warn(e);
    }

    peer = null;
}


// ───────────────────────── START ──────────────────────────────
initPeer();