/*
 *  Copyright (c) 2015 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
'use strict';

/* =========================================================
   webrtc.js — Multi-Admin Native WebRTC Dashboard
   =========================================================
   Uses native RTCPeerConnection + Supabase Realtime broadcasts
   for signaling. Supports multiple simultaneously online admins.
   ========================================================= */

const CALL_STATES = Object.freeze({
    IDLE: 'idle',
    RINGING: 'ringing',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    ENDED: 'ended'
});

const CALL_STATUS = Object.freeze({ available: 'available', busy: 'busy', offline: 'offline' });

const CALL_DISPATCH_CHANNEL = 'call-dispatch';
const ALREADY_ANSWERED_DISPLAY_MS = 3000;
const INCOMING_CALL_MAX_AGE_MS = 2 * 60 * 1000;
const MEDIA_CONNECTION_TIMEOUT_MS = 15000;
// Callers in the deployed clients use both `ringing` and the older `active`
// value while waiting for an admin. Treat every supported waiting status as
// ringable so Realtime and the polling fallback behave identically.
const RINGING_ALERT_STATUSES = new Set(['ringing', 'pending', 'active']);
const TERMINAL_ALERT_STATUSES = new Set(['ended', 'cancelled', 'canceled', 'failed', 'missed', 'expired', 'completed', 'resolved', 'closed']);

// Per-admin state container
const adminState = {
    callState: CALL_STATES.IDLE,
    pc: null,
    localStream: null,
    remoteStream: null,
    currentCall: null,
    incomingCallId: null,
    callerPeerId: null,
    activeAlertId: null,
    incomingAlert: null,
    claimedAlertIds: new Set(),
    declinedAlertIds: new Set(),
    claimedCallId: null,
    targetPeerId: null,
    timerInterval: null,
    seconds: 0,
    isDestroyed: false,
    adminId: null,
    peerId: null,
    peer: null,
    incomingPeerCall: null,
    peerReconnectTimer: null,
    mediaConnectionTimer: null,
    disconnectRecoveryTimer: null,
    activeCallRecordId: null,
    pendingIncomingUi: false,
    alreadyAnsweredTimeout: null,
    dispatchChannel: null,
    dispatchPollTimer: null,
    dispatchPollInFlight: false,
    activeAlertChannel: null,
    dispatchReady: null,
    pendingOffer: null,
    iceCandidatesQueue: [],
    pendingOutgoingIce: [],
    callClaims: new Map(),
    answerInProgress: false,
    answerRequested: false,
    peerReady: false,
    isEndingCall: false,
    isCleaningUp: false,
    lastResult: null,
    audioLevels: [],
    lastAudioLevelTime: 0,
    useDtx: false,
    useFec: true,
    bitrateGraph: null,
    bitrateSeries: null,
    targetBitrateSeries: null,
    headerrateSeries: null,
    packetGraph: null,
    packetSeries: null,
    audioLevelGraph: null,
    audioLevelSeries: null
};

// DOM references
const dom = {};

function cacheDomReferences() {
    dom.idleState = document.getElementById('idleState');
    dom.incomingState = document.getElementById('incomingState');
    dom.connectingState = document.getElementById('connectingState');
    dom.activeState = document.getElementById('activeState');
    dom.callTimer = document.getElementById('callTimer');
    dom.remoteAudio = document.getElementById('remoteAudio');
    dom.answerCallButton = document.getElementById('answerCallButton');
    dom.cancelCallButton = document.getElementById('cancelCallButton');
    dom.incomingTitle = dom.incomingState ? dom.incomingState.querySelector('p') : null;
    dom.incomingContainer = dom.incomingState ? dom.incomingState.querySelector('.flex') : null;
    bindAnswerButton();
    bindCancelButton();
}

function bindAnswerButton() {
    const button = document.getElementById('answerCallButton');
    if (!button || button.dataset.answerHandlerBound === 'true') return;
    button.dataset.answerHandlerBound = 'true';
    button.addEventListener('click', acceptCall);
    dom.answerCallButton = button;
}

function bindCancelButton() {
    const button = document.getElementById('cancelCallButton');
    if (!button) return;
    button.disabled = false;
    button.style.pointerEvents = '';
    button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        rejectCall().catch(error => console.error('[Admin Call] Cancel handler failed:', error));
    };
    dom.cancelCallButton = button;
}

function enableAnswerButton() {
    bindAnswerButton();
    const button = dom.answerCallButton;
    if (!button) return;
    button.disabled = false;
    button.removeAttribute('aria-disabled');
    button.style.pointerEvents = '';
    button.classList.remove('opacity-50', 'cursor-not-allowed');
}

function prepareIncomingCallControls() {
    if (adminState.alreadyAnsweredTimeout) {
        window.clearTimeout(adminState.alreadyAnsweredTimeout);
        adminState.alreadyAnsweredTimeout = null;
    }
    restoreIncomingButtons();
    enableAnswerButton();
    bindCancelButton();
}

async function waitForPeerReady(timeoutMs = 5000) {
    if (adminState.peerReady && adminState.peer?.open && !adminState.peer.destroyed) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await new Promise(resolve => window.setTimeout(resolve, 100));
        if (adminState.peerReady && adminState.peer?.open && !adminState.peer.destroyed) return true;
    }
    return false;
}

const isDashboard = () => Boolean(dom.idleState && dom.incomingState && dom.activeState);

let meteredCallLoadPromise = null;

function ensureMeteredCallLoaded() {
    if (window.MeteredCall) return Promise.resolve(window.MeteredCall);
    if (meteredCallLoadPromise) return meteredCallLoadPromise;
    meteredCallLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timeout = window.setTimeout(() => reject(new Error('Timed out loading metered-call.js')), 10000);
        const finish = () => {
            window.clearTimeout(timeout);
            if (window.MeteredCall) resolve(window.MeteredCall);
            else reject(new Error('metered-call.js loaded without initializing window.MeteredCall'));
        };
        script.addEventListener('load', finish, { once: true });
        script.addEventListener('error', () => {
            window.clearTimeout(timeout);
            reject(new Error('Could not load metered-call.js'));
        }, { once: true });
        script.src = `metered-call.js?v=20260810-7-${Date.now()}`;
        script.dataset.meteredCallLoader = 'true';
        document.head.appendChild(script);
    }).catch(error => {
        meteredCallLoadPromise = null;
        throw error;
    });
    return meteredCallLoadPromise;
}

// =========================================================
// UI HELPERS
// =========================================================
function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
}

function startCallTimer() {
    if (adminState.timerInterval) return;
    adminState.seconds = 0;
    if (dom.callTimer) dom.callTimer.textContent = '00:00';
    adminState.timerInterval = window.setInterval(() => {
        adminState.seconds++;
        const minutes = String(Math.floor(adminState.seconds / 60)).padStart(2, '0');
        const seconds = String(adminState.seconds % 60).padStart(2, '0');
        if (dom.callTimer) dom.callTimer.textContent = `${minutes}:${seconds}`;
    }, 1000);
    console.log('[Admin Call] Timer started');
}

function stopCallTimer() {
    console.log('[Admin Call] Stopping timer');
    if (adminState.timerInterval) window.clearInterval(adminState.timerInterval);
    adminState.timerInterval = null;
    adminState.seconds = 0;
    if (dom.callTimer) dom.callTimer.textContent = '00:00';
}

function clearDisconnectRecoveryTimer() {
    if (adminState.disconnectRecoveryTimer) window.clearTimeout(adminState.disconnectRecoveryTimer);
    adminState.disconnectRecoveryTimer = null;
}

function ensureIncomingCallUI() {
    if (!isDashboard()) return;
    if (isOnCall()) {
        hide(dom.idleState);
        hide(dom.incomingState);
        hide(dom.connectingState);
        show(dom.activeState);
    } else if (adminState.callState === CALL_STATES.CONNECTING) {
        hide(dom.idleState);
        hide(dom.incomingState);
        show(dom.connectingState);
        hide(dom.activeState);
    } else if (adminState.pendingIncomingUi || adminState.incomingCallId) {
        hide(dom.idleState);
        hide(dom.connectingState);
        show(dom.incomingState);
        hide(dom.activeState);
    } else {
        hide(dom.incomingState);
        hide(dom.connectingState);
        hide(dom.activeState);
        show(dom.idleState);
    }
}

// =========================================================
// STATE LOGGING
// =========================================================
function logCallState(newState, reason) {
    const prev = adminState.callState;
    if (prev === newState) return;
    const timestamp = new Date().toISOString();
    console.log(`[CallState] ${prev} → ${newState}${reason ? ` (${reason})` : ''} @ ${timestamp}`);
    adminState.callState = newState;
}

function transitionTo(newState, reason) {
    logCallState(newState, reason);
}

// =========================================================
// PEER ID PERSISTENCE
// =========================================================
function persistPeerId(id) {
    if (id) sessionStorage.setItem('adminPeerId', id);
}

function getStoredPeerId() {
    return sessionStorage.getItem('adminPeerId');
}

function generatePeerId() {
    const suffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    return `admin-${suffix}`;
}

// =========================================================
// SUPABASE: ADMIN SESSION
// =========================================================
async function registerAdminSession(openPeerId) {
    const storedAdminId = sessionStorage.getItem('adminUserID');
    if (!storedAdminId || !window.supabaseClient || !openPeerId) return null;
    const now = new Date().toISOString();

    try {
        const { data, error } = await window.supabaseClient
            .from('admins')
            .update({
                is_online: true,
                call_status: CALL_STATUS.available,
                peer_id: openPeerId,
                last_seen: now
            })
            .eq('id', storedAdminId)
            .select()
            .single();

        if (error || !data) {
            console.error('Failed to register admin session:', error);
            return null;
        }

        adminState.adminId = data.id;
        adminState.peerId = openPeerId;
        persistPeerId(adminState.peerId);
        console.log('[PeerJS] Peer ID saved to Supabase:', { adminId: adminState.adminId, peerId: adminState.peerId });
        return data;
    } catch (err) {
        console.error('Exception registering admin session:', err);
        return null;
    }
}

async function removeAdvertisedPeerId(peerId, reason) {
    if (!adminState.adminId || !window.supabaseClient) return;
    const { error } = await window.supabaseClient
        .from('admins')
        .update({ is_online: false, call_status: CALL_STATUS.offline, peer_id: null, last_seen: new Date().toISOString() })
        .eq('id', adminState.adminId)
        .eq('peer_id', peerId);
    if (error) console.error('[PeerJS] Failed to remove stale Peer ID:', { peerId, reason, error });
    else console.warn('[PeerJS] Removed unavailable Peer ID from Supabase:', { peerId, reason });
}

async function withdrawStalePeerAdvertisement() {
    const storedAdminId = sessionStorage.getItem('adminUserID');
    if (!storedAdminId || !window.supabaseClient) return;
    const { error } = await window.supabaseClient
        .from('admins')
        .update({ is_online: false, call_status: CALL_STATUS.offline, peer_id: null, last_seen: new Date().toISOString() })
        .eq('id', storedAdminId);
    if (error) throw error;
    console.log('[PeerJS] Removed any stale advertised Peer ID before initialization');
}

async function logPeerRegistration(peerId, context) {
    if (!window.supabaseClient || !peerId) return;
    const { data, error } = await window.supabaseClient
        .from('admins')
        .select('id, is_online, call_status, peer_id, last_seen')
        .eq('peer_id', peerId)
        .maybeSingle();
    console.log('[PeerJS] Peer registration diagnostic:', { context, peerId, exists: Boolean(data), adminOnline: data?.is_online, callStatus: data?.call_status, storedPeerId: data?.peer_id, error: error?.message || null });
}

