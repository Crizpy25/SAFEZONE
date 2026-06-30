/* =========================================================
   webrtc.js — Multi-Admin PeerJS Dashboard
   =========================================================
   Integrates with the existing Supabase `admins` table.
   Each admin session gets its own unique PeerJS ID. Status
   management is atomic and respects call concurrency limits.
   Fully compatible with the Flutter caller application.
   ========================================================= */

const CALL_STATUS = Object.freeze({ available: 'available', busy: 'busy', offline: 'offline' });

let peer = null;
let currentCall = null;
let incomingCall = null;
let localStream = null;
let timerInterval = null;
let seconds = 0;
let isDestroyed = false;
let adminId = null;
let peerId = null;

// DOM references (index.html)
const idleState = document.getElementById('idleState');
const incomingState = document.getElementById('incomingState');
const activeState = document.getElementById('activeState');
const callTimer = document.getElementById('callTimer');
const remoteAudio = document.getElementById('remoteAudio');

const isDashboard = Boolean(idleState && incomingState && activeState);

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }
function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
}

/**
 * Generate a unique PeerJS ID for this browser session.
 */
function generatePeerId() {
    const suffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    return `admin-${suffix}`;
}

/**
 * Register this admin in the `admins` table.
 * Sets is_logged_in = true, call_status = available, and stores peer_id.
 */
async function registerAdminSession() {
    const storedAdminId = sessionStorage.getItem('adminUserID');
    if (!storedAdminId || !window.supabaseClient) return null;

    const newPeerId = generatePeerId();
    const now = new Date().toISOString();

    try {
        const { data, error } = await window.supabaseClient
            .from('admins')
            .update({
                is_logged_in: true,
                call_status: CALL_STATUS.available,
                peer_id: newPeerId,
                last_seen: now
            })
            .eq('id', storedAdminId)
            .select()
            .single();

        if (error || !data) {
            console.error('Failed to register admin session:', error);
            return null;
        }

        adminId = data.id;
        peerId = data.peer_id;
        return data;
    } catch (err) {
        console.error('Exception registering admin session:', err);
        return null;
    }
}

/**
 * Atomically update call_status and last_seen for this admin.
 */
async function setCallStatus(status) {
    if (!adminId || !window.supabaseClient) return;
    try {
        await window.supabaseClient
            .from('admins')
            .update({
                call_status: status,
                last_seen: new Date().toISOString()
            })
            .eq('id', adminId);
    } catch (err) {
        console.error('Failed to update call status:', err);
    }
}

/**
 * Clear admin session on browser close, refresh, or logout.
 */
async function clearAdminSession() {
    if (!adminId || !window.supabaseClient) return;
    try {
        await window.supabaseClient
            .from('admins')
            .update({
                is_logged_in: false,
                call_status: CALL_STATUS.offline,
                peer_id: null,
                last_seen: new Date().toISOString()
            })
            .eq('id', adminId);
    } catch (err) {
        console.error('Failed to clear admin session:', err);
    }
}

function isOnCall() {
    return currentCall !== null && currentCall.open;
}

/**
 * Initialize PeerJS connection and register the admin in Supabase.
 */
