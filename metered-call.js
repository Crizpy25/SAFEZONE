(function () {
    'use strict';

    const METERED_KEY = 'pk_live_ffa91f88e27d9d705f400f3a9f29eeba2380691f';
    const REMOTE_TIMEOUT_MS = 30000;
    let session = null;

    function snapshot() {
        return {
            state: session?.state || 'idle',
            alertId: session?.alertId || null,
            roomId: session?.roomId || null,
            connected: session?.state === 'connected',
            muted: Boolean(session?.muted)
        };
    }

    function emit(name, detail, owner = session) {
        if (!owner || owner !== session || owner.state === 'ending') return;
        window.dispatchEvent(new CustomEvent(`metered-call:${name}`, { detail }));
        const callback = owner.callbacks?.[name];
        if (typeof callback === 'function') callback(detail);
    }

    function getSdkConstructor() {
        const MeteredPeer = window.MeteredPeer?.MeteredPeer;
        if (typeof MeteredPeer !== 'function') {
            throw new Error('Metered browser SDK is unavailable');
        }
        return MeteredPeer;
    }

    function handleRemoteEnded(reason, owner = session) {
        if (!owner || owner !== session || ['idle', 'ending'].includes(owner.state)) return;
        console.log('[Metered] Remote peer left:', reason);
        emit('remoteLeft', { ...snapshot(), reason }, owner);
    }

    function attachRemoteAudio(stream, remotePeerId, owner = session) {
        if (!owner || owner !== session || owner.state === 'ending') return;
        if (owner.remoteStream === stream && owner.state === 'connected') return;
        window.clearTimeout(owner.remoteTimer);
        owner.remoteTimer = null;
        owner.remoteStream = stream;
        owner.remotePeerId = remotePeerId;
        owner.remoteAudio?.remove();
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.hidden = true;
        audio.srcObject = stream;
        document.body.appendChild(audio);
        owner.remoteAudio = audio;
        audio.play().catch(error => emit('error', { error, reason: 'audio-playback-failed' }, owner));
        if (owner.state !== 'connected') {
            owner.state = 'connected';
            console.log('[Metered] Connected');
            emit('connected', { ...snapshot(), stream, remotePeerId }, owner);
        }
    }

    function watchRemote(remote, owner = session) {
        if (!owner || owner !== session || !remote || owner.watchedPeers.has(remote.id)) return;
        owner.watchedPeers.add(remote.id);
        console.log('[Metered] Remote peer joined:', remote.id);
        remote.on('stream-added', ({ stream }) => {
            if (owner !== session || !stream) return;
            const audioTracks = stream.getAudioTracks?.() || [];
            console.log('[Metered] Remote stream received:', { peerId: remote.id, audioTracks: audioTracks.length });
            if (audioTracks.length) attachRemoteAudio(stream, remote.id, owner);
        });
        remote.on('track', ({ track, streams = [] }) => {
            if (owner !== session || track?.kind !== 'audio') return;
            console.log('[Metered] Remote audio track received:', { peerId: remote.id, trackId: track.id });
            const stream = streams[0] || new MediaStream([track]);
            track.addEventListener('ended', () => handleRemoteEnded('remote-audio-ended', owner), { once: true });
            attachRemoteAudio(stream, remote.id, owner);
        });
        remote.on('state-change', ({ to }) => {
            if (to === 'failed' || to === 'closed') handleRemoteEnded(`remote-${to}`, owner);
        });
    }

    async function joinCall(options = {}) {
        const alertId = String(options.alertId ?? '').trim();
        if (!alertId) throw new Error('alertId is required');
        if (session) await endCall('replaced-by-new-call');

        const roomId = `safezone-call-${alertId}`;
        const MeteredPeer = getSdkConstructor();
        const peer = new MeteredPeer({ apiKey: METERED_KEY });
        session = {
            alertId, roomId, peer, state: 'requesting-microphone', muted: false,
            localStream: null, remoteStream: null, remoteAudio: null,
            remotePeerId: null, remoteTimer: null, watchedPeers: new Set(),
            callbacks: {
                connected: options.onConnected,
                remoteLeft: options.onRemoteLeft,
                error: options.onError,
                stateChange: options.onStateChange
            }
        };
        const owner = session;

        try {
            console.log('[Metered] Room:', roomId);
            const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            if (owner !== session) {
                localStream.getTracks().forEach(track => track.stop());
                throw new Error('Call ended while microphone permission was pending');
            }
            owner.localStream = localStream;
            peer.addStream(localStream, { role: options.role || 'participant', alertId });
            peer.on('peer-joined', ({ peer: remote }) => watchRemote(remote, owner));
            peer.on('peer-left', ({ peer: remote }) => {
                if (owner === session && owner.watchedPeers.has(remote.id)) handleRemoteEnded('peer-left', owner);
            });
            peer.on('state-change', ({ from, to }) => {
                if (owner !== session) return;
                emit('stateChange', { from, to, ...snapshot() }, owner);
                if (to === 'closed' && owner.state !== 'ending') handleRemoteEnded('network-closed', owner);
            });
            peer.on('error', ({ err }) => {
                if (owner === session && owner.state !== 'ending') emit('error', { error: err, reason: 'sdk-error' }, owner);
            });
            owner.state = 'joining';
            console.log('[Metered] Joining room');
            await peer.join(roomId);
            peer.remotePeers.forEach(remote => watchRemote(remote, owner));
            if (owner !== session) throw new Error('Call ended while joining the Metered room');
            owner.state = 'waiting-for-remote';
            console.log('[Metered] Waiting for remote peer');
            owner.remoteTimer = window.setTimeout(() => {
                if (owner === session && owner.state !== 'connected') {
                    emit('error', { error: new Error('Remote peer did not connect in time'), reason: 'remote-timeout' }, owner);
                }
            }, options.remoteTimeoutMs || REMOTE_TIMEOUT_MS);
            return snapshot();
        } catch (error) {
            console.error('[Metered] Join failed:', error);
            await endCall('join-failed');
            throw error;
        }
    }

    async function endCall(reason = 'local-ended') {
        const current = session;
        if (!current) return;
        if (current.endPromise) return current.endPromise;
        current.state = 'ending';
        current.endPromise = (async () => {
            window.clearTimeout(current.remoteTimer);
            current.remoteTimer = null;
            try { current.peer.removeStream(current.localStream); } catch (_) { /* already removed */ }
            current.localStream?.getTracks().forEach(track => track.stop());
            current.remoteStream?.getTracks().forEach(track => track.stop());
            if (current.remoteAudio) {
                current.remoteAudio.pause();
                current.remoteAudio.srcObject = null;
                current.remoteAudio.remove();
                current.remoteAudio = null;
            }
            try { await current.peer.close(reason); } catch (error) { console.warn('[Metered] Close failed:', error); }
            if (session === current) session = null;
            console.log('[Metered] Cleanup complete');
        })();
        return current.endPromise;
    }

    window.MeteredCall = {
        joinCall,
        endCall,
        mute: () => {
            session?.localStream?.getAudioTracks().forEach(track => { track.enabled = false; });
            if (session) session.muted = true;
        },
        unmute: () => {
            session?.localStream?.getAudioTracks().forEach(track => { track.enabled = true; });
            if (session) session.muted = false;
        },
        isConnected: () => session?.state === 'connected',
        getState: snapshot,
        roomIdForAlert: alertId => `safezone-call-${String(alertId).trim()}`
    };
})();
