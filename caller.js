/* =========================================================
   caller.js — Outbound Call Assignment API
   =========================================================
   Queries the `admins` table to find an available admin,
   atomically locks them to `busy`, and provides the PeerJS
   peer_id for the outbound call.

   Flutter caller integration:
     1. Query `admins` for is_logged_in = true AND call_status = 'available'
     2. Atomically update that row to call_status = 'busy'
     3. Use the returned peer_id to place the PeerJS call
     4. On call end/failure, release the agent back to 'available'
   ========================================================= */

let callerPeer = null;
const CALL_TIMEOUT_MS = 30000;

/**
 * Find an available admin and atomically mark them as busy.
 * Returns the assigned agent row, or throws on failure.
 */
async function assignAvailableAdmin() {
    if (!window.supabaseClient) {
        throw new Error('Supabase client is not initialized');
    }

    const { data: agents, error: queryError } = await window.supabaseClient
        .from('admins')
        .select('*')
        .eq('is_logged_in', true)
        .eq('call_status', 'available')
        .not('peer_id', 'is', null)
        .limit(1);

    if (queryError || !agents || agents.length === 0) {
        throw new Error('All agents are currently busy. Please try again later.');
    }

    const agent = agents[0];

    // Atomic guard: only update if still available
    const { error: updateError } = await window.supabaseClient
        .from('admins')
        .update({
            call_status: 'busy',
            last_seen: new Date().toISOString()
        })
        .eq('id', agent.id)
        .eq('call_status', 'available');

    if (updateError) {
        throw new Error('Failed to assign agent. Please try again later.');
    }

    // Verify we won the race — another caller may have struck first
    const { data: verify, error: verifyError } = await window.supabaseClient
        .from('admins')
        .select('call_status')
        .eq('id', agent.id)
        .single();

    if (verifyError || !verify || verify.call_status !== 'busy') {
        throw new Error('Agent was just taken. Please try again later.');
    }

    return agent;
}

/**
 * Release a previously assigned admin back to the available pool.
 */
async function releaseAdmin(agentId) {
    if (!window.supabaseClient || !agentId) return;
    try {
        const { data: agent } = await window.supabaseClient
            .from('admins')
            .select('is_logged_in')
            .eq('id', agentId)
            .single();

        await window.supabaseClient
            .from('admins')
            .update({
                call_status: agent?.is_logged_in ? 'available' : 'offline',
                last_seen: new Date().toISOString()
            })
            .eq('id', agentId);
    } catch (err) {
        console.error('Failed to release admin agent:', err);
    }
}

/**
 * Get (or lazily create) the caller's PeerJS instance.
 */
async function getCallerPeer() {
    if (callerPeer && !callerPeer.destroyed) {
        if (callerPeer.disconnected) {
            await new Promise((resolve) => {
                const onOpen = () => {
                    callerPeer.off('open', onOpen);
                    resolve();
                };
                callerPeer.on('open', onOpen);
                try { callerPeer.reconnect(); } catch (e) { resolve(); }
            });
        }
        return callerPeer;
    }

    return new Promise((resolve, reject) => {
        callerPeer = new Peer();
        callerPeer.on('open', () => resolve(callerPeer));
        callerPeer.on('error', (err) => {
            console.error('Caller peer error:', err);
            reject(new Error('Failed to establish peer connection'));
        });
    });
}

/**
 * Main entry point for placing an outbound call.
 *
 * @param {MediaStream} mediaStream - Local audio stream from the caller.
 * @returns {Promise<{call: MediaConnection, peer: Peer, remoteStream: MediaStream, agent: Object}>}
 */
async function callAdmin(mediaStream) {
    const agent = await assignAvailableAdmin();
    const peer = await getCallerPeer();

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
        };

        const finish = (result) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };

        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            releaseAdmin(agent.id);
            reject(err);
        };

        timeoutId = setTimeout(() => {
            fail(new Error('Call timeout'));
        }, CALL_TIMEOUT_MS);

        try {
            const call = peer.call(agent.peer_id, mediaStream);

            if (!call) {
                fail(new Error('Failed to initiate call'));
                return;
            }

            call.on('stream', (remoteStream) => {
                finish({ call, peer, remoteStream, agent });
            });

            call.on('close', () => {
                fail(new Error('Call closed'));
            });

            call.on('error', (err) => {
                fail(err);
            });
        } catch (err) {
            fail(err);
        }
    });
}

// Export public API
window.callAdmin = callAdmin;
window.releaseAdmin = releaseAdmin;