async function initPeer() {
    if (peer && !peer.destroyed) return;
    isDestroyed = false;

    const adminRecord = await registerAdminSession();
    if (!adminRecord) {
        setStatus('Connection error');
        return;
    }

    if (peer && !peer.destroyed) {
        try { peer.destroy(); } catch (e) { /* ignore */ }
    }

    peer = new Peer(peerId);

    peer.on('open', async () => {
        if (!isOnCall()) {
            await setCallStatus(CALL_STATUS.available);
        }
        setStatus('Call not Active');
    });

    peer.on('call', async (call) => {
        // Reject if already handling a call to prevent double-calls
        if (incomingCall || isOnCall()) {
            call.close();
            return;
        }

        // Ensure status is marked busy as soon as a call comes in
        await setCallStatus(CALL_STATUS.busy);

        incomingCall = call;

        // Caller hung up before we answered
        incomingCall.on('close', async () => {
            if (incomingCall === call) {
                incomingCall = null;
                await setCallStatus(CALL_STATUS.available);
                resetUI();
            }
        });

        if (isDashboard) {
            hide(idleState);
            show(incomingState);
        }
        setStatus('Incoming call...');
    });

    peer.on('disconnected', async () => {
        setStatus('Reconnecting...');
        if (!peer.destroyed && !isDestroyed) {
            setTimeout(async () => {
                try {
                    if (peer && !peer.destroyed) {
                        await peer.reconnect();
                        // Sync any PeerJS ID change back to Supabase
                        if (peer.id && adminId && peer.id !== peerId) {
                            peerId = peer.id;
                            await window.supabaseClient
                                .from('admins')
                                .update({ peer_id: peerId })
                                .eq('id', adminId);
                        }
                        if (!isOnCall()) {
                            await setCallStatus(CALL_STATUS.available);
                        }
                    }
                } catch (e) { /* ignore */ }
            }, 3000);
        }
    });

    peer.on('error', async (err) => {
        console.error('PeerJS error:', err);
        if (err.type === 'unavailable-id') {
            // ID collision — generate a fresh ID and reinitialize
            const freshPeerId = generatePeerId();
            peerId = freshPeerId;
            try {
                await window.supabaseClient
                    .from('admins')
                    .update({ peer_id: freshPeerId })
                    .eq('id', adminId);
            } catch (e) { /* ignore */ }
            try { peer.destroy(); } catch (e) { /* ignore */ }
            setTimeout(() => initPeer(), 1000);
            return;
        }
        incomingCall = null;
        await setCallStatus(CALL_STATUS.available);
        resetUI();
    });
}

/**
 * Accept incoming call and setup the local audio stream.
 */
function acceptCall() {
    if (!incomingCall || !isDashboard) return;

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
            localStream = stream;
            currentCall = incomingCall;
            incomingCall = null;

            currentCall.answer(stream);
            currentCall.on('stream', (remoteStream) => {
                remoteAudio.srcObject = remoteStream;
                hide(incomingState);
                show(activeState);
                setStatus('Call active');

                seconds = 0;
                clearInterval(timerInterval);
                timerInterval = setInterval(() => {
                    seconds++;
                    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
                    const s = String(seconds % 60).padStart(2, '0');
                    if (callTimer) callTimer.textContent = `${m}:${s}`;
                }, 1000);
            });
            currentCall.on('close', async () => {
                await setCallStatus(CALL_STATUS.available);
                resetUI();
            });
            currentCall.on('error', async () => {
                await setCallStatus(CALL_STATUS.available);
                resetUI();
            });
        })
        .catch(async () => {
            incomingCall = null;
            await setCallStatus(CALL_STATUS.available);
            rejectCall();
        });
}

function rejectCall() {
    if (incomingCall) {
        incomingCall.close();
        incomingCall = null;
    }
    resetUI();
}

function endCall() {
    if (currentCall) {
        currentCall.close();
        currentCall = null;
    }
    resetUI();
}

/**
 * Reset UI and release media resources.
 * Determines final database status based on whether the admin
 * is still logged in or has left the dashboard.
 */
async function resetUI() {
    clearInterval(timerInterval);
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (remoteAudio) {
        if (remoteAudio.srcObject) {
            remoteAudio.srcObject.getTracks().forEach(track => track.stop());
            remoteAudio.srcObject = null;
        }
    }
    if (callTimer) callTimer.textContent = '00:00';

    hide(incomingState);
    hide(activeState);
    show(idleState);
    setStatus('Waiting for call...');
    incomingCall = null;
    currentCall = null;

    if (!isDestroyed && adminId) {
        const stillLoggedIn = sessionStorage.getItem('adminLoggedIn') === 'true';
        if (stillLoggedIn) {
            await setCallStatus(CALL_STATUS.available);
        } else {
            await clearAdminSession();
        }
    }
}

function destroyPeer() {
    isDestroyed = true;
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    try { peer?.destroy(); } catch (e) { /* ignore */ }
    peer = null;
    currentCall = null;
    incomingCall = null;
}

// Page lifecycle — mark agent offline on refresh or close
window.addEventListener('beforeunload', async () => {
    await clearAdminSession();
    destroyPeer();
});

window.addEventListener('pagehide', async () => {
    await clearAdminSession();
    destroyPeer();
});

// Expose cleanup hook for auth.js logout or external triggers
window.cleanupAdminSession = async function() {
    await clearAdminSession();
    destroyPeer();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initPeer().catch((err) => console.error('initPeer failed:', err));
    });
} else {
    initPeer().catch((err) => console.error('initPeer failed:', err));
}