function attachPeerConnectionDiagnostics(call) {
    const pc = call.peerConnection;
    if (!pc || pc.__safezoneDiagnosticsAttached) return;
    pc.__safezoneDiagnosticsAttached = true;
    pc.addEventListener('connectionstatechange', () => {
        const state = pc.connectionState;
        console.log('[WebRTC] PeerJS connection state:', { callerPeerId: call.peer, state });
        if (state === 'connected') {
            clearDisconnectRecoveryTimer();
        } else if (state === 'disconnected' && !adminState.isCleaningUp) {
            clearDisconnectRecoveryTimer();
            adminState.disconnectRecoveryTimer = window.setTimeout(() => {
                adminState.disconnectRecoveryTimer = null;
                if (!adminState.isCleaningUp && pc.connectionState === 'disconnected' && adminState.currentCall === call) {
                    console.warn('[Admin Call] Remote PeerJS connection did not recover');
                    endCurrentCall('peerjs-disconnected', { notifyRemote: true, updateStatus: true });
                }
            }, 3000);
        } else if (!adminState.isCleaningUp && (state === 'failed' || state === 'closed') && adminState.currentCall === call) {
            console.log('[Admin Call] Remote PeerJS connection ended:', state);
            endCurrentCall(`peerjs-${state}`, { notifyRemote: true, updateStatus: true });
        }
    });
    pc.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        console.log('[WebRTC] PeerJS ICE state:', { callerPeerId: call.peer, state });
        if (!adminState.isCleaningUp && (state === 'failed' || state === 'closed') && adminState.currentCall === call) {
            console.log('[Admin Call] Remote PeerJS ICE ended:', state);
            endCurrentCall(`peerjs-ice-${state}`, { notifyRemote: true, updateStatus: true });
        }
    });
    pc.addEventListener('icecandidateerror', (event) => {
        console.error('[WebRTC] PeerJS ICE candidate error:', { callerPeerId: call.peer, errorCode: event.errorCode, errorText: event.errorText, url: event.url });
    });
}

function clearMediaConnectionTimeout() {
    if (adminState.mediaConnectionTimer) {
        window.clearTimeout(adminState.mediaConnectionTimer);
        adminState.mediaConnectionTimer = null;
    }
}

function startMediaConnectionTimeout(callId, mediaCall = null) {
    clearMediaConnectionTimeout();
    adminState.mediaConnectionTimer = window.setTimeout(() => {
        adminState.mediaConnectionTimer = null;
        const activeCallId = String(adminState.activeAlertId || adminState.activeCallRecordId || adminState.incomingCallId || '');
        if (activeCallId !== String(callId) || adminState.callState === CALL_STATES.CONNECTED) return;
        console.error('[WebRTC] Connection timed out:', {
            callId,
            callerPeerId: adminState.callerPeerId,
            adminPeerId: adminState.peer?.id,
            peerOpen: adminState.peer?.open,
            peerDestroyed: adminState.peer?.destroyed,
            mediaOpen: mediaCall?.open,
            iceState: mediaCall?.peerConnection?.iceConnectionState,
            connectionState: mediaCall?.peerConnection?.connectionState
        });
        setStatus('Call connection timed out');
        endCurrentCall('connection-timeout', { notifyRemote: true, updateStatus: true });
    }, MEDIA_CONNECTION_TIMEOUT_MS);
}

function attachPeerConnectionDiagnosticsWhenReady(call, attempts = 8) {
    if (!call || attempts <= 0) return;
    if (call.peerConnection) {
        attachPeerConnectionDiagnostics(call);
        return;
    }
    window.setTimeout(() => attachPeerConnectionDiagnosticsWhenReady(call, attempts - 1), 250);
}

function attachAndPlayRemoteAudio(remoteStream) {
    if (!dom.remoteAudio) return;
    remoteStream.getTracks().forEach(track => {
        if (track.__safezoneEndHandlerAttached) return;
        track.__safezoneEndHandlerAttached = true;
        track.addEventListener('ended', () => {
            if (!adminState.isCleaningUp && adminState.remoteStream === remoteStream) {
                console.log('[Admin Call] Remote audio track ended');
                endCurrentCall('remote-audio-ended', { notifyRemote: true, updateStatus: true });
            }
        });
    });
    dom.remoteAudio.srcObject = remoteStream;
    const playResult = dom.remoteAudio.play?.();
    if (playResult?.catch) {
        playResult.catch(error => console.error('[WebRTC] Remote audio playback failed:', error));
    }
}

function schedulePeerReinitialization(reason) {
    if (adminState.isDestroyed || adminState.peerReconnectTimer) return;
    console.warn('[PeerJS] Scheduling fresh peer registration:', reason);
    adminState.peerReconnectTimer = window.setTimeout(async () => {
        adminState.peerReconnectTimer = null;
        if (adminState.isDestroyed) return;
        try {
            await initializeAdminPeer();
            console.log('[PeerJS] Admin peer reconnected:', adminState.peerId);
        } catch (error) {
            console.error('[PeerJS] Admin peer reconnect failed:', error);
            schedulePeerReinitialization('retry after failed reconnect');
        }
    }, 2000);
}

function installPeerCallHandlers(peer) {
    peer.on('call', (call) => {
        console.log('[PeerJS] Admin received incoming call:', { peerId: peer.id, callerPeerId: call.peer, metadata: call.metadata || null });
        // The shared emergency_alerts ID and the caller's PeerJS call ID may
        // differ. While this admin is ringing and has no media call yet, let
        // the incoming MediaConnection attach to that visible call panel.
        const peerAlertId = call.metadata?.alertId || call.metadata?.emergencyAlertId || call.metadata?.alert_id;
        if (peerAlertId && (adminState.claimedAlertIds.has(String(peerAlertId)) || adminState.declinedAlertIds.has(String(peerAlertId)))) {
            console.warn('[PeerJS] Closing call already claimed elsewhere or declined here:', peerAlertId);
            call.close();
            return;
        }
        const sameIncomingAlert = Boolean(adminState.incomingAlert
            && [CALL_STATES.RINGING, CALL_STATES.CONNECTING].includes(adminState.callState));
        if (adminState.incomingAlert && call.metadata?.alertId && String(call.metadata.alertId) !== String(adminState.incomingAlert.id)) {
            console.warn('[Call Debug] PeerJS alert ID differs from emergency_alerts ID; attaching to current ringing call:', { peerAlertId: call.metadata.alertId, alertId: adminState.incomingAlert.id });
        }
        if (peer !== adminState.peer || isOnCall() || adminState.incomingPeerCall || (adminState.callState !== CALL_STATES.IDLE && !sameIncomingAlert)) {
            console.warn('[PeerJS] Rejecting incoming call; admin is unavailable:', { callerPeerId: call.peer, state: adminState.callState });
            call.close();
            return;
        }

        adminState.incomingPeerCall = call;
        adminState.incomingCallId = String(adminState.activeAlertId || `peerjs-${call.connectionId || Date.now()}`);
        adminState.callerPeerId = call.peer;
        const deviceId = call.metadata?.callerDeviceId || call.metadata?.deviceId || null;
        adminState.activeAlertId = call.metadata?.alertId || call.metadata?.emergencyAlertId || call.metadata?.alert_id || adminState.activeAlertId || adminState.incomingCallId;
        updateCallerLocationPing(call.metadata, deviceId, adminState.activeAlertId || adminState.incomingCallId);
        handleIncomingPeerCallUI(deviceId);
        if (adminState.answerRequested) {
            answerCall().catch(error => console.error('[Call Debug] Queued answer failed:', error));
        }

        call.on('close', () => {
            console.log('[PeerJS] Incoming call closed:', { callerPeerId: call.peer, connectionId: call.connectionId });
            if (adminState.incomingPeerCall === call || adminState.currentCall === call) {
                endCurrentCall('peerjs-remote-close', { notifyRemote: true, updateStatus: Boolean(adminState.claimedCallId) });
            }
        });
        call.on('error', (error) => {
            console.error('[PeerJS] Incoming call error:', { type: error?.type, message: error?.message, callerPeerId: call.peer });
            if (adminState.incomingPeerCall === call || adminState.currentCall === call) {
                endCurrentCall('peerjs-error', { notifyRemote: true, updateStatus: Boolean(adminState.claimedCallId) });
            }
        });
    });
}

function handleIncomingPeerCallUI(deviceId) {
    if (adminState.callState === CALL_STATES.RINGING) {
        console.log('[Call Debug] PeerJS connection attached to existing incoming alert UI');
        return;
    }
    transitionTo(CALL_STATES.RINGING, 'PeerJS incoming call');
    adminState.answerInProgress = false;
    adminState.answerRequested = false;
    prepareIncomingCallControls();
    adminState.pendingIncomingUi = true;
    ensureIncomingCallUI();
    setStatus(deviceId ? `Incoming call from ${deviceId}` : 'Incoming call...');
    if (dom.incomingTitle) dom.incomingTitle.textContent = deviceId ? `Incoming call (${deviceId})` : 'Incoming call';
    playIncomingRingtone();
    console.log('[WebRTC] Incoming call displayed:', { callerPeerId: adminState.callerPeerId, callId: adminState.incomingCallId, deviceId });
}

function isEndedEmergencyAlert(record) {
    return TERMINAL_ALERT_STATUSES.has(String(record?.status || '').toLowerCase().trim());
}

function getEmergencyAlertTimestamp(record) {
    const value = record?.received_at || record?.created_at;
    const timestamp = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
}

function getAlertHandlerAdminId(record) {
    return record?.handled_by_admin_id
        ?? record?.answered_by_admin_id
        ?? null;
}

function getCallerDisplayId(record) {
    const value = record?.device_id || record?.deviceId || record?.caller_phone || null;
    const normalized = String(value || '').trim().toLowerCase();
    return !normalized || ['no number', 'no phone number', 'unknown', 'n/a', 'none'].includes(normalized)
        ? null
        : String(value).trim();
}

function maintainOwnedAcceptedCall(record) {
    const alertId = String(record?.id || adminState.activeAlertId || adminState.incomingCallId || '');
    console.log('[Realtime] This admin owns accepted call:', { alertId, adminId: adminState.adminId });
    console.log('[Call State] activeCall before update:', adminState.currentCall);
    if (record) adminState.incomingAlert = record;
    if (alertId) {
        adminState.activeAlertId = record?.id ?? adminState.activeAlertId;
        adminState.incomingCallId = adminState.incomingCallId || alertId;
        adminState.claimedCallId = adminState.claimedCallId || alertId;
    }
    adminState.callerPeerId = record?.caller_peer_id || record?.peer_id || adminState.callerPeerId;
    adminState.pendingIncomingUi = false;
    stopRingtone();
    if (adminState.callState === CALL_STATES.RINGING) {
        transitionTo(CALL_STATES.CONNECTING, 'accepted realtime update owned by this admin');
        ensureIncomingCallUI();
        setStatus('Connecting...');
    }
    console.log('[Call State] activeCall after update:', adminState.currentCall);
}

function handleEmergencyAlertIncomingCall(record, { source = 'unknown', eventType = null } = {}) {
    console.log('[Call Debug] Record:', record);
    console.log('[Call Debug] Status:', record?.status);
    const callerDeviceId = getCallerDisplayId(record);
    const callerPeerId = record?.caller_peer_id || record?.peer_id || null;
    const latitude = record?.latitude ?? record?.lat;
    const longitude = record?.longitude ?? record?.long ?? record?.lng;
    const handledByAdminId = getAlertHandlerAdminId(record);
    const wasAlreadyAccepted = Boolean(record?.accepted_at || record?.handled_at || handledByAdminId || record?.handled_by);
    const normalizedStatus = String(record?.status || '').toLowerCase().trim();
    console.log('[Call Debug] Caller device ID:', callerDeviceId);
    console.log('[Call Debug] Caller peer ID:', callerPeerId);
    console.log('[Call Debug] Coordinates:', { latitude, longitude });
    console.log('[Call Debug] Current admin is_online:', Boolean(adminState.adminId && adminState.peerReady));
    console.log('[Call Debug] Current admin call_status:', adminState.callState === CALL_STATES.IDLE ? CALL_STATUS.available : CALL_STATUS.busy);
    console.log('[Realtime] Call status changed:', normalizedStatus);
    console.log('[Realtime] Call handler:', handledByAdminId);

    if (!record?.id) {
        console.warn('[Call Debug] Incoming call rejected because: alert ID is missing');
        return;
    }
    const isCurrentAlert = String(adminState.activeAlertId || '') === String(record.id)
        || String(adminState.incomingAlert?.id || '') === String(record.id);
    if (isEndedEmergencyAlert(record)) {
        if (isCurrentAlert) {
            console.log('[Call Cleanup] Alert ended/cancelled; removing call UI');
            endCurrentCall(`realtime-status-${normalizedStatus}`, { notifyRemote: false, updateStatus: false });
        }
        return;
    }
    if (wasAlreadyAccepted) {
        if (handledByAdminId != null && String(handledByAdminId) === String(adminState.adminId || '')) {
            maintainOwnedAcceptedCall(record);
        } else {
            console.log('[Realtime] Another admin owns accepted call:', { alertId: record.id, handledByAdminId });
            handleCallAcceptedBroadcast(String(record.id), handledByAdminId == null ? null : String(handledByAdminId));
        }
        return;
    }
    if (isOnCall() && isCurrentAlert) {
        adminState.incomingAlert = record;
        console.log('[Call Debug] Active handling call location/status updated');
        return;
    }
    if (!RINGING_ALERT_STATUSES.has(normalizedStatus)) {
        if (isCurrentAlert && adminState.callState === CALL_STATES.RINGING) {
            console.log('[Call Cleanup] Alert is no longer ringing; removing stale call UI');
            cleanupCall();
        } else {
            console.log('[Call Init] Ignoring non-ringing call:', record.id, normalizedStatus || '(missing status)');
        }
        return;
    }
    const alertTimestamp = getEmergencyAlertTimestamp(record);
    const alertAge = alertTimestamp === null ? Infinity : Date.now() - alertTimestamp;
    if (!isCurrentAlert && (alertAge < 0 || alertAge > INCOMING_CALL_MAX_AGE_MS)) {
        console.log('[Call Init] Ignoring stale ringing call:', record.id, { ageMs: alertAge });
        return;
    }
    // A caller may insert the row first and set its waiting status in a second
    // request. A recent UPDATE into a ringable status is therefore just as
    // authoritative as an INSERT. The age check above prevents old rows from
    // being replayed as new calls.
    if (adminState.declinedAlertIds.has(String(record.id))) return;
    const adminCanRing = Boolean(adminState.adminId && adminState.peerReady);
    if (!adminCanRing && adminState.callState === CALL_STATES.IDLE) {
        console.log('[Call Debug] Incoming call ignored because this admin is not online and available');
        return;
    }
    if (isOnCall() && String(adminState.activeAlertId) !== String(record.id)) {
        console.warn('[Call Debug] Incoming call rejected because: admin already has an active call');
        return;
    }
    if (adminState.callState !== CALL_STATES.IDLE && String(adminState.activeAlertId) !== String(record.id)) {
        console.warn('[Call Debug] Incoming call rejected because: another incoming call is already displayed');
        return;
    }
    if (adminState.callState === CALL_STATES.RINGING && String(adminState.activeAlertId) === String(record.id)) {
        adminState.incomingAlert = record;
        console.log('[Call Debug] Incoming alert already displayed; location/status updated');
        return;
    }
    if (adminState.claimedAlertIds.has(String(record.id))) {
        console.log('[Call Debug] Incoming call rejected because: another admin already claimed this alert');
        return;
    }

    console.log('[Incoming Call] New realtime call validated:', record.id);
    adminState.answerInProgress = false;
    adminState.answerRequested = false;
    adminState.incomingAlert = record;
    adminState.activeAlertId = record.id;
    adminState.incomingCallId = String(record.id);
    adminState.callerPeerId = callerPeerId || adminState.callerPeerId;
    adminState.pendingIncomingUi = true;
    prepareIncomingCallControls();
    console.log('[Incoming] New call:', record.id);
    console.log('[Incoming] Caller peer:', callerPeerId);
    console.log('[Incoming] Answer enabled:', !dom.answerCallButton?.disabled);
    console.log('[Call Debug] Calling incoming UI handler');
    console.log('[Call Debug] Showing incoming call UI');
    console.log('[Incoming Call] UI handler started', record);
    transitionTo(CALL_STATES.RINGING, 'emergency_alerts incoming call');
    ensureIncomingCallUI();
    setStatus(callerDeviceId ? `Incoming call from ${callerDeviceId}` : 'Incoming call...');
    if (dom.incomingTitle) dom.incomingTitle.textContent = callerDeviceId ? `Incoming call (${callerDeviceId})` : 'Incoming call';
    playIncomingRingtone();
    console.log('[Call Debug] Waiting → Incoming');
}

function updateCallerLocationPing(metadata = {}, callerInfo = '', alertId = null) {
    const latitude = metadata?.latitude ?? metadata?.lat;
    const longitude = metadata?.longitude ?? metadata?.long ?? metadata?.lng;
    if (typeof window.cacheCallerLocationAlert !== 'function') {
        console.warn('[Caller Location] Dashboard map helper is unavailable');
        return;
    }
    const alert = { id: alertId, latitude, longitude, caller_phone: callerInfo, status: 'active' };
    window.cacheCallerLocationAlert(alert);
    if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
        console.warn('[Caller Location] Caller did not provide valid location metadata:', { latitude, longitude, callerInfo });
    }
}

function showCallerLocationForClaimedCall() {
    if (!adminState.activeAlertId || typeof window.showClaimedCallerLocation !== 'function') return;
    window.showClaimedCallerLocation(adminState.activeAlertId)
        .then(shown => console.log('[Caller Location] Claimed-call marker result:', { alertId: adminState.activeAlertId, shown }))
        .catch(error => console.error('[Caller Location] Failed to show claimed-call marker:', error));
}

async function updateClaimedAlertStatus(status, callId = adminState.activeAlertId || adminState.claimedCallId) {
    if (!window.supabaseClient || !callId || !adminState.adminId) return false;
    const { error } = await window.supabaseClient
        .from('emergency_alerts')
        .update({ status })
        .eq('id', callId)
        .eq('answered_by_admin_id', adminState.adminId);
    if (error) {
        console.error('[Call] Failed to update claimed alert status:', { callId, status, error });
        return false;
    }
    console.log('[Call] Claimed alert status update accepted:', { callId, status });
    return true;
}

async function markClaimedCallEnded(callId) {
    const updated = await updateClaimedAlertStatus('resolved', callId);
    console.log('[Admin Call] End status synchronized:', { callId, updated });
    return updated;
}

async function unsubscribeActiveAlertLifecycle() {
    const channel = adminState.activeAlertChannel;
    adminState.activeAlertChannel = null;
    if (channel && window.supabaseClient) {
        try { await window.supabaseClient.removeChannel(channel); } catch (error) {
            console.warn('[Admin Call] Failed to remove active-call subscription:', error);
        }
    }
}

async function subscribeToActiveAlertLifecycle(callId) {
    if (!window.supabaseClient || !callId) return;
    await unsubscribeActiveAlertLifecycle();
    const normalizedCallId = String(callId);
    const channel = window.supabaseClient
        .channel(`active-emergency-call-${normalizedCallId}-${adminState.adminId}`)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'emergency_alerts',
            filter: `id=eq.${normalizedCallId}`
        }, payload => {
            const record = payload.new || payload.old;
            const eventCallId = String(record?.id || '');
            const status = String(record?.status || '').toLowerCase().trim();
            const activeCallId = String(adminState.activeAlertId || adminState.activeCallRecordId || adminState.incomingCallId || adminState.claimedCallId || '');
            console.log('[Admin Call] Active-call realtime update:', { eventType: payload.eventType, eventCallId, activeCallId, status });
            if (!eventCallId || eventCallId !== activeCallId) return;
            if (payload.eventType === 'DELETE' || TERMINAL_ALERT_STATUSES.has(status)) {
                console.log('[Admin Call] Caller end detected from Supabase:', { callId: eventCallId, status: status || 'deleted' });
                stopCallTimer();
                endCurrentCall(`remote-status-${status || 'deleted'}`, { notifyRemote: false, updateStatus: false });
            }
        });
    adminState.activeAlertChannel = channel;
    channel.subscribe((status, error) => {
        console.log('[Admin Call] Active-call subscription:', { callId: normalizedCallId, status, error: error || null });
    });
}

async function claimIncomingCall(callId) {
    const normalizedCallId = String(callId || '');
    if (!normalizedCallId || !adminState.adminId || !adminState.peerId) {
        throw new Error('Cannot claim call because the call or admin identity is missing');
    }

    if (adminState.claimedCallId === normalizedCallId) return true;
    if (!window.supabaseClient || !adminState.activeAlertId) throw new Error('The database claim service is unavailable');

    console.log(`[Admin Call] Atomically claiming call: ${normalizedCallId}`);
    const { data, error } = await window.supabaseClient.rpc('claim_emergency_call', {
        p_alert_id: Number(adminState.activeAlertId),
        p_admin_id: Number(adminState.adminId),
        p_admin_peer_id: String(adminState.peerId)
    });
    if (error) throw new Error(`Emergency alert claim failed: ${error.message}`);
    const claimedRecord = Array.isArray(data) ? data[0] : data;
    const handledByAdminId = getAlertHandlerAdminId(claimedRecord);
    console.log('[Answer] Claim result:', claimedRecord || null);
    console.log('[Answer] Handler admin:', handledByAdminId);
    console.log('[Answer] Current admin:', adminState.adminId);
    if (!claimedRecord || String(handledByAdminId) !== String(adminState.adminId)) {
        handleCallAcceptedBroadcast(normalizedCallId, null);
        return false;
    }

    adminState.claimedCallId = normalizedCallId;
    adminState.incomingAlert = claimedRecord;
    adminState.activeAlertId = claimedRecord.id;
    adminState.callerPeerId = claimedRecord.caller_peer_id || claimedRecord.peer_id || adminState.callerPeerId;
    await subscribeToActiveAlertLifecycle(normalizedCallId);
    await broadcastSignaling('call-accepted', {
        callId: normalizedCallId,
        acceptedBy: String(adminState.adminId),
        acceptedPeerId: adminState.peerId
    });

    console.log('[Admin Call] Call claimed successfully');
    return true;
}

async function validateCallerPeerPresence(callerPeerId, timeoutMs = 2500) {
    if (!callerPeerId || !adminState.peer?.open || adminState.peer.destroyed) return false;
    return new Promise(resolve => {
        let settled = false;
        let connection = null;
        const finish = (reachable) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            try { connection?.close(); } catch (_) { /* ignore */ }
            resolve(reachable);
        };
        const timeout = window.setTimeout(() => finish(false), timeoutMs);
        try {
            connection = adminState.peer.connect(String(callerPeerId), {
                reliable: true,
                metadata: { type: 'safezone-call-presence-check' }
            });
            connection.on('open', () => finish(true));
            connection.on('error', () => finish(false));
            connection.on('close', () => finish(false));
        } catch (_) {
            finish(false);
        }
    });
}

async function waitForCallerPeerPresence(callerPeerId, { attempts = 4, retryDelayMs = 250 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        console.log('[PeerJS] Checking caller registration:', { callerPeerId, attempt, attempts });
        if (await validateCallerPeerPresence(callerPeerId, 750)) {
            console.log('[PeerJS] Caller is registered on this signaling server:', callerPeerId);
            return true;
        }
        if (attempt < attempts) {
            await new Promise(resolve => window.setTimeout(resolve, retryDelayMs));
        }
    }
    return false;
}

async function refreshCurrentIncomingAlert(callId) {
    if (!window.supabaseClient || !callId) return adminState.incomingAlert;
    const { data, error } = await window.supabaseClient
        .from('emergency_alerts')
        .select('*')
        .eq('id', callId)
        .maybeSingle();
    if (error) {
        console.warn('[Answer] Could not refresh current alert before PeerJS lookup:', error);
        return adminState.incomingAlert;
    }
    if (!data) throw new Error(`Emergency call ${callId} no longer exists`);
    if (isEndedEmergencyAlert(data)) throw new Error(`Emergency call ${callId} already ended`);
    const handledByAdminId = getAlertHandlerAdminId(data);
    if (handledByAdminId != null && String(handledByAdminId) !== String(adminState.adminId || '')) {
        handleCallAcceptedBroadcast(String(callId), String(handledByAdminId));
        throw new Error(`Emergency call ${callId} was answered by another admin`);
    }
    adminState.incomingAlert = data;
    adminState.callerPeerId = data.caller_peer_id || data.peer_id || adminState.callerPeerId;
    console.log('[Answer] Refreshed caller PeerJS ID:', adminState.callerPeerId);
    return data;
}

async function restoreGenuinelyActiveIncomingCall() {
    if (!window.supabaseClient || adminState.callState !== CALL_STATES.IDLE) return;
    console.log('[Call Init] Checking active calls...');
    const cutoff = new Date(Date.now() - INCOMING_CALL_MAX_AGE_MS).toISOString();
    const { data, error } = await window.supabaseClient
        .from('emergency_alerts')
        .select('*')
        .in('status', [...RINGING_ALERT_STATUSES])
        .is('answered_by_admin_id', null)
        .is('accepted_at', null)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(5);
    if (error) {
        console.error('[Call Init] Active-call check failed:', error);
        return;
    }
    for (const alert of data || []) {
        console.log('[Call Init] Alert:', alert?.id, alert?.status);
        console.log('[Incoming Call] Recent ringing alert restored:', alert.id);
        handleEmergencyAlertIncomingCall(alert, { source: 'database-restore' });
        return;
    }
    console.log('[Call Init] No genuine active caller found');
}

async function pollForIncomingEmergencyCalls() {
    if (!window.supabaseClient || adminState.dispatchPollInFlight || adminState.isDestroyed) return;
    if (isOnCall() || adminState.callState === CALL_STATES.CONNECTING) return;
    adminState.dispatchPollInFlight = true;
    try {
        const cutoff = new Date(Date.now() - INCOMING_CALL_MAX_AGE_MS).toISOString();
        const { data, error } = await window.supabaseClient
            .from('emergency_alerts')
            .select('*')
            .in('status', [...RINGING_ALERT_STATUSES])
            .gte('created_at', cutoff)
            .order('created_at', { ascending: false })
            .limit(5);
        if (error) throw error;
        const alert = (data || []).find(row => {
            const id = String(row?.id || '');
            return id && !adminState.claimedAlertIds.has(id) && !adminState.declinedAlertIds.has(id);
        });
        if (alert) handleEmergencyAlertIncomingCall(alert, { source: 'database-poll', eventType: 'INSERT' });
    } catch (error) {
        console.error('[Incoming Call] Database polling failed:', error);
    } finally {
        adminState.dispatchPollInFlight = false;
    }
}

function startIncomingCallPolling() {
    if (adminState.dispatchPollTimer) return;
    pollForIncomingEmergencyCalls();
    adminState.dispatchPollTimer = window.setInterval(pollForIncomingEmergencyCalls, 2500);
    console.log('[Incoming Call] Database polling fallback started');
}

function stopIncomingCallPolling() {
    if (adminState.dispatchPollTimer) window.clearInterval(adminState.dispatchPollTimer);
    adminState.dispatchPollTimer = null;
    adminState.dispatchPollInFlight = false;
}

async function initializeAdminPeer() {
    if (typeof window.Peer !== 'function') throw new Error('PeerJS library did not load');
    adminState.isDestroyed = false;
    await withdrawStalePeerAdvertisement();
    const requestedPeerId = generatePeerId();
    console.log('[PeerJS] Admin peer initializing:', requestedPeerId);

    return new Promise((resolve, reject) => {
        const peer = new window.Peer(requestedPeerId);
        adminState.peer = peer;
        installPeerCallHandlers(peer); // Listener exists before this ID is advertised.

        peer.on('open', async (openPeerId) => {
            adminState.peerReady = true;
            console.log('[PeerJS] Admin peer open:', openPeerId);
            try {
                const session = await registerAdminSession(openPeerId);
                if (!session) throw new Error('Could not save active Peer ID to Supabase');
                await logPeerRegistration(openPeerId, 'after peer open');
                resolve(session);
            } catch (error) {
                console.error('[PeerJS] Peer opened but could not be advertised:', { peerId: openPeerId, error });
                try { peer.destroy(); } catch (_) { /* ignore */ }
                reject(error);
            }
        });

        peer.on('disconnected', () => {
            adminState.peerReady = false;
            console.warn('[PeerJS] Admin peer disconnected:', peer.id);
            removeAdvertisedPeerId(peer.id, 'disconnected').catch(() => {});
            try { peer.destroy(); } catch (_) { /* ignore */ }
            if (adminState.peer === peer) adminState.peer = null;
            schedulePeerReinitialization('disconnected');
        });
        peer.on('close', () => {
            adminState.peerReady = false;
            console.warn('[PeerJS] Admin peer closed:', peer.id);
            if (!adminState.isDestroyed) {
                removeAdvertisedPeerId(peer.id, 'closed').catch(() => {});
                if (adminState.peer === peer) adminState.peer = null;
                schedulePeerReinitialization('closed');
            }
        });
        peer.on('error', (error) => {
            const signalingFailure = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(error?.type);
            if (signalingFailure) adminState.peerReady = false;
            console.error('[PeerJS] Admin peer error:', { type: error?.type, message: error?.message, peerId: peer.id, online: !peer.destroyed });
            logPeerRegistration(peer.id, `PeerJS error: ${error?.type || 'unknown'}`).catch(() => {});
            if (error?.type === 'unavailable-id') {
                removeAdvertisedPeerId(peer.id, 'unavailable-id').catch(() => {});
            }
            if (signalingFailure && !adminState.isDestroyed) {
                try { peer.destroy(); } catch (_) { /* ignore */ }
                if (adminState.peer === peer) adminState.peer = null;
                schedulePeerReinitialization(`PeerJS ${error.type}`);
            }
        });
        peer.on('connection', (connection) => {
            console.log('[PeerJS] Data connection received:', { peerId: peer.id, callerPeerId: connection.peer });
            connection.close(); // Calls use PeerJS MediaConnection, not an unused data channel.
        });
    });
}

async function setCallStatus(status) {
    if (!adminState.adminId || !window.supabaseClient) return;
    try {
        const { error } = await window.supabaseClient
            .from('admins')
            .update({
                call_status: status,
                last_seen: new Date().toISOString()
            })
            .eq('id', adminState.adminId);
        if (error) throw error;
        console.log('[CallStatus] Updated:', status, 'admin:', adminState.adminId);
    } catch (err) {
        console.error('Failed to update call status:', err);
    }
}

async function restoreAvailableAdminState(reason) {
    if (!adminState.adminId || !adminState.peerId || !adminState.peerReady || isOnCall() || adminState.callState !== CALL_STATES.IDLE) return;
    try {
        const { error } = await window.supabaseClient
            .from('admins')
            .update({
                is_online: true,
                call_status: CALL_STATUS.available,
                peer_id: adminState.peerId,
                last_seen: new Date().toISOString()
            })
            .eq('id', adminState.adminId);
        if (error) throw error;
        console.log('[AdminSession] Restored available peer state:', { reason, adminId: adminState.adminId, peerId: adminState.peerId });
    } catch (error) {
        console.error('[AdminSession] Failed to restore available peer state:', { reason, error });
    }
}

async function clearAdminSession() {
    if (!adminState.adminId || !window.supabaseClient) return;
    try {
        await window.supabaseClient
            .from('admins')
            .update({
                is_online: false,
                call_status: CALL_STATUS.offline,
                peer_id: null,
                last_seen: new Date().toISOString()
            })
            .eq('id', adminState.adminId);
    } catch (err) {
        console.error('Failed to clear admin session:', err);
    }
}

// =========================================================
// CALL DISPATCH: SUPABASE REALTIME BROADCAST
// =========================================================
async function subscribeToCallDispatches() {
    if (!window.supabaseClient) return;
    try {
        if (adminState.dispatchChannel) {
            try { await window.supabaseClient.removeChannel(adminState.dispatchChannel); } catch (e) { /* ignore */ }
            adminState.dispatchChannel = null;
        }

        adminState.dispatchChannel = window.supabaseClient.channel(CALL_DISPATCH_CHANNEL, {
            config: { broadcast: { self: true } }
        });

        adminState.dispatchChannel.on('broadcast', { event: 'call-offer' }, (payload) => {
            sanitizeHandleCallOffer(payload);
        });

        adminState.dispatchChannel.on('broadcast', { event: 'call-answer' }, (payload) => {
            sanitizeHandleCallAnswer(payload);
        });

        adminState.dispatchChannel.on('broadcast', { event: 'call-ice-candidate' }, (payload) => {
            sanitizeHandleCallIceCandidate(payload);
        });

        adminState.dispatchChannel.on('broadcast', { event: 'call-accepted' }, (payload) => {
            sanitizeHandleCallAcceptedBroadcast(payload);
        });

        adminState.dispatchChannel.on('broadcast', { event: 'call-ended' }, (payload) => {
            sanitizeHandleCallEndedBroadcast(payload);
        });

        adminState.dispatchChannel.on('broadcast', { event: 'call-claim' }, (payload) => {
            sanitizeHandleCallClaim(payload);
        });

        // Flutter callers create and update emergency_alerts rows directly.
        // Database changes are the authoritative incoming-call transport; the
        // broadcast handlers above remain for backward compatibility only.
        adminState.dispatchChannel.on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'emergency_alerts'
        }, payload => {
            const record = payload.new || payload.old;
            console.log('[Incoming Call] emergency_alerts realtime event:', payload.eventType, record?.id || null);
            handleEmergencyAlertIncomingCall(record, {
                source: 'realtime',
                eventType: payload.eventType
            });
        });

        adminState.dispatchReady = new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error('Supabase Realtime subscription timed out')), 10000);
            adminState.dispatchChannel.subscribe((status, err) => {
                console.log('[CallDispatch] Subscription status:', status, err || '');
                if (status === 'SUBSCRIBED') {
                    window.clearTimeout(timeout);
                    resolve();
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    window.clearTimeout(timeout);
                    reject(err || new Error(`Supabase Realtime subscription ${status}`));
                }
            });
        });
        await adminState.dispatchReady;
        console.log('[CallDispatch] Ready for incoming calls on channel:', CALL_DISPATCH_CHANNEL);
    } catch (e) {
        console.error('Failed to subscribe to call dispatches:', e);
        adminState.dispatchChannel = null;
    }
}

// Supabase Realtime invokes broadcast listeners with { event, payload, type }.
// Accept the raw payload too so the handler remains compatible with direct tests.
function getBroadcastData(message) {
    return message && typeof message === 'object' && message.payload && typeof message.payload === 'object'
        ? message.payload
        : (message || {});
}

function sanitizeHandleCallOffer(payload) {
    const { callId, from, sdp, to, callerDeviceId, deviceId, latitude, longitude, lat, long, lng, alertId, emergencyAlertId, alert_id } = getBroadcastData(payload);
    if (!callId || !from || !sdp) {
        console.warn('[CallDispatch] Ignored malformed call offer:', payload);
        return;
    }
    if (!adminState.peerId) {
        console.warn('[CallDispatch] Ignored offer before admin identity was ready:', callId);
        return;
    }
    if (from === adminState.peerId) return;
    if (to && to !== adminState.peerId) return;
    console.log('[CallDispatch] Offer received:', { callId, from, to: to || 'all-online-admins', callerDeviceId: callerDeviceId || deviceId || null });
    handleCallOffer(callId, from, adminState.peerId, sdp, callerDeviceId || deviceId || null, { latitude: latitude ?? lat, longitude: longitude ?? long ?? lng, alertId: alertId || emergencyAlertId || alert_id || callId });
}

function sanitizeHandleCallAnswer(payload) {
    const { callId, from, to, sdp } = getBroadcastData(payload);
    if (!callId || !from || !to || !sdp) return;
    if (to !== adminState.peerId) return;
    handleCallAnswer(callId, from, to, sdp);
}

function sanitizeHandleCallIceCandidate(payload) {
    const { callId, from, to, candidate } = getBroadcastData(payload);
    if (!callId || !from || !to || !candidate) return;
    if (to !== adminState.peerId) return;
    handleCallIceCandidate(callId, from, to, candidate);
}

function sanitizeHandleCallAcceptedBroadcast(payload) {
    const data = getBroadcastData(payload);
    const callId = typeof data.callId === 'string' ? data.callId : null;
    if (!callId) return;
    const activeCallId = adminState.activeCallRecordId || adminState.incomingCallId;
    if (activeCallId !== callId) return;
    const acceptedBy = typeof data.acceptedBy === 'string' ? data.acceptedBy : null;
    handleCallAcceptedBroadcast(callId, acceptedBy);
}

function sanitizeHandleCallEndedBroadcast(payload) {
    const data = getBroadcastData(payload);
    const callId = typeof data.callId === 'string' ? data.callId : null;
    if (!callId) return;
    if (String(adminState.activeAlertId || '') === callId && typeof window.clearCallerLocationPing === 'function') window.clearCallerLocationPing(callId);
    const activeCallId = adminState.activeCallRecordId || adminState.incomingCallId;
    if (String(activeCallId || '') !== callId) return;
    handleCallEndedBroadcast(callId);
}

function sanitizeHandleCallClaim(payload) {
    const { callId, adminId, peerId } = getBroadcastData(payload);
    if (!callId || !adminId || !peerId) return;
    const activeCallId = adminState.incomingCallId;
    if (activeCallId !== callId) return;
    adminState.callClaims.set(String(adminId), { adminId: String(adminId), peerId: String(peerId) });
    console.log('[CallDispatch] Answer claim received:', { callId, adminId, peerId });
}

// =========================================================
// WEBRTC PEER CONNECTION
// =========================================================
function isOnCall() {
    if (adminState.callState === CALL_STATES.CONNECTED) return true;
    if (adminState.currentCall?.open === true) return true;
    return Boolean(window.MeteredCall?.isConnected?.());
}

async function createPeerConnection() {
    if (adminState.pc) {
        adminState.pc.close();
        adminState.pc = null;
    }
    adminState.pc = new RTCPeerConnection(null);
    if (!Array.isArray(adminState.iceCandidatesQueue)) adminState.iceCandidatesQueue = [];

    adminState.pc.ontrack = (e) => {
        console.log('[Admin Call] Remote stream received');
        if (!adminState.remoteStream) {
            adminState.remoteStream = new MediaStream();
        }
        adminState.remoteStream.addTrack(e.track);
        if (dom.remoteAudio && dom.remoteAudio.srcObject !== adminState.remoteStream) {
            attachAndPlayRemoteAudio(adminState.remoteStream);
            console.log('[WebRTC] Remote stream attached');
        }
        if (adminState.callState !== CALL_STATES.CONNECTED) {
            clearMediaConnectionTimeout();
            transitionTo(CALL_STATES.CONNECTED, 'remote track received');
            startCallTimer();
            updateClaimedAlertStatus('ongoing').catch(() => {});
            if (isDashboard()) {
                hide(dom.connectingState);
                show(dom.activeState);
                setStatus('Call active');
            }
            console.log('[Admin Call] Call connected');
        }
    };

    adminState.pc.onicecandidate = async (e) => {
        if (!e.candidate) return;
        const callId = adminState.activeCallRecordId || adminState.incomingCallId;
        if (!callId) {
            // createOffer/setLocalDescription can emit candidates before the
            // application has assigned a call ID. Keep them for the answer.
            adminState.pendingOutgoingIce.push(e.candidate.toJSON());
            console.log('[WebRTC] Buffered early ICE candidate');
            return;
        }
        const target = adminState.callerPeerId || adminState.targetPeerId;
        if (!target) {
            adminState.pendingOutgoingIce.push(e.candidate.toJSON());
            return;
        }
        await broadcastSignaling('call-ice-candidate', {
            callId,
            from: adminState.peerId,
            to: target,
            candidate: e.candidate.toJSON()
        });
    };

    adminState.pc.onconnectionstatechange = () => {
        const state = adminState.pc ? adminState.pc.connectionState : 'null';
        console.log('[pc] connection state:', state);
        if (state === 'connected') {
            clearDisconnectRecoveryTimer();
            clearMediaConnectionTimeout();
            transitionTo(CALL_STATES.CONNECTED, 'peer connected');
            startCallTimer();
            updateClaimedAlertStatus('ongoing').catch(() => {});
            if (isDashboard()) {
                hide(dom.connectingState);
                show(dom.activeState);
                setStatus('Call active');
            }
            console.log('[Admin Call] Call connected');
        } else if (!adminState.isCleaningUp && state === 'disconnected') {
            clearDisconnectRecoveryTimer();
            adminState.disconnectRecoveryTimer = window.setTimeout(() => {
                adminState.disconnectRecoveryTimer = null;
                if (!adminState.isCleaningUp && adminState.pc?.connectionState === 'disconnected') {
                    console.warn('[pc] disconnected state did not recover');
                    endCurrentCall('rtc-disconnected', { notifyRemote: true, updateStatus: true });
                }
            }, 3000);
        } else if (!adminState.isCleaningUp && (state === 'failed' || state === 'closed')) {
            console.warn('[pc] connection failed or closed:', state);
            endCurrentCall(`rtc-${state}`, { notifyRemote: true, updateStatus: true });
        }
    };
}

async function broadcastSignaling(event, payload = {}) {
    if (!window.supabaseClient) return;
    let channel = adminState.dispatchChannel;
    if (!channel) {
        channel = window.supabaseClient.channel(CALL_DISPATCH_CHANNEL, {
            config: { broadcast: { self: true } }
        });
        adminState.dispatchChannel = channel;
        try {
            adminState.dispatchReady = new Promise((resolve, reject) => {
                channel.subscribe((status, err) => {
                    if (status === 'SUBSCRIBED') resolve();
                    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') reject(err || new Error(status));
                });
            });
            await adminState.dispatchReady;
        } catch (e) {
            console.error('[WebRTC] Failed to subscribe broadcast channel:', e);
            return;
        }
    }
    try {
        if (adminState.dispatchReady) await adminState.dispatchReady;
        console.log('[CallDispatch] Sending:', event, payload.callId || '');
        const result = await channel.send({
            type: 'broadcast',
            event,
            payload
        });
        if (result !== 'ok') console.warn('[CallDispatch] Broadcast result:', event, result);
    } catch (e) {
        console.error('[WebRTC] Broadcast failed:', event, e);
    }
}

// =========================================================
// INCOMING CALL HANDLERS
// =========================================================
function handleCallOffer(callId, from, to, sdp, callerDeviceId = null, callerLocation = {}) {
    const offeredAlertId = callerLocation.alertId || callId;
    const attachesToVisibleAlert = [CALL_STATES.RINGING, CALL_STATES.CONNECTING].includes(adminState.callState)
        && String(adminState.activeAlertId || '') === String(offeredAlertId);
    if (adminState.callState !== CALL_STATES.IDLE && !attachesToVisibleAlert) return;
    if (isOnCall()) return;

    adminState.incomingCallId = callId;
    adminState.callerPeerId = from;
    adminState.pendingOffer = sdp;
    adminState.callClaims.clear();
    adminState.activeAlertId = offeredAlertId;
    updateCallerLocationPing(callerLocation, callerDeviceId || from, adminState.activeAlertId);

    transitionTo(CALL_STATES.RINGING, 'incoming offer');
    if (isDashboard()) {
        adminState.pendingIncomingUi = true;
        ensureIncomingCallUI();
        setStatus(callerDeviceId ? `Incoming call from ${callerDeviceId}` : 'Incoming call...');
        if (dom.incomingTitle) dom.incomingTitle.textContent = callerDeviceId
            ? `Incoming call (${callerDeviceId})`
            : 'Incoming call';
        playIncomingRingtone();
    }
    console.log('[WebRTC] Incoming call displayed:', { from, callId, callerDeviceId });
    if (adminState.answerRequested) {
        answerCall().catch(error => console.error('[Call Debug] Queued answer failed:', error));
    }
}

async function answerCall() {
    if (adminState.incomingPeerCall) {
        await answerPeerJsCall();
        return;
    }
    if (!adminState.pendingOffer || !adminState.incomingCallId) {
        console.warn('[WebRTC] No pending offer to answer.');
        return;
    }

    if (adminState.answerInProgress) return;
    adminState.answerInProgress = true;
    adminState.answerRequested = false;
    try {
    const callId = adminState.incomingCallId;
    const callerPeerId = adminState.callerPeerId;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    adminState.localStream = stream;
    if (!await claimIncomingCall(callId)) {
        stream.getTracks().forEach(track => track.stop());
        adminState.localStream = null;
        return;
    }

    await setCallStatus(CALL_STATUS.busy);
    console.log('[Admin Call] Accepting WebRTC call');

    await createPeerConnection();
    stream.getTracks().forEach(track => adminState.pc.addTrack(track, stream));

    const offerDesc = new RTCSessionDescription({
        type: 'offer',
        sdp: adminState.pendingOffer
    });
    await adminState.pc.setRemoteDescription(offerDesc);

    // Flush queued ICE candidates
    while (adminState.iceCandidatesQueue.length > 0) {
        const candidate = adminState.iceCandidatesQueue.shift();
        try {
            await adminState.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('[WebRTC] Failed to add queued ICE candidate:', e);
        }
    }

    const answer = await adminState.pc.createAnswer();
    await adminState.pc.setLocalDescription(answer);

    adminState.activeCallRecordId = callId;
    adminState.callerPeerId = callerPeerId;

    await broadcastSignaling('call-answer', {
        callId,
        from: adminState.peerId,
        to: callerPeerId,
        sdp: adminState.pc.localDescription.sdp
    });

    showCallerLocationForClaimedCall();

    adminState.pendingOffer = null;

    transitionTo(CALL_STATES.CONNECTING, 'answer sent');

    if (isDashboard()) {
        adminState.pendingIncomingUi = false;
        hide(dom.incomingState);
        show(dom.connectingState);
        hide(dom.activeState);
        setStatus('Connecting...');
    }

    adminState.currentCall = { open: true };
    startMediaConnectionTimeout(callId);

    startStatsPolling();

    console.log('[WebRTC] Answered call:', callId);
    } catch (err) {
        console.error(`[Admin Call] Answer failed: ${err?.message || err}`, err);
        await endCurrentCall('webrtc-answer-failed', { notifyRemote: true, updateStatus: Boolean(adminState.claimedCallId) });
    } finally {
        adminState.answerInProgress = false;
    }
}

