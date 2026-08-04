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

// Per-admin state container
const adminState = {
    callState: CALL_STATES.IDLE,
    pc: null,
    localStream: null,
    remoteStream: null,
    currentCall: null,
    incomingCallId: null,
    callerPeerId: null,
    targetPeerId: null,
    timerInterval: null,
    seconds: 0,
    isDestroyed: false,
    adminId: null,
    peerId: null,
    activeCallRecordId: null,
    pendingIncomingUi: false,
    alreadyAnsweredTimeout: null,
    dispatchChannel: null,
    pendingOffer: null,
    iceCandidatesQueue: [],
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
    dom.activeState = document.getElementById('activeState');
    dom.callTimer = document.getElementById('callTimer');
    dom.remoteAudio = document.getElementById('remoteAudio');
    dom.incomingTitle = dom.incomingState ? dom.incomingState.querySelector('p') : null;
    dom.incomingContainer = dom.incomingState ? dom.incomingState.querySelector('.flex') : null;
}

const isDashboard = () => Boolean(dom.idleState && dom.incomingState && dom.activeState);

// =========================================================
// UI HELPERS
// =========================================================
function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
}

function ensureIncomingCallUI() {
    if (!isDashboard()) return;
    if (isOnCall()) {
        hide(dom.idleState);
        hide(dom.incomingState);
        show(dom.activeState);
    } else if (adminState.pendingIncomingUi || adminState.incomingCallId) {
        hide(dom.idleState);
        show(dom.incomingState);
        hide(dom.activeState);
    } else {
        hide(dom.incomingState);
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
                is_online: true,
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

        adminState.adminId = data.id;
        adminState.peerId = data.peer_id || newPeerId;
        persistPeerId(adminState.peerId);
        return data;
    } catch (err) {
        console.error('Exception registering admin session:', err);
        return null;
    }
}

async function setCallStatus(status) {
    if (!adminState.adminId || !window.supabaseClient) return;
    try {
        await window.supabaseClient
            .from('admins')
            .update({
                call_status: status,
                last_seen: new Date().toISOString()
            })
            .eq('id', adminState.adminId);
    } catch (err) {
        console.error('Failed to update call status:', err);
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

        await adminState.dispatchChannel.subscribe();
        console.log('[CallDispatch] Subscribed to channel:', CALL_DISPATCH_CHANNEL);
    } catch (e) {
        console.error('Failed to subscribe to call dispatches:', e);
        adminState.dispatchChannel = null;
    }
}

function sanitizeHandleCallOffer(payload) {
    const { callId, from, sdp } = payload || {};
    if (!callId || !from || !sdp) return;
    if (!adminState.peerId) return;
    handleCallOffer(callId, from, adminState.peerId, sdp);
}

function sanitizeHandleCallAnswer(payload) {
    const { callId, from, to, sdp } = payload || {};
    if (!callId || !from || !to || !sdp) return;
    if (to !== adminState.peerId) return;
    handleCallAnswer(callId, from, to, sdp);
}

function sanitizeHandleCallIceCandidate(payload) {
    const { callId, from, to, candidate } = payload || {};
    if (!callId || !from || !to || !candidate) return;
    if (to !== adminState.peerId) return;
    handleCallIceCandidate(callId, from, to, candidate);
}

function sanitizeHandleCallAcceptedBroadcast(payload) {
    const callId = typeof payload?.callId === 'string' ? payload.callId : null;
    if (!callId || adminState.incomingCallId !== callId) return;
    const acceptedBy = typeof payload?.acceptedBy === 'string' ? payload.acceptedBy : null;
    handleCallAcceptedBroadcast(callId, acceptedBy);
}

function sanitizeHandleCallEndedBroadcast(payload) {
    const callId = typeof payload?.callId === 'string' ? payload.callId : null;
    if (!callId || adminState.incomingCallId !== callId) return;
    handleCallEndedBroadcast(callId);
}

// =========================================================
// WEBRTC PEER CONNECTION
// =========================================================
function isOnCall() {
    return adminState.currentCall !== null && adminState.currentCall.open;
}

