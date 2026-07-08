const SUPABASE_URL = 'https://zjedyulcrxcttbukbynh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_O4_Gy_uk6L50ARMA8QnP1g_QEAS2lJJ';

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
            .select('id, username, fullname, email')
            .eq('username', username)
            .eq('password', password)
            .single();

        if (error || !data) {
            if (errorMessage) errorMessage.classList.remove('hidden');
            const passwordInput = document.getElementById('password');
            if (passwordInput) passwordInput.value = '';
            return;
        }

        await db.from('admins').update({ is_online: true, last_login: new Date().toISOString() }).eq('id', data.id);

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
        if (userID) {
            await db.from('admins').update({ is_online: false, last_login: new Date().toISOString() }).eq('id', userID);
        }
        if (typeof window.cleanupAdminSession === 'function') {
            await window.cleanupAdminSession();
        }
    } catch (err) {
        console.error('Error during logout cleanup:', err);
    }

    sessionStorage.removeItem('adminLoggedIn');
    sessionStorage.removeItem('adminUser');
    sessionStorage.removeItem('adminUserID');
    sessionStorage.removeItem('adminFullName');
    sessionStorage.removeItem('loginTime');

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
