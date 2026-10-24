const SUPABASE_URL = 'https://zjedyulcrxcttbukbynh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_O4_Gy_uk6L50ARMA8QnP1g_QEAS2lJJ';
const SAFEZONE_TIME_ZONE = 'Asia/Manila';

window.SAFEZONE_TIME_ZONE = SAFEZONE_TIME_ZONE;

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabaseClient = db;

function isLoggedIn() {
    return sessionStorage.getItem('adminLoggedIn') === 'true';
}

function getCurrentUser() {
    return sessionStorage.getItem('adminUser');
}

function getCurrentUserID() {
    return sessionStorage.getItem('adminUserID');
}

function isLoginSessionStale(lastSeenValue, staleAfterMs = 24 * 60 * 60 * 1000) {
    if (!lastSeenValue) return true;

    const timestamp = new Date(lastSeenValue).getTime();
    if (Number.isNaN(timestamp)) return true;

    return Date.now() - timestamp > staleAfterMs;
}

function clearLocalAuthState() {
    const sessionKeys = [
        'adminLoggedIn',
        'adminUser',
        'adminUserID',
        'adminFullName',
        'loginTime',
        'adminPeerId',
        'skipPeerCleanup'
    ];

    sessionKeys.forEach((key) => sessionStorage.removeItem(key));
    sessionStorage.clear();

    for (const key of Object.keys(localStorage)) {
        if (key.startsWith('sb-') || key.startsWith('supabase') || key.includes('supabase') || key.includes('sb_')) {
            localStorage.removeItem(key);
        }
    }

    localStorage.removeItem('adminLoggedIn');
    localStorage.removeItem('adminUser');
    localStorage.removeItem('adminUserID');
    localStorage.removeItem('adminFullName');
    localStorage.removeItem('loginTime');
    localStorage.removeItem('adminPeerId');
    localStorage.removeItem('skipPeerCleanup');
}

async function setAdminLoginState(userID, loggedIn) {
    if (!userID || !db) return false;

    const now = new Date().toISOString();
    const { error, data } = await db
        .from('admins')
        .update({
            is_online: Boolean(loggedIn),
            is_logged_in: Boolean(loggedIn),
            call_status: loggedIn ? 'available' : 'offline',
            peer_id: loggedIn ? null : null,
            last_seen: now,
            ...(loggedIn ? { last_login: now } : {})
        })
        .eq('id', userID)
        .select('id, is_online, is_logged_in')
        .maybeSingle();

    if (error) throw error;
    return Boolean(data);
}

async function resetAdminOnlineStatus(userID) {
    return setAdminLoginState(userID, false);
}

function parseSupabaseTimestamp(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value === 'number') return new Date(value);
    if (value === null || value === undefined || value === '') return new Date(NaN);

    const text = String(value).trim().replace(' ', 'T');
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    return new Date(hasTimezone ? text : `${text}Z`);
}

function parseReportTimestamp(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value === 'number') return new Date(value);
    if (value === null || value === undefined || value === '') return new Date(NaN);

    const text = String(value).trim().replace(' ', 'T');
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    return new Date(hasTimezone ? text : `${text}+08:00`);
}

window.parseSupabaseTimestamp = parseSupabaseTimestamp;
window.parseReportTimestamp = parseReportTimestamp;

async function handleRegister(event) {
    event.preventDefault();

    const fullname = (document.getElementById('fullname') || {}).value || '';
    const email = (document.getElementById('email') || {}).value || '';
    const username = (document.getElementById('username') || {}).value || '';
    const password = (document.getElementById('password') || {}).value || '';
    const confirmPassword = (document.getElementById('confirm-password') || {}).value || '';

    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) errorDiv.classList.add('hidden');

    if (password !== confirmPassword) {
        showError('Passwords do not match');
        return;
    }
    if (password.length < 6) {
        showError('Password must be at least 6 characters');
        return;
    }

    try {
        const submitBtn = document.getElementById('submitBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating account...';
        }

        const { data: existingEmail } = await db.from('admins').select('id').eq('email', email).single();
        if (existingEmail) {
            showError('Email already exists');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Account';
            }
            return;
        }

        const { data: existingUser } = await db.from('admins').select('id').eq('username', username).single();
        if (existingUser) {
            showError('Username already exists');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Account';
            }
            return;
        }

        const { data, error } = await db.from('admins').insert([
            {
                fullname,
                email,
                username,
                password,
                is_online: false,
                is_logged_in: false,
                created_at: new Date().toISOString()
            }
        ]).select();

        if (error) {
            showError(error.message || 'Error creating account');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Account';
            }
            return;
        }

        const successDiv = document.getElementById('successMessage');
        if (successDiv) successDiv.classList.remove('hidden');

        setTimeout(() => {
            window.location.href = 'login.html';
        }, 2000);
    } catch (err) {
        showError(err.message || 'An error occurred during registration');
        const submitBtn = document.getElementById('submitBtn');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
        }
    }
}

