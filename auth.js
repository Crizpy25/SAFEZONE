// SAFEZONE Admin Authentication with Supabase

const SUPABASE_URL = 'https://zjedyulcrxcttbukbynh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_O4_Gy_uk6L50ARMA8QnP1g_QEAS2lJJ';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expose as global for map.js
window.supabaseClient = db;

// Check if user is logged in
function isLoggedIn() {
    return sessionStorage.getItem('adminLoggedIn') === 'true';
}

// Get current logged-in user
function getCurrentUser() {
    return sessionStorage.getItem('adminUser');
}

// Get current user ID
function getCurrentUserID() {
    return sessionStorage.getItem('adminUserID');
}

// Handle registration form submission
async function handleRegister(event) {
    event.preventDefault();
    
    const fullname = document.getElementById('fullname').value;
    const email = document.getElementById('email').value;
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const errorDiv = document.getElementById('errorMessage');
    const successDiv = document.getElementById('successMessage');
    const submitBtn = document.getElementById('submitBtn');
    
    // Reset messages
    errorDiv.classList.add('hidden');
    successDiv.classList.add('hidden');
    
    // Validate passwords match
    if (password !== confirmPassword) {
        showError('Passwords do not match');
        return;
    }
    
    if (password.length < 6) {
        showError('Password must be at least 6 characters');
        return;
    }
    
    try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating account...';
        
        // Check if email or username already exists
        const { data: existingEmail } = await db
            .from('admins')
            .select('id')
            .eq('email', email)
            .single();

        if (existingEmail) {
            showError('Email already exists');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
            return;
        }

        const { data: existingUser } = await db
            .from('admins')
            .select('id')
            .eq('username', username)
            .single();
        
        if (existingUser) {
            showError('Username already exists');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
            return;
        }
        
        // Insert new admin into database
        const { data, error } = await db
            .from('admins')
            .insert([
                {
                    fullname: fullname,
                    email: email,
                    username: username,
                    password: password,
                    is_online: false,
                    created_at: new Date().toISOString()
                }
            ])
            .select();
        
        if (error) {
            showError(error.message || 'Error creating account');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
            return;
        }
        
        // Show success message
        successDiv.classList.remove('hidden');
        
        // Redirect to login after 2 seconds
        setTimeout(() => {
            window.location.href = 'login.html';
        }, 2000);
        
    } catch (err) {
        showError(err.message || 'An error occurred during registration');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
    }
}

// Show error message
function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    const errorText = document.getElementById('errorText');
    errorText.textContent = message;
    errorDiv.classList.remove('hidden');
}

// Handle login form submission
async function handleLogin(event) {
    event.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorMessage = document.getElementById('errorMessage');
    
    try {
        // Query database for user
        const { data, error } = await db
            .from('admins')
            .select('id, username, fullname, email')
            .eq('username', username)
            .eq('password', password)
            .single();
        
        if (error || !data) {
            errorMessage.classList.remove('hidden');
            document.getElementById('password').value = '';
            return;
        }
        
        // Update user online status
        await db
            .from('admins')
            .update({
                is_online: true,
                last_login: new Date().toISOString()
            })
            .eq('id', data.id);
        
        // Store login info in session
        sessionStorage.setItem('adminLoggedIn', 'true');
        sessionStorage.setItem('adminUser', data.username);
        sessionStorage.setItem('adminUserID', data.id);
        sessionStorage.setItem('adminFullName', data.fullname);
        sessionStorage.setItem('loginTime', new Date().toISOString());
        
        // Redirect to dashboard
        window.location.href = 'index.html';
        
    } catch (err) {
        errorMessage.classList.remove('hidden');
        document.getElementById('password').value = '';
    }
}

// Logout function
async function logout() {
    const userID = getCurrentUserID();
    
    try {
        // Update user offline status in database
        if (userID) {
            await db
                .from('admins')
                .update({ is_online: false })
                .eq('id', userID);
        }
    } catch (err) {
        console.error('Error updating logout status:', err);
    }
    
    // Clear session
    sessionStorage.removeItem('adminLoggedIn');
    sessionStorage.removeItem('adminUser');
    sessionStorage.removeItem('adminUserID');
    sessionStorage.removeItem('adminFullName');
    sessionStorage.removeItem('loginTime');
    
    window.location.href = 'login.html';
}

// Check authentication on page load for protected pages
function checkAuthentication() {
    // Don't check on login/register pages
    if (window.location.pathname.includes('login.html') || 
        window.location.pathname.includes('register.html') ||
        document.title.includes('Admin Login') ||
        document.title.includes('Admin Register')) {
        return;
    }
    
    // Redirect to login if not authenticated
    if (!isLoggedIn()) {
        window.location.href = 'login.html';
        return;
    }
    

    
    // Display current user in sidebar
    updateUserDisplay();

    if (document.getElementById('map') && typeof window.initializeMap === 'function') {
        setTimeout(window.initializeMap, 100);
    }
    
}

// Update user display in sidebar
function updateUserDisplay() {
    const userDisplay = document.getElementById('userDisplay');
    if (userDisplay) {
        const fullName = sessionStorage.getItem('adminFullName');
        const user = getCurrentUser();
        userDisplay.textContent = fullName || user || 'Admin';
    }
}

// Initialize password show/hide checkboxes
function initPasswordToggles() {
    document.querySelectorAll('.show-password-toggle').forEach((checkbox) => {
        const inputs = checkbox.dataset.targets
            .split(',')
            .map((target) => document.getElementById(target.trim()))
            .filter(Boolean);

        if (!inputs.length || checkbox.dataset.ready === 'true') {
            return;
        }

        checkbox.dataset.ready = 'true';
        checkbox.addEventListener('change', () => {
            inputs.forEach((input) => {
                input.type = checkbox.checked ? 'text' : 'password';
            });
        });
    });
}

function initPage() {
    initPasswordToggles();
    checkAuthentication();
}

// Run authentication check when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
} else {
    // DOM already loaded
    initPage();
}