async function createPeerConnection() {
    if (adminState.pc) {
        adminState.pc.close();
        adminState.pc = null;
    }
    adminState.pc = new RTCPeerConnection(null);
    adminState.iceCandidatesQueue = [];

    adminState.pc.ontrack = (e) => {
        if (!adminState.remoteStream) {
            adminState.remoteStream = new MediaStream();
        }
        adminState.remoteStream.addTrack(e.track);
        if (dom.remoteAudio && dom.remoteAudio.srcObject !== adminState.remoteStream) {
            dom.remoteAudio.srcObject = adminState.remoteStream;
            console.log('Received remote stream');
        }
    };

    adminState.pc.onicecandidate = async (e) => {
        if (!e.candidate) return;
        if (!adminState.incomingCallId) return;
        await broadcastSignaling('call-ice-candidate', {
            callId: adminState.incomingCallId,
            from: adminState.peerId,
            to: adminState.callerPeerId,
            candidate: e.candidate.toJSON()
        });
    };

    adminState.pc.onconnectionstatechange = () => {
        console.log('[pc] connection state:', adminState.pc ? adminState.pc.connectionState : 'null');
    };
}

async function broadcastSignaling(event, payload = {}) {
    if (!window.supabaseClient) return;
    const channel = adminState.dispatchChannel || window.supabaseClient.channel(CALL_DISPATCH_CHANNEL);
    try {
        if (!adminState.dispatchChannel) {
            await channel.subscribe();
        }
        await channel.send({
            type: 'broadcast',
            event,
            payload
        });
    } catch (e) {
        console.error('[WebRTC] Broadcast failed:', event, e);
    }
}

// =========================================================
// INCOMING CALL HANDLERS
// =========================================================
function handleCallOffer(callId, from, to, sdp) {
    if (adminState.callState !== CALL_STATES.IDLE) return;
    if (isOnCall()) return;

    adminState.incomingCallId = callId;
    adminState.callerPeerId = from;
    adminState.pendingOffer = sdp;

    transitionTo(CALL_STATES.RINGING, 'incoming offer');
    if (isDashboard()) {
        adminState.pendingIncomingUi = true;
        ensureIncomingCallUI();
        setStatus('Incoming call...');
        playIncomingRingtone();
    }
    console.log('[WebRTC] Incoming call offer from:', from, 'callId:', callId);
}

async function answerCall() {
    if (!adminState.pendingOffer || !adminState.incomingCallId) {
        console.warn('[WebRTC] No pending offer to answer.');
        return;
    }

    const callId = adminState.incomingCallId;
    const callerPeerId = adminState.callerPeerId;

    await createPeerConnection();

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

    await broadcastSignaling('call-answer', {
        callId,
        from: adminState.peerId,
        to: callerPeerId,
        sdp: adminState.pc.localDescription.sdp
    });

    adminState.pendingOffer = null;
    adminState.callerPeerId = null;

    if (isDashboard()) {
        adminState.pendingIncomingUi = false;
        hide(dom.incomingState);
        show(dom.activeState);
        setStatus('Call active');
    }

    transitionTo(CALL_STATES.CONNECTED, 'call answered');
    adminState.currentCall = { open: true };

    startStatsPolling();

    adminState.seconds = 0;
    clearInterval(adminState.timerInterval);
    adminState.timerInterval = setInterval(() => {
        adminState.seconds++;
        const m = String(Math.floor(adminState.seconds / 60)).padStart(2, '0');
        const s = String(adminState.seconds % 60).padStart(2, '0');
        if (dom.callTimer) dom.callTimer.textContent = `${m}:${s}`;
    }, 1000);

    console.log('[WebRTC] Answered call:', callId);
}

async function handleCallAnswer(callId, from, to, sdp) {
    if (!adminState.pc || callId !== adminState.activeCallRecordId) return;
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
    if (!adminState.pc || callId !== adminState.activeCallRecordId) return;
    if (to !== adminState.peerId) return;
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
        console.log('[CallDispatch] Ignoring own acceptance broadcast:', callId);
        return;
    }

    console.log('[CallDispatch] Call accepted by another admin:', callId, 'acceptedBy:', acceptedBy);
    adminState.incomingCallId = null;
    adminState.pendingOffer = null;
    adminState.pendingIncomingUi = false;
    stopRingtone();
    hide(dom.incomingState);
    show(dom.idleState);
    setStatus('Waiting for call...');
    transitionTo(CALL_STATES.IDLE, 'call accepted by another admin');
}

function handleCallEndedBroadcast(callId) {
    console.log('[WebRTC] Call ended broadcast received:', callId);
    endCall();
}

// =========================================================
// CALLEE ACTIONS
// =========================================================
async function acceptCall() {
    if (!isDashboard()) return;

    if (!adminState.pendingOffer) {
        // Socket.io dispatch fallback
        if (window.supabaseClient && adminState.incomingCallId) {
            await broadcastSignaling('call-accepted', {
                callId: adminState.incomingCallId,
                acceptedBy: adminState.adminId,
                acceptedPeerId: adminState.peerId
            });
        }
        return;
    }

    await answerCall();
}

function rejectCall() {
    if (adminState.incomingCallId) {
        broadcastSignaling('call-ended', {
            callId: adminState.incomingCallId,
            from: adminState.peerId
        }).catch(() => {});
    }
    adminState.incomingCallId = null;
    adminState.pendingOffer = null;
    adminState.pendingIncomingUi = false;
    transitionTo(CALL_STATES.IDLE, 'call rejected');
    stopRingtone();
    resetUI();
}

function endCall() {
    if (adminState.pc) {
        adminState.pc.close();
        adminState.pc = null;
    }
    if (adminState.incomingCallId) {
        broadcastSignaling('call-ended', {
            callId: adminState.incomingCallId,
            from: adminState.peerId
        }).catch(() => {});
    }
    adminState.currentCall = null;
    adminState.incomingCallId = null;
    adminState.pendingOffer = null;
    adminState.callerPeerId = null;
    stopStatsPolling();
    resetUI();
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
            <button onclick="acceptCall()" class="w-11 h-11 rounded-full bg-green-500 hover:bg-green-400 active:scale-95 flex items-center justify-center transition-transform">
                <svg class="w-5 h-5 fill-white" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C11.4 21 3 12.6 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
            </button>
            <span class="text-green-300 text-xs">Accept</span>
        </div>
        <div class="flex flex-col items-center gap-1">
            <button onclick="rejectCall()" class="w-11 h-11 rounded-full bg-red-500 hover:bg-red-400 active:scale-95 flex items-center justify-center transition-transform">
                <svg class="w-5 h-5 fill-white" viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.1.3-4.5.7v3.1c0 .4-.2.8-.5 1-.8.5-1.6 1.1-2.2 1.8-.3.3-.8.3-1.1 0L1.1 13c-.3-.3-.3-.8 0-1.1C3.4 9.4 7.5 8 12 8s8.6 1.4 10.9 3.9c.3.3.3.8 0 1.1l-2.6 2.6c-.3.3-.8.3-1.1 0-.7-.7-1.4-1.3-2.2-1.8-.3-.2-.5-.6-.5-1V9.7C15.1 9.3 13.6 9 12 9z"/></svg>
            </button>
            <span class="text-red-300 text-xs">Reject</span>
        </div>
    `;
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
    clearInterval(adminState.timerInterval);
    if (adminState.localStream) {
        adminState.localStream.getTracks().forEach(track => track.stop());
        adminState.localStream = null;
    }
    if (dom.remoteAudio && dom.remoteAudio.srcObject) {
        dom.remoteAudio.srcObject.getTracks().forEach(track => track.stop());
        dom.remoteAudio.srcObject = null;
    }
    if (dom.callTimer) dom.callTimer.textContent = '00:00';

    if (adminState.alreadyAnsweredTimeout) {
        clearTimeout(adminState.alreadyAnsweredTimeout);
        adminState.alreadyAnsweredTimeout = null;
    }

    adminState.pendingIncomingUi = false;
    adminState.remoteStream = null;
    adminState.incomingCallId = null;
    adminState.currentCall = null;
    adminState.lastResult = null;
    adminState.pendingOffer = null;
    adminState.callerPeerId = null;
    adminState.iceCandidatesQueue = [];

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
    stopRingtone();

    if (adminState.localStream) {
        adminState.localStream.getTracks().forEach(track => track.stop());
        adminState.localStream = null;
    }
    if (adminState.pc) {
        adminState.pc.close();
        adminState.pc = null;
    }
    if (adminState.dispatchChannel && window.supabaseClient) {
        window.supabaseClient.removeChannel(adminState.dispatchChannel).catch(() => {});
        adminState.dispatchChannel = null;
    }
    adminState.remoteStream = null;
    adminState.currentCall = null;
    adminState.incomingCallId = null;
    adminState.pendingOffer = null;
    adminState.callerPeerId = null;
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
});

window.cleanupAdminSession = async function() {
    await clearAdminSession();
    destroyPeer();
};

window.acceptCall = acceptCall;
window.rejectCall = rejectCall;
window.endCall = endCall;
window.isOnCall = isOnCall;

// =========================================================
// INITIALIZATION
// =========================================================
async function init() {
    cacheDomReferences();
    await registerAdminSession();
    await subscribeToCallDispatches();
    console.log('[WebRTC] Initialized for admin:', adminState.adminId, 'peer:', adminState.peerId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        init().catch((err) => console.error('init failed:', err));
    });
} else {
    init().catch((err) => console.error('init failed:', err));
}