function showError(message) {
    const errorText = document.getElementById('errorText');
    const errorDiv = document.getElementById('errorMessage');
    if (errorText) errorText.textContent = message;
    if (errorDiv) errorDiv.classList.remove('hidden');
}

async function handleLogin(event) {
    event.preventDefault();

    const username = (document.getElementById('username') || {}).value || '';
    const password = (document.getElementById('password') || {}).value || '';
    const errorMessage = document.getElementById('errorMessage');

    try {
        const { data, error } = await db
            .from('admins')
            .select('id, username, fullname, email, is_online, is_logged_in, last_seen, last_login')
            .eq('username', username)
            .eq('password', password)
            .single();

        if (error || !data) {
            if (errorMessage) errorMessage.classList.remove('hidden');
            const passwordInput = document.getElementById('password');
            if (passwordInput) passwordInput.value = '';
            return;
        }

        const lastLoginStamp = data.last_seen || data.last_login;
        if (data.is_online === true || data.is_logged_in === true) {
            if (!isLoginSessionStale(lastLoginStamp)) {
                if (errorMessage) {
                    errorMessage.textContent = 'This admin account is already logged in';
                    errorMessage.classList.remove('hidden');
                }
                const passwordInput = document.getElementById('password');
                if (passwordInput) passwordInput.value = '';
                return;
            }

            const { error: staleSessionError } = await db
                .from('admins')
                .update({
                    is_online: false,
                    is_logged_in: false,
                    call_status: 'offline',
                    peer_id: null,
                    last_seen: new Date().toISOString()
                })
                .eq('id', data.id);

            if (staleSessionError) throw staleSessionError;
        }

        const { data: claimedAdmin, error: claimError } = await db
            .from('admins')
            .update({
                is_online: true,
                is_logged_in: true,
                last_login: new Date().toISOString(),
                last_seen: new Date().toISOString()
            })
            .eq('id', data.id)
            .eq('is_online', false)
            .eq('is_logged_in', false)
            .select('id')
            .maybeSingle();

        if (claimError) throw claimError;
        if (!claimedAdmin) {
            if (errorMessage) {
                errorMessage.textContent = 'This admin account is already logged in.';
                errorMessage.classList.remove('hidden');
            }
            const passwordInput = document.getElementById('password');
            if (passwordInput) passwordInput.value = '';
            return;
        }

        sessionStorage.setItem('adminLoggedIn', 'true');
        sessionStorage.setItem('adminUser', data.username);
        sessionStorage.setItem('adminUserID', data.id);
        sessionStorage.setItem('adminFullName', data.fullname);
        sessionStorage.setItem('loginTime', new Date().toISOString());

        window.location.href = 'index.html';
    } catch (err) {
        if (errorMessage) errorMessage.classList.remove('hidden');
        const passwordInput = document.getElementById('password');
        if (passwordInput) passwordInput.value = '';
    }
}

async function logout() {
    const userID = getCurrentUserID();

    try {
        if (db && db.auth) {
            const { error: signOutError } = await db.auth.signOut({ scope: 'global' });
            if (signOutError) {
                console.error('Supabase signOut failed:', signOutError);
            }
        }
    } catch (err) {
        console.error('Unexpected error while signing out from Supabase auth:', err);
    }

    try {
        if (userID) {
            await resetAdminOnlineStatus(userID);
        }
        if (typeof window.cleanupAdminSession === 'function') {
            await window.cleanupAdminSession();
        }
    } catch (err) {
        console.error('Error during logout cleanup:', err);
    }

    clearLocalAuthState();
    window.location.href = 'login.html';
}

function updateUserDisplay() {
    const userDisplay = document.getElementById('userDisplay');
    if (!userDisplay) return;
    const fullName = sessionStorage.getItem('adminFullName');
    const user = getCurrentUser();
    userDisplay.textContent = fullName || user || 'Admin';
}

function checkAuthentication() {
    const path = window.location.pathname;
    const isAuthPage = path.includes('login.html') || path.includes('register.html');

    if (!isAuthPage && !isLoggedIn()) {
        window.location.href = 'login.html';
        return;
    }

    if (isAuthPage && isLoggedIn()) {
        window.location.href = 'index.html';
        return;
    }

    updateUserDisplay();
}

function initShowPasswordToggles() {
    document.querySelectorAll('.show-password-toggle').forEach(toggle => {
        toggle.addEventListener('change', () => {
            const targets = toggle.dataset.targets.split(',');
            targets.forEach(target => {
                const input = document.getElementById(target.trim());
                if (input) {
                    input.type = toggle.checked ? 'text' : 'password';
                }
            });
        });
    });
}

function initPage() {
    if (typeof window.clearPendingAppNavigation === 'function') {
        window.clearPendingAppNavigation();
    }
    checkAuthentication();
    initShowPasswordToggles();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
} else {
    initPage();
}