async function answerPeerJsCall() {
    const call = adminState.incomingPeerCall;
    if (!call || adminState.answerInProgress) return;
    adminState.answerInProgress = true;
    adminState.answerRequested = false;
    try {
        const callId = String(adminState.incomingCallId || adminState.activeAlertId || '');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log('[WebRTC] Local stream ready');
        console.log('[WebRTC] Audio tracks:', stream.getAudioTracks().length);
        adminState.localStream = stream;
        if (!await claimIncomingCall(callId)) {
            stream.getTracks().forEach(track => track.stop());
            adminState.localStream = null;
            return;
        }
        await setCallStatus(CALL_STATUS.busy);
        console.log('[Admin Call] Accepting WebRTC call');
        adminState.currentCall = call;
        adminState.incomingPeerCall = null;
        adminState.activeCallRecordId = adminState.incomingCallId;
        adminState.pendingIncomingUi = false;
        stopRingtone();
        transitionTo(CALL_STATES.CONNECTING, 'PeerJS call answered');
        hide(dom.incomingState);
        show(dom.connectingState);
        setStatus('Connecting...');

        call.on('stream', (remoteStream) => {
            console.log('[WebRTC] Remote stream received');
            clearMediaConnectionTimeout();
            adminState.remoteStream = remoteStream;
            attachAndPlayRemoteAudio(remoteStream);
            transitionTo(CALL_STATES.CONNECTED, 'PeerJS remote stream received');
            startCallTimer();
            updateClaimedAlertStatus('ongoing').catch(() => {});
            hide(dom.connectingState);
            show(dom.activeState);
            setStatus('Call active');
            console.log('[Admin Call] Call connected');
        });
        call.answer(stream);
        startMediaConnectionTimeout(callId, call);
        showCallerLocationForClaimedCall();
        attachPeerConnectionDiagnosticsWhenReady(call);
        console.log('[PeerJS] Admin answered incoming call:', { callerPeerId: call.peer, adminPeerId: adminState.peerId });
    } catch (error) {
        console.error(`[Admin Call] Answer failed: ${error?.message || error}`, error);
        await endCurrentCall('peerjs-answer-failed', { notifyRemote: true, updateStatus: Boolean(adminState.claimedCallId) });
    } finally {
        adminState.answerInProgress = false;
    }
}

async function startClaimedPeerJsCall(stream) {
    const callId = String(adminState.incomingCallId || adminState.activeAlertId || '');
    const callerPeerId = String(adminState.callerPeerId || '');
    if (!callId || !callerPeerId || !adminState.peer?.open) {
        throw new Error('The claimed caller PeerJS identity is unavailable');
    }

    console.log('[WebRTC] Current call ID:', callId);
    console.log('[WebRTC] Caller peer ID:', callerPeerId);
    console.log('[WebRTC] Admin peer ready:', adminState.peerReady);
    console.log('[WebRTC] Peer open:', adminState.peer?.open);
    console.log('[WebRTC] Peer destroyed:', adminState.peer?.destroyed);
    console.log('[WebRTC] Admin peer ID:', adminState.peer?.id);
    console.log('[WebRTC] Starting connection...');
    console.log('[WebRTC] Calling peer:', callerPeerId);
    console.log('[Admin Call] Calling claimed caller peer:', { callId, callerPeerId });
    const call = adminState.peer.call(callerPeerId, stream, {
        metadata: {
            alertId: adminState.activeAlertId,
            adminId: adminState.adminId,
            adminPeerId: adminState.peerId
        }
    });
    adminState.localStream = stream;
    adminState.currentCall = call;
    adminState.activeCallRecordId = callId;
    adminState.pendingIncomingUi = false;

    call.on('stream', (remoteStream) => {
        console.log('[WebRTC] Remote stream received');
        clearMediaConnectionTimeout();
        adminState.remoteStream = remoteStream;
        attachAndPlayRemoteAudio(remoteStream);
        transitionTo(CALL_STATES.CONNECTED, 'claimed PeerJS caller connected');
        startCallTimer();
        updateClaimedAlertStatus('ongoing').catch(() => {});
        hide(dom.connectingState);
        show(dom.activeState);
        setStatus('Ongoing Call');
        startStatsPolling();
    });
    call.on('close', () => {
        if (adminState.currentCall === call) {
            endCurrentCall('peerjs-remote-close', { notifyRemote: true, updateStatus: true });
        }
    });
    call.on('error', (error) => {
        console.error('[Admin Call] Claimed caller PeerJS error:', error);
        if (adminState.currentCall === call) {
            endCurrentCall('peerjs-error', { notifyRemote: true, updateStatus: true });
        }
    });
    attachPeerConnectionDiagnosticsWhenReady(call);
    startMediaConnectionTimeout(callId, call);
    console.log('[WebRTC] Waiting for remote stream');
}

async function startCall() {
    if (!isDashboard()) return;
    if (adminState.callState !== CALL_STATES.IDLE) return;
    if (isOnCall()) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        adminState.localStream = stream;

        await createPeerConnection();

        stream.getTracks().forEach(track => {
            adminState.pc.addTrack(track, stream);
        });

        const offer = await adminState.pc.createOffer();
        await adminState.pc.setLocalDescription(offer);

        const callId = `call-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        adminState.activeCallRecordId = callId;
        adminState.targetPeerId = null;

        await broadcastSignaling('call-offer', {
            callId,
            from: adminState.peerId,
            sdp: adminState.pc.localDescription.sdp
        });

        console.log('[CallDispatch] Caller started / offer broadcast:', { callId, from: adminState.peerId });

        transitionTo(CALL_STATES.CONNECTING, 'call initiated');
        adminState.currentCall = { open: true };

        if (isDashboard()) {
            hide(dom.idleState);
            hide(dom.incomingState);
            show(dom.connectingState);
            hide(dom.activeState);
            setStatus('Calling...');
        }

        startStatsPolling();

        console.log('[WebRTC] Call initiated:', callId);
    } catch (err) {
        console.error('[WebRTC] Failed to start call:', err);
        if (adminState.localStream) {
            adminState.localStream.getTracks().forEach(track => track.stop());
            adminState.localStream = null;
        }
        if (adminState.pc) {
            adminState.pc.close();
            adminState.pc = null;
        }
        adminState.activeCallRecordId = null;
        adminState.currentCall = null;
        setStatus('Failed to start call');
        resetUI();
    }
}

async function handleCallAnswer(callId, from, to, sdp) {
    if (!adminState.pc || callId !== adminState.activeCallRecordId) return;

    adminState.callerPeerId = from;

    while (adminState.pendingOutgoingIce.length > 0) {
        const candidate = adminState.pendingOutgoingIce.shift();
        try {
            await broadcastSignaling('call-ice-candidate', {
                callId,
                from: adminState.peerId,
                to: from,
                candidate
            });
        } catch (e) {
            console.error('[WebRTC] Failed to send buffered ICE candidate:', e);
        }
    }

    try {
        const answerDesc = new RTCSessionDescription({
            type: 'answer',
            sdp: sdp
        });
        await adminState.pc.setRemoteDescription(answerDesc);
        console.log('[WebRTC] Set remote answer for:', callId);
    } catch (e) {
        console.error('[WebRTC] Failed to set remote answer:', e);
    }
}

async function handleCallIceCandidate(callId, from, to, candidate) {
    const activeCallId = adminState.activeCallRecordId || adminState.incomingCallId;
    if (String(callId) !== String(activeCallId || '')) return;
    if (to !== adminState.peerId) return;
    if (!adminState.pc) {
        adminState.iceCandidatesQueue.push(candidate);
        return;
    }
    try {
        if (adminState.pc.remoteDescription && adminState.pc.remoteDescription.type) {
            await adminState.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
            adminState.iceCandidatesQueue.push(candidate);
        }
    } catch (e) {
        console.error('[WebRTC] Failed to add ICE candidate:', e);
    }
}

function handleCallAcceptedBroadcast(callId, acceptedBy) {
    if (String(acceptedBy) === String(adminState.adminId || '')) {
        return;
    }

    const isMyIncoming = adminState.incomingCallId === callId;
    if (!isMyIncoming) return;

    adminState.claimedAlertIds.add(String(adminState.activeAlertId || callId));

    const shouldNotify = adminState.callState === CALL_STATES.RINGING || adminState.pendingIncomingUi;

    if (adminState.pc) {
        adminState.pc.close();
        adminState.pc = null;
    }
    const unacceptedPeerCall = adminState.incomingPeerCall;
    if (unacceptedPeerCall && typeof unacceptedPeerCall.close === 'function') {
        try { unacceptedPeerCall.close(); } catch (_) { /* ignore */ }
    }
    adminState.incomingPeerCall = null;
    if (typeof window.clearCallerLocationPing === 'function') {
        window.clearCallerLocationPing(adminState.activeAlertId || callId);
    }

    adminState.incomingCallId = null;
    adminState.pendingOffer = null;
    adminState.pendingIncomingUi = false;
    adminState.incomingAlert = null;
    adminState.callerPeerId = null;
    adminState.answerRequested = false;
    stopRingtone();
    hide(dom.connectingState);
    transitionTo(CALL_STATES.IDLE, 'call accepted by another admin');
    if (shouldNotify) {
        setStatus('Call answered by another admin');
        showAlreadyAnswered();
    } else {
        hide(dom.incomingState);
        show(dom.idleState);
        setStatus('Waiting for call...');
    }
}

function handleCallEndedBroadcast(callId) {
    console.log('[WebRTC] Call ended broadcast received:', callId);
    const activeCallId = adminState.activeCallRecordId || adminState.incomingCallId;
    if (String(activeCallId || '') !== String(callId)) return;
    if (typeof window.clearCallerLocationPing === 'function') window.clearCallerLocationPing(adminState.activeAlertId || callId);
    adminState.claimedAlertIds.delete(String(adminState.activeAlertId || callId));
    console.log('[Admin Call] Remote ended:', callId);
    endCurrentCall('remote-broadcast', { notifyRemote: false, updateStatus: false });
}

// =========================================================
// CALLEE ACTIONS
// =========================================================
async function acceptCall() {
    console.log('[Answer] Answer button clicked');
    console.log('[Call] Current alert:', adminState.incomingAlert);
    console.log('[Call Debug] Answer state:', { state: adminState.callState, alertId: adminState.activeAlertId });
    if (!isDashboard()) return;
    if (adminState.callState !== CALL_STATES.RINGING) return;
    if (dom.answerCallButton?.disabled) return;
    if (dom.answerCallButton) dom.answerCallButton.disabled = true;
    adminState.answerRequested = true;
    const callId = String(adminState.incomingCallId || adminState.activeAlertId || '');
    console.log('[Answer] Claiming call:', callId);
    try {
        await ensureMeteredCallLoaded();
        await refreshCurrentIncomingAlert(callId);
        if (!await claimIncomingCall(callId)) return;
        console.log('[Call] Call successfully claimed');
        await setCallStatus(CALL_STATUS.busy);
        // The Flutter caller uses status=accepted as its signal to join the
        // same Metered room. Normalize the status even if an older claim RPC
        // only populated the answered/handled ownership columns.
        if (!await updateClaimedAlertStatus('accepted', callId)) {
            throw new Error('Could not notify the caller that the call was accepted');
        }
        transitionTo(CALL_STATES.CONNECTING, 'database claim won');
        ensureIncomingCallUI();
        setStatus('Connecting...');
        adminState.currentCall = { transport: 'metered', alertId: callId };
        const meteredAlertId = String(adminState.activeAlertId || adminState.incomingCallId || callId);
        console.log('[Admin Call] Metered alertId used for room join:', { callId, activeAlertId: adminState.activeAlertId, meteredAlertId });
        await window.MeteredCall.joinCall({
            alertId: meteredAlertId,
            role: 'admin',
            onConnected: ({ stream }) => {
                if (String(adminState.activeAlertId || '') !== callId || adminState.isCleaningUp) return;
                adminState.remoteStream = stream;
                transitionTo(CALL_STATES.CONNECTED, 'Metered remote audio received');
                ensureIncomingCallUI();
                setStatus('Ongoing Call');
                startCallTimer();
                showCallerLocationForClaimedCall();
            },
            onRemoteLeft: ({ reason }) => {
                if (!adminState.isCleaningUp) endCurrentCall(`metered-${reason}`, { notifyRemote: false, updateStatus: true });
            },
            onError: ({ error, reason }) => {
                console.error('[Admin Call] Metered connection error:', reason, error);
                if (!adminState.isCleaningUp) {
                    setStatus('Audio connection failed');
                    endCurrentCall(`metered-${reason}`, { notifyRemote: false, updateStatus: true });
                }
            },
            onStateChange: ({ to }) => {
                if (String(adminState.activeAlertId || '') !== callId || adminState.isCleaningUp) return;
                if (to === 'reconnecting') setStatus('Reconnecting audio...');
            }
        });
        if (adminState.callState === CALL_STATES.CONNECTING && !adminState.isCleaningUp) {
            setStatus('Waiting for caller to connect...');
        }
    } catch (error) {
        console.error('[Admin Call] Could not claim incoming call:', error);
        if (adminState.claimedCallId) {
            await endCurrentCall('connection-start-failed', { notifyRemote: true, updateStatus: true });
            return;
        }
        if (!adminState.incomingCallId || !adminState.incomingAlert || /already ended/i.test(error?.message || '')) {
            cleanupCall();
            return;
        }
        // A database/RPC failure means nobody claimed the call. Keep this
        // admin ringing so the call is not mistaken for an ended call and the
        // Answer button can be retried after the server-side issue is fixed.
        adminState.answerRequested = false;
        transitionTo(CALL_STATES.RINGING, 'claim failed; incoming call retained');
        adminState.pendingIncomingUi = true;
        ensureIncomingCallUI();
        setStatus('Unable to claim call — please retry');
    } finally {
        if (!adminState.claimedCallId && dom.answerCallButton) dom.answerCallButton.disabled = false;
    }
}

async function rejectCall() {
    console.log('[Admin Call] Cancel button clicked:', {
        activeAlertId: adminState.activeAlertId,
        incomingCallId: adminState.incomingCallId,
        adminId: adminState.adminId
    });
    const callId = String(adminState.activeAlertId || adminState.activeCallRecordId || adminState.incomingCallId || '');
    if (!callId || !window.supabaseClient || !adminState.adminId) {
        console.error('[Admin Call] Cancel prerequisites missing:', { callId, hasSupabase: Boolean(window.supabaseClient), adminId: adminState.adminId });
        if (dom.incomingTitle) dom.incomingTitle.textContent = 'Unable to cancel call';
        return;
    }
    if (dom.cancelCallButton) dom.cancelCallButton.disabled = true;
    if (dom.incomingTitle) dom.incomingTitle.textContent = 'Cancelling call...';
    setStatus('Cancelling call...');
    console.log('[Admin Call] Cancelling incoming call:', { callId, adminId: adminState.adminId });
    try {
        const { data, error } = await window.supabaseClient.rpc('cancel_emergency_call', {
            p_alert_id: Number(callId),
            p_admin_id: Number(adminState.adminId),
            p_admin_peer_id: String(adminState.peerId)
        });
        if (error?.code === 'PGRST202') {
            throw new Error('Database setup required: run supabase_atomic_call_claim.sql in the Supabase SQL Editor');
        }
        if (error) throw error;
        const cancelledRecord = Array.isArray(data) ? data[0] : data;
        if (!cancelledRecord) throw new Error('This call was already handled or is no longer ringing');
        adminState.declinedAlertIds.add(callId);
        await broadcastSignaling('call-ended', { callId, from: adminState.peerId, reason: 'admin-cancelled' });
        console.log('[Admin Call] Cancellation recorded:', { callId, adminId: adminState.adminId, adminName: cancelledRecord.answered_by_admin_fullname });
        cleanupCall();
    } catch (error) {
        console.error('[Admin Call] Could not cancel incoming call:', error);
        if (dom.incomingTitle) dom.incomingTitle.textContent = 'Unable to cancel - please retry';
        if (dom.cancelCallButton) dom.cancelCallButton.disabled = false;
        setStatus('Unable to cancel call — please retry');
    }
}

function endCall() {
    return endCurrentCall('admin-ended', { notifyRemote: true, updateStatus: true });
}

async function endCurrentCall(reason, { notifyRemote = false, updateStatus = false } = {}) {
    const callId = String(adminState.activeAlertId || adminState.activeCallRecordId || adminState.incomingCallId || adminState.claimedCallId || '');
    if (!callId || adminState.isEndingCall || adminState.isCleaningUp) return;
    adminState.isEndingCall = true;
    console.log('[Admin Call] Active call:', callId);
    console.log(reason === 'admin-ended' ? '[Admin Call] Local end:' : '[Admin Call] Ending:', callId, reason);
    const synchronizationTasks = [];
    try {
        if (notifyRemote) {
            synchronizationTasks.push(broadcastSignaling('call-ended', {
                callId,
                from: adminState.peerId,
                reason
            }));
        }
        if (updateStatus && adminState.claimedCallId) {
            synchronizationTasks.push(markClaimedCallEnded(callId));
        }
        // Local teardown must never wait for the network. This makes the admin
        // ready for the next distinct emergency_alerts.id immediately.
        cleanupCall({ finishAlert: false });
        const results = await Promise.allSettled(synchronizationTasks);
        results.forEach(result => {
            if (result.status === 'rejected') {
                console.error('[Admin Call] End synchronization failed:', { callId, reason, error: result.reason });
            }
        });
    } catch (error) {
        console.error('[Admin Call] End lifecycle failed:', { callId, reason, error });
        cleanupCall({ finishAlert: false });
    }
}

function cleanupCall({ finishAlert = false } = {}) {
    console.trace('[Call Cleanup] cleanupCall() executed', {
        finishAlert,
        callState: adminState.callState,
        activeAlertId: adminState.activeAlertId,
        claimedCallId: adminState.claimedCallId
    });
    if (adminState.isCleaningUp) return;
    adminState.isCleaningUp = true;
    unsubscribeActiveAlertLifecycle().catch(() => {});
    clearMediaConnectionTimeout();
    clearDisconnectRecoveryTimer();
    stopCallTimer();
    const claimedAlertId = adminState.claimedCallId || adminState.activeAlertId;
    const visibleAlertId = adminState.activeAlertId || adminState.incomingCallId || adminState.claimedCallId;
    if (visibleAlertId && typeof window.clearCallerLocationPing === 'function') {
        window.clearCallerLocationPing(visibleAlertId);
    }
    if (finishAlert && claimedAlertId) {
        updateClaimedAlertStatus('resolved', claimedAlertId).catch(error => console.error('[Call] Failed to finish alert:', error));
    }
    stopRingtone();
    if (window.MeteredCall) {
        window.MeteredCall.endCall('admin-cleanup').catch(error => console.warn('[Metered] Cleanup failed:', error));
    }
    if (adminState.pc) {
        console.log('[Admin Call] Closing WebRTC peer connection');
        adminState.pc.close();
        adminState.pc = null;
    }
    if (adminState.localStream) {
        adminState.localStream.getTracks().forEach(track => track.stop());
        adminState.localStream = null;
    }
    const peerCall = adminState.incomingPeerCall || adminState.currentCall;
    if (peerCall && typeof peerCall.close === 'function') {
        console.log('[Admin Call] Closing PeerJS media connection');
        try { peerCall.close(); } catch (_) { /* ignore */ }
    }
    adminState.incomingPeerCall = null;
    adminState.currentCall = null;
    adminState.incomingCallId = null;
    adminState.activeCallRecordId = null;
    adminState.activeAlertId = null;
    adminState.incomingAlert = null;
    adminState.pendingOffer = null;
    adminState.answerRequested = false;
    adminState.callerPeerId = null;
    adminState.targetPeerId = null;
    adminState.pendingOutgoingIce = [];
    adminState.callClaims.clear();
    adminState.claimedCallId = null;
    stopStatsPolling();
    Promise.resolve(resetUI()).finally(() => {
        adminState.isCleaningUp = false;
        adminState.isEndingCall = false;
        console.log('[Admin Call] Cleanup complete');
        console.log('[Cleanup] Call state reset:', {
            currentAlert: adminState.incomingAlert,
            activeCall: adminState.currentCall,
            isAnswering: adminState.answerInProgress,
            isEndingCall: adminState.isEndingCall,
            peerReady: adminState.peerReady && Boolean(adminState.peer?.open),
            answerEnabled: !dom.answerCallButton?.disabled
        });
    });
}

// =========================================================
// AUDIO
// =========================================================
let ringtoneAudio = null;

function playIncomingRingtone() {
    stopRingtone();
    try {
        ringtoneAudio = new Audio('https://www.soundjay.com/buttons/beep-01a.mp3');
        ringtoneAudio.volume = 0.8;
        ringtoneAudio.loop = true;
        ringtoneAudio.play().catch(() => {});
    } catch (e) {
        /* ignore */
    }
}

function stopRingtone() {
    if (ringtoneAudio) {
        try { ringtoneAudio.pause(); } catch (e) { /* ignore */ }
        ringtoneAudio = null;
    }
}

// =========================================================
// UI: ALREADY ANSWERED NOTIFICATION
// =========================================================
function showAlreadyAnswered() {
    if (!isDashboard()) return;
    hide(dom.idleState);
    hide(dom.activeState);

    if (dom.incomingTitle) dom.incomingTitle.textContent = 'Call Answered';
    if (dom.incomingContainer) {
        dom.incomingContainer.innerHTML = `<p class="text-white/80 text-xs">This call has been answered by another administrator.</p>`;
    }
    show(dom.incomingState);

    if (adminState.alreadyAnsweredTimeout) clearTimeout(adminState.alreadyAnsweredTimeout);
    adminState.alreadyAnsweredTimeout = setTimeout(() => {
        hide(dom.incomingState);
        show(dom.idleState);
        restoreIncomingButtons();
    }, ALREADY_ANSWERED_DISPLAY_MS);
}

function restoreIncomingButtons() {
    if (!dom.incomingContainer) return;
    dom.incomingContainer.innerHTML = `
        <div class="flex flex-col items-center gap-1">
            <button id="answerCallButton" type="button" class="relative z-10 w-11 h-11 rounded-full bg-green-500 hover:bg-green-400 active:scale-95 flex items-center justify-center transition-transform">
                <svg class="w-5 h-5 fill-white" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C11.4 21 3 12.6 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
            </button>
            <span class="text-green-300 text-xs">Accept</span>
        </div>
        <div class="flex flex-col items-center gap-1">
            <button id="cancelCallButton" type="button" class="relative z-10 w-11 h-11 rounded-full bg-red-500 hover:bg-red-400 active:scale-95 flex items-center justify-center transition-transform">
                <svg class="w-5 h-5 fill-white" viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.1.3-4.5.7v3.1c0 .4-.2.8-.5 1-.8.5-1.6 1.1-2.2 1.8-.3.3-.8.3-1.1 0L1.1 13c-.3-.3-.3-.8 0-1.1C3.4 9.4 7.5 8 12 8s8.6 1.4 10.9 3.9c.3.3.3.8 0 1.1l-2.6 2.6c-.3.3-.8.3-1.1 0-.7-.7-1.4-1.3-2.2-1.8-.3-.2-.5-.6-.5-1V9.7C15.1 9.3 13.6 9 12 9z"/></svg>
            </button>
            <span class="text-red-300 text-xs">Reject</span>
        </div>
    `;
    bindAnswerButton();
    bindCancelButton();
}

// =========================================================
// STATS POLLING & GRAPHS
// =========================================================
function startStatsPolling() {
    stopStatsPolling();
    if (!adminState.bitrateGraph && dom.bitrateCanvas) {
        adminState.bitrateSeries = new TimelineDataSeries();
        adminState.targetBitrateSeries = new TimelineDataSeries();
        adminState.targetBitrateSeries.setColor('blue');
        adminState.headerrateSeries = new TimelineDataSeries();
        adminState.headerrateSeries.setColor('green');
        adminState.bitrateGraph = new TimelineGraphView(dom.bitrateGraph || 'bitrateGraph', dom.bitrateCanvas || 'bitrateCanvas');
        adminState.bitrateGraph.setDataSeries([adminState.bitrateSeries, adminState.headerrateSeries, adminState.targetBitrateSeries]);
        adminState.bitrateGraph.updateEndDate();
    }
    if (!adminState.packetGraph && dom.packetCanvas) {
        adminState.packetSeries = new TimelineDataSeries();
        adminState.packetGraph = new TimelineGraphView(dom.packetGraph || 'packetGraph', dom.packetCanvas || 'packetCanvas');
        adminState.packetGraph.setDataSeries([adminState.packetSeries]);
        adminState.packetGraph.updateEndDate();
    }
    if (!adminState.audioLevelGraph && dom.audioLevelCanvas) {
        adminState.audioLevelSeries = new TimelineDataSeries();
        adminState.audioLevelGraph = new TimelineGraphView(dom.audioLevelGraph || 'audioLevelGraph', dom.audioLevelCanvas || 'audioLevelCanvas');
        adminState.audioLevelGraph.setDataSeries([adminState.audioLevelSeries]);
        adminState.audioLevelGraph.updateEndDate();
    }

    adminState.statsInterval = window.setInterval(() => {
        if (!adminState.pc) return;
        const sender = adminState.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (!sender) return;
        sender.getStats().then(res => {
            res.forEach(report => {
                let bytes;
                let headerBytes;
                let packets;
                if (report.type === 'outbound-rtp') {
                    if (report.isRemote) return;
                    const now = report.timestamp;
                    bytes = report.bytesSent;
                    headerBytes = report.headerBytesSent;
                    packets = report.packetsSent;
                    if (adminState.lastResult && adminState.lastResult.has(report.id)) {
                        const deltaT = (now - adminState.lastResult.get(report.id).timestamp) / 1000;
                        if (deltaT > 0) {
                            const bitrate = 8 * (bytes - adminState.lastResult.get(report.id).bytesSent) / deltaT;
                            const headerrate = 8 * (headerBytes - adminState.lastResult.get(report.id).headerBytesSent) / deltaT;

                            if (adminState.bitrateSeries) adminState.bitrateSeries.addPoint(now, bitrate);
                            if (adminState.headerrateSeries) adminState.headerrateSeries.addPoint(now, headerrate);
                            if (adminState.targetBitrateSeries && report.targetBitrate) {
                                adminState.targetBitrateSeries.addPoint(now, report.targetBitrate);
                            }
                            if (adminState.bitrateGraph) {
                                adminState.bitrateGraph.setDataSeries([adminState.bitrateSeries, adminState.headerrateSeries, adminState.targetBitrateSeries]);
                                adminState.bitrateGraph.updateEndDate();
                            }

                            if (adminState.packetSeries) {
                                adminState.packetSeries.addPoint(now, (packets - adminState.lastResult.get(report.id).packetsSent) / deltaT);
                            }
                            if (adminState.packetGraph) {
                                adminState.packetGraph.setDataSeries([adminState.packetSeries]);
                                adminState.packetGraph.updateEndDate();
                            }
                        }
                    }
                }
            });
            adminState.lastResult = res;
        });
    }, 1000);
}

function stopStatsPolling() {
    if (adminState.statsInterval) {
        clearInterval(adminState.statsInterval);
        adminState.statsInterval = null;
    }
}

// =========================================================
// TIMELINE GRAPH IMPLEMENTATION
// =========================================================
class TimelineDataSeries {
    constructor() {
        this.data = [];
        this.color = '#0f0';
    }
    setColor(color) {
        this.color = color;
    }
    addPoint(time, value) {
        this.data.push({ time, value });
        if (this.data.length > 2000) {
            this.data = this.data.slice(-1500);
        }
    }
    clear() {
        this.data = [];
    }
}

class TimelineGraphView {
    constructor(graphDiv, canvas) {
        this.graphDiv = typeof graphDiv === 'string' ? document.getElementById(graphDiv) : graphDiv;
        this.canvas = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
        this.dataSeries = [];
        this.endTime = Date.now();
        this.startTime = this.endTime;
        this.initialized = false;
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d');
            this.resizeCanvas();
            this.draw();
            if (typeof window !== 'undefined') {
                window.addEventListener('resize', () => this.resizeCanvas());
            }
        }
    }
    resizeCanvas() {
        if (!this.canvas) return;
        const parent = this.canvas.parentElement;
        if (!parent) return;
        this.canvas.width = parent.clientWidth || 320;
        this.canvas.height = parent.clientHeight || 120;
        this.initialized = true;
    }
    updateEndDate() {
        this.endTime = Date.now();
        if (this.dataSeries.length > 0) {
            const allTimes = this.dataSeries.flatMap(s => s.data.map(d => d.time));
            if (allTimes.length > 0) {
                this.startTime = Math.min(this.startTime, Math.min(...allTimes));
                this.endTime = Math.max(this.endTime, Math.max(...allTimes));
            }
        }
        this.draw();
    }
    setDataSeries(series) {
        this.dataSeries = series;
        this.updateEndDate();
    }
    draw() {
        if (!this.ctx || !this.canvas || !this.initialized) return;
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, w, h);
        const range = this.endTime - this.startTime || 1;
        let minVal = Infinity, maxVal = -Infinity;
        this.dataSeries.forEach(s => {
            s.data.forEach(d => {
                if (d.value < minVal) minVal = d.value;
                if (d.value > maxVal) maxVal = d.value;
            });
        });
        if (!isFinite(minVal)) minVal = 0;
        if (!isFinite(maxVal)) maxVal = 1;
        const padding = 10;
        const graphH = h - padding * 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padding + (graphH * i) / 4;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        this.dataSeries.forEach(series => {
            ctx.strokeStyle = series.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            let first = true;
            series.data.forEach(d => {
                const x = ((d.time - this.startTime) / range) * w;
                const y = padding + graphH - ((d.value - minVal) / (maxVal - minVal || 1)) * graphH;
                if (first) {
                    ctx.moveTo(x, y);
                    first = false;
                } else {
                    ctx.lineTo(x, y);
                }
            });
            ctx.stroke();
        });
        const mid = (maxVal + minVal) / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '10px monospace';
        ctx.fillText(maxVal.toFixed(0), 2, padding + 8);
        ctx.fillText(mid.toFixed(0), 2, padding + graphH / 2 + 3);
        ctx.fillText(minVal.toFixed(0), 2, padding + graphH - 2);
    }
}

// =========================================================
// UI RESET & RESOURCE CLEANUP
// =========================================================
async function resetUI() {
    stopCallTimer();
    if (adminState.localStream) {
        adminState.localStream.getTracks().forEach(track => track.stop());
        adminState.localStream = null;
    }
    if (dom.remoteAudio && dom.remoteAudio.srcObject) {
        dom.remoteAudio.srcObject.getTracks().forEach(track => track.stop());
        dom.remoteAudio.srcObject = null;
    }

    if (adminState.alreadyAnsweredTimeout) {
        clearTimeout(adminState.alreadyAnsweredTimeout);
        adminState.alreadyAnsweredTimeout = null;
    }

    adminState.pendingIncomingUi = false;
    adminState.remoteStream = null;
    adminState.incomingCallId = null;
    adminState.activeCallRecordId = null;
    adminState.currentCall = null;
    adminState.lastResult = null;
    adminState.pendingOffer = null;
    adminState.callerPeerId = null;
    adminState.targetPeerId = null;
    adminState.iceCandidatesQueue = [];
    adminState.pendingOutgoingIce = [];
    adminState.callClaims.clear();
    adminState.answerInProgress = false;
    adminState.answerRequested = false;
    enableAnswerButton();

    if (adminState.bitrateGraph) {
        adminState.bitrateGraph.dataSeries = [];
        adminState.bitrateGraph.draw();
    }
    if (adminState.packetGraph) {
        adminState.packetGraph.dataSeries = [];
        adminState.packetGraph.draw();
    }
    if (adminState.audioLevelGraph) {
        adminState.audioLevelGraph.dataSeries = [];
        adminState.audioLevelGraph.draw();
    }

    hide(dom.incomingState);
    hide(dom.activeState);
    show(dom.idleState);
    setStatus('Waiting for call...');

    transitionTo(CALL_STATES.IDLE, 'UI reset');
    if (dom.incomingTitle) dom.incomingTitle.textContent = 'Incoming call';
    if (!adminState.isDestroyed && adminState.adminId) {
        const stillLoggedIn = sessionStorage.getItem('adminLoggedIn') === 'true';
        if (stillLoggedIn) {
            await setCallStatus(CALL_STATUS.available);
        } else {
            await clearAdminSession();
        }
    }
}

function destroyPeer() {
    adminState.isDestroyed = true;
    adminState.peerReady = false;
    stopIncomingCallPolling();
    window.clearTimeout(adminState.peerReconnectTimer);
    adminState.peerReconnectTimer = null;
    stopRingtone();

    if (adminState.localStream) {
        adminState.localStream.getTracks().forEach(track => track.stop());
        adminState.localStream = null;
    }
    if (adminState.pc) {
        adminState.pc.close();
        adminState.pc = null;
    }
    if (adminState.peer) {
        try { adminState.peer.destroy(); } catch (_) { /* ignore */ }
        adminState.peer = null;
    }
    adminState.incomingPeerCall = null;
    if (adminState.dispatchChannel && window.supabaseClient) {
        window.supabaseClient.removeChannel(adminState.dispatchChannel).catch(() => {});
        adminState.dispatchChannel = null;
    }
    unsubscribeActiveAlertLifecycle().catch(() => {});
    adminState.remoteStream = null;
    adminState.currentCall = null;
    adminState.incomingCallId = null;
    adminState.activeCallRecordId = null;
    adminState.pendingOffer = null;
    adminState.answerRequested = false;
    adminState.callerPeerId = null;
    adminState.targetPeerId = null;
    adminState.pendingOutgoingIce = [];
    stopStatsPolling();
}

// =========================================================
// APP NAVIGATION GUARD
// =========================================================
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

// =========================================================
// LIFECYCLE HOOKS
// =========================================================
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
    console.log('[CallState] Window focused, current state:', adminState.callState, 'isOnCall:', isOnCall());
    ensureIncomingCallUI();
    restoreAvailableAdminState('window focused');
    pollForIncomingEmergencyCalls();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollForIncomingEmergencyCalls();
});

window.cleanupAdminSession = async function() {
    await clearAdminSession();
    destroyPeer();
};

window.acceptCall = acceptCall;
window.rejectCall = rejectCall;
window.endCall = endCall;
window.isOnCall = isOnCall;
window.handleEmergencyAlertIncomingCall = handleEmergencyAlertIncomingCall;

// =========================================================
// INITIALIZATION
// =========================================================
async function init() {
    cacheDomReferences();
    // Metered creates its media peer only after this admin wins the claim.
    // A lightweight per-tab identity is sufficient for Supabase ownership.
    adminState.isDestroyed = false;
    await withdrawStalePeerAdvertisement();
    const sessionId = generatePeerId();
    const session = await registerAdminSession(sessionId);
    if (!session) throw new Error('Could not register the admin call session');
    adminState.peerReady = true;
    console.log('[AdminSession] Ready:', { adminId: adminState.adminId, sessionId });
    await subscribeToCallDispatches();
    startIncomingCallPolling();
    if (typeof window.drainPendingRealtimeIncomingAlerts === 'function') {
        window.drainPendingRealtimeIncomingAlerts();
    }
    await restoreGenuinelyActiveIncomingCall();
    console.log('[Call Init] Ready; historical emergency alerts were not replayed as incoming calls');
    console.log('[Call Init] Initialized for admin:', adminState.adminId, 'session:', adminState.peerId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        init().catch((err) => console.error('init failed:', err));
    });
} else {
    init().catch((err) => console.error('init failed:', err));
}
