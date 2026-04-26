// ─────────────────────────────────────────────────────────────
//  webrtc.js  –  SAFEZONE Admin Call Handler
// ─────────────────────────────────────────────────────────────

const ADMIN_PEER_ID = 'admin-dashboard-xyz';

const idleState    = document.getElementById('idleState');
const incomingState = document.getElementById('incomingState');
const activeState  = document.getElementById('activeState');
const callTimer    = document.getElementById('callTimer');
const remoteAudio  = document.getElementById('remoteAudio');
const callBanner   = document.getElementById('callBanner');
const statusMain   = document.getElementById('status');

let peer, currentCall, timerInterval, seconds = 0;

function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

function initPeer() {
    peer = new Peer(ADMIN_PEER_ID);

    peer.on('open', () => {});

    peer.on('disconnected', () => {
        setTimeout(() => peer.reconnect(), 3000);
    });

    peer.on('call', (call) => {
        currentCall = call;
        hide(idleState);
        show(incomingState);
        if (statusMain) statusMain.textContent = '📲 Incoming call...';
    });
}

function acceptCall() {
    if (!currentCall) return;
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then((localStream) => {
            currentCall.answer(localStream);
            currentCall.on('stream', (remoteStream) => {
                remoteAudio.srcObject = remoteStream;
                hide(incomingState);
                show(activeState);
                show(callBanner);
                if (statusMain) statusMain.textContent = '📞 Call active';
                seconds = 0;
                clearInterval(timerInterval);
                timerInterval = setInterval(() => {
                    seconds++;
                    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
                    const s = String(seconds % 60).padStart(2, '0');
                    callTimer.textContent = m + ':' + s;
                }, 1000);
            });
            currentCall.on('close', resetUI);
            currentCall.on('error', resetUI);
        })
        .catch((err) => {
            alert('Microphone access denied: ' + err.message);
            rejectCall();
        });
}

function rejectCall() {
    currentCall?.close();
    resetUI();
}

function endCall() {
    currentCall?.close();
    resetUI();
}

function resetUI() {
    clearInterval(timerInterval);
    remoteAudio.srcObject = null;
    callTimer.textContent = '00:00';
    hide(incomingState);
    hide(activeState);
    hide(callBanner);
    show(idleState);
    if (statusMain) statusMain.textContent = 'Waiting for call...';
    currentCall = null;
}

initPeer();