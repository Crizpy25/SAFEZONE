/* =========================================================
   webrtc.js — Multi-Admin PeerJS Dashboard
   =========================================================
   Integrates with the existing Supabase `admins` table.
   Each admin session gets its own unique PeerJS ID. Status
   management is atomic and respects call concurrency limits.
   Fully compatible with the Flutter caller application.
   ========================================================= */

const CALL_STATES = Object.freeze({
    IDLE: 'Idle',
    RINGING: 'Ringing',
    CONNECTING: 'Connecting',
    CONNECTED: 'Connected',
    ENDED: 'Ended'
});

let callState = CALL_STATES.IDLE;

function logCallState(newState, reason) {
    const prev = callState;
    if (prev === newState) return;
    const timestamp = new Date().toISOString();
    console.log(`[CallState] ${prev} → ${newState}${reason ? ` (${reason})` : ''} @ ${timestamp}`);
    callState = newState;
}

function transitionTo(newState, reason) {
    logCallState(newState, reason);
}

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
let activeCallRecordId = null;

const CALL_RECORDS_STORAGE_KEY = 'safezone_call_records';

function readCallRecords() {
    try {
        return JSON.parse(localStorage.getItem(CALL_RECORDS_STORAGE_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function saveCallRecords(records) {
    try {
        localStorage.setItem(CALL_RECORDS_STORAGE_KEY, JSON.stringify(records));
    } catch (e) {
        console.error('Failed to save call records:', e);
    }
}

function emitCallRecordsUpdated() {
    try {
        window.dispatchEvent(new Event('call-records-updated'));
    } catch (e) {
        /* ignore */
    }
}

function createIncomingCallRecord(call) {
    const record = {
        id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        peerId: call?.peer || 'Unknown caller',
        status: 'received',
        receivedAt: new Date().toISOString(),
        durationSeconds: 0
    };

    const records = readCallRecords();
    records.unshift(record);
    saveCallRecords(records.slice(0, 200));
    emitCallRecordsUpdated();
    return record.id;
}

function updateCallRecord(recordId, updates) {
    if (!recordId) return;
    const records = readCallRecords();
    const index = records.findIndex(entry => entry.id === recordId);
    if (index < 0) return;
    records[index] = { ...records[index], ...updates };
    saveCallRecords(records);
    emitCallRecordsUpdated();
}

function prepareAppNavigation() {
    sessionStorage.setItem('skipPeerCleanup', 'true');
    window.clearTimeout(window.__peerCleanupResetTimer);
    window.__peerCleanupResetTimer = window.setTimeout(() => {
        sessionStorage.removeItem('skipPeerCleanup');
    }, 2000);
}

function clearPendingAppNavigation() {
    window.clearTimeout(window.__peerCleanupResetTimer);
    sessionStorage.removeItem('skipPeerCleanup');
}

function shouldSkipCleanup() {
    return sessionStorage.getItem('skipPeerCleanup') === 'true';
}

window.prepareAppNavigation = prepareAppNavigation;
window.clearPendingAppNavigation = clearPendingAppNavigation;

// DOM references (index.html)
const idleState = document.getElementById('idleState');
const incomingState = document.getElementById('incomingState');
const activeState = document.getElementById('activeState');
const callTimer = document.getElementById('callTimer');
const remoteAudio = document.getElementById('remoteAudio');

const isDashboard = Boolean(idleState && incomingState && activeState);
let pendingIncomingUi = false;

function ensureIncomingCallUI() {
    if (!isDashboard) return;
    if (isOnCall()) {
        hide(idleState);
        hide(incomingState);
        show(activeState);
    } else if (pendingIncomingUi || incomingCall) {
        hide(idleState);
        show(incomingState);
        hide(activeState);
    } else {
        hide(incomingState);
        hide(activeState);
        show(idleState);
    }
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }
function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
}
function persistPeerId(id) {
    if (id) {
        sessionStorage.setItem('adminPeerId', id);
    }
}
function getStoredPeerId() {
    return sessionStorage.getItem('adminPeerId');
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

    const storedPeerId = getStoredPeerId();
    const newPeerId = storedPeerId || generatePeerId();
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
        peerId = data.peer_id || newPeerId;
        persistPeerId(peerId);
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
        if (peer.id) {
            peerId = peer.id;
            persistPeerId(peer.id);
        }
        if (!isOnCall()) {
            await setCallStatus(CALL_STATUS.available);
            transitionTo(CALL_STATES.IDLE, 'peer opened and not on call');
            setStatus('Call not Active');
        }
    });

    peer.on('call', async (call) => {
        // Reject if already handling a call to prevent double-calls
        if (incomingCall || isOnCall()) {
            call.close();
            return;
        }

        transitionTo(CALL_STATES.RINGING, 'incoming peer call');
        await setCallStatus(CALL_STATUS.busy);

        incomingCall = call;
        activeCallRecordId = createIncomingCallRecord(call);

        // Caller hung up before we answered
        incomingCall.on('close', async () => {
            if (incomingCall === call) {
                if (activeCallRecordId && !currentCall) {
                    updateCallRecord(activeCallRecordId, {
                        status: 'missed',
                        durationSeconds: 0
                    });
                }
                incomingCall = null;
                transitionTo(CALL_STATES.IDLE, 'incoming call closed before answer');
                await setCallStatus(CALL_STATUS.available);
                resetUI();
            }
        });

        pendingIncomingUi = true;
        ensureIncomingCallUI();
        setStatus('Incoming call...');
    });

    peer.on('disconnected', async () => {
        setStatus('Reconnecting...');
        if (!peer.destroyed && !isDestroyed) {
            setTimeout(async () => {
                try {
                    if (peer && !peer.destroyed) {
                        await peer.reconnect();
                        if (peer.id && adminId && peer.id !== peerId) {
                            peerId = peer.id;
                            await window.supabaseClient
                                .from('admins')
                                .update({ peer_id: peerId })
                                .eq('id', adminId);
                        }
                        if (!isOnCall()) {
                            await setCallStatus(CALL_STATUS.available);
                            transitionTo(CALL_STATES.IDLE, 'reconnected and not on call');
                        }
                    }
                } catch (e) { /* ignore */ }
            }, 3000);
        }
    });

    peer.on('error', async (err) => {
        console.error('PeerJS error:', err);
        if (err.type === 'unavailable-id') {
            const freshPeerId = generatePeerId();
            peerId = freshPeerId;
            persistPeerId(freshPeerId);
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
        if (isOnCall()) {
            console.warn('[CallState] Peer error during active call, preserving UI:', err.type);
            return;
        }
        incomingCall = null;
        transitionTo(CALL_STATES.IDLE, 'peer error while idle');
        await setCallStatus(CALL_STATUS.available);
        resetUI();
    });
}

/**
 * Accept incoming call and setup the local audio stream.
 */
function acceptCall() {
    if (!incomingCall || !isDashboard) return;

    transitionTo(CALL_STATES.CONNECTING, 'accepting incoming call');
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
            localStream = stream;
            currentCall = incomingCall;
            incomingCall = null;

            if (activeCallRecordId) {
                updateCallRecord(activeCallRecordId, {
                    status: 'accepted',
                    acceptedAt: new Date().toISOString()
                });
            }

            currentCall.answer(stream);
            currentCall.on('stream', (remoteStream) => {
                transitionTo(CALL_STATES.CONNECTED, 'remote stream received');
                pendingIncomingUi = false;
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
                transitionTo(CALL_STATES.ENDED, 'call closed');
                if (activeCallRecordId) {
                    updateCallRecord(activeCallRecordId, {
                        status: 'ended',
                        durationSeconds: seconds,
                        endedAt: new Date().toISOString()
                    });
                }
                await setCallStatus(CALL_STATUS.available);
                resetUI();
            });
            currentCall.on('error', async () => {
                transitionTo(CALL_STATES.ENDED, 'call error');
                await setCallStatus(CALL_STATUS.available);
                resetUI();
            });
        })
        .catch(async () => {
            incomingCall = null;
            transitionTo(CALL_STATES.IDLE, 'failed to get user media');
            await setCallStatus(CALL_STATUS.available);
            rejectCall();
        });
}

function rejectCall() {
    if (incomingCall) {
        if (activeCallRecordId) {
            updateCallRecord(activeCallRecordId, {
                status: 'rejected',
                durationSeconds: 0
            });
        }
        incomingCall.close();
        incomingCall = null;
    }
    transitionTo(CALL_STATES.IDLE, 'call rejected');
    resetUI();
}

function endCall() {
    if (currentCall) {
        currentCall.close();
        currentCall = null;
    }
    // resetUI() is invoked by currentCall.on('close')
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

    pendingIncomingUi = false;
    hide(incomingState);
    hide(activeState);
    show(idleState);
    activeCallRecordId = null;
    setStatus('Waiting for call...');
    incomingCall = null;
    currentCall = null;

    transitionTo(CALL_STATES.IDLE, 'UI reset');

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
    if (shouldSkipCleanup()) return;
    await clearAdminSession();
    destroyPeer();
});

window.addEventListener('pagehide', async () => {
    if (shouldSkipCleanup()) return;
    await clearAdminSession();
    destroyPeer();
});

window.addEventListener('focus', () => {
    console.log('[CallState] Window focused, current state:', callState, 'isOnCall:', isOnCall());
    ensureIncomingCallUI();
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
