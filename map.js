const ILOILO_CITY_POLYGON = [
    [10.681785655878944, 122.49474249009371],
    [10.694886448077998, 122.49859467332405],
    [10.73921342221657, 122.51279715388304],
    [10.760570904305848, 122.54115700985388],
    [10.78341690543084, 122.56550180260652],
    [10.76085574961492, 122.59561258959526],
    [10.736986291533862, 122.59902560515846],
    [10.720655712205213, 122.60094906731678],
    [10.686816359886635, 122.5814726847861]
];

let map = null;
let callerLocationLayer = null;
const activeCallerMarkers = new Map();
const activeCallerAlerts = new Map();
const dismissedCallerAlerts = new Set();
let callerLocationChannel = null;
const pendingRealtimeIncomingAlerts = new Map();
let selectedNotificationId = null;
let notificationFilter = 'All';
if (!window.allIncidents) window.allIncidents = [];

function getCurrentAdminInfo() {
    const adminId = sessionStorage.getItem('adminUserID');
    const adminName = sessionStorage.getItem('adminFullName') || sessionStorage.getItem('adminUser') || 'Admin';
    return adminId ? { id: adminId, name: adminName } : null;
}

async function claimReport(reportId) {
    const adminId = sessionStorage.getItem('adminUserID');
    if (!adminId || !window.supabaseClient) return false;
    try {
        const { data: adminData, error: adminError } = await window.supabaseClient
            .from('admins')
            .select('fullname')
            .eq('id', adminId)
            .single();

        const adminName = adminData?.fullname || null;

            const { data, error } = await window.supabaseClient
                .from('incidents')
                .update({
                    handled_by: adminName,
                    status: 'assigned'
                })
                .eq('id', reportId)
                .eq('status', 'active')
                .select();

        return !error && data && data.length > 0;
    } catch (e) {
        console.error('Failed to claim report:', e);
        return false;
    }
}

async function acceptReport(reportId) {
    const claimed = await claimReport(reportId);
    if (!claimed) {
        alert('This incident is already being handled by another administrator.');
        return false;
    }
    await loadReports();
    renderNotificationPanel();
    updateActiveCounters();
    return true;
}

function isPointInPolygon(lat, lng) {
    const ptLat = Number(lat);
    const ptLng = Number(lng);
    if (!Number.isFinite(ptLat) || !Number.isFinite(ptLng)) return false;

    let inside = false;
    for (let i = 0, j = ILOILO_CITY_POLYGON.length - 1; i < ILOILO_CITY_POLYGON.length; j = i++) {
        const lat_i = ILOILO_CITY_POLYGON[i][0];
        const lat_j = ILOILO_CITY_POLYGON[j][0];
        const lng_i = ILOILO_CITY_POLYGON[i][1];
        const lng_j = ILOILO_CITY_POLYGON[j][1];
        if (((lat_i > ptLat) !== (lat_j > ptLat)) && (ptLng < (lng_j - lng_i) * (ptLat - lat_i) / (lat_j - lat_i) + lng_i)) {
            inside = !inside;
        }
    }
    return inside;
}

function initializeMap() {
    if (map) {
        return;
    }

    const mapEl = document.getElementById('map');
    if (!mapEl) {
        console.error('Map container #map not found');
        return;
    }
    if (!window.L) {
        console.error('Leaflet is not loaded');
        return;
    }

    try {
        map = L.map('map', {
            minZoom: 13.2,
            maxZoom: 18,
            maxBoundsViscosity: 0.3
        }).setView([10.7202, 122.5525], 13);
    } catch (e) {
        console.error('Failed to create Leaflet map:', e);
        return;
    }

    try {
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);
    } catch (e) {
        console.error('Failed to add tile layer:', e);
    }

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);

    // Station layers start hidden; the existing Police/Fire/Hospital controls
    // let each user choose which reference markers to show.
    window.policeLayer = L.layerGroup();
    window.fireLayer = L.layerGroup();
    window.hospitalLayer = L.layerGroup();
    window.incidentLayer = L.layerGroup().addTo(map);
    callerLocationLayer = L.layerGroup().addTo(map);

    const policeIcon = L.icon({
        iconUrl: 'images/police.png',
        iconSize: [36, 36],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40]
    });
    const fireIcons = L.icon({
        iconUrl: 'images/fire.png',
        iconSize: [30, 30],
        iconAnchor: [17, 35],
        popupAnchor: [0, -35]
    });
    const hospitalIcon = L.icon({
        iconUrl: 'images/hospital.png',
        iconSize: [30, 30],
        iconAnchor: [17, 35],
        popupAnchor: [0, -35]
    });
    const markerIcon = (url) => L.icon({
        iconUrl: url,
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
        iconSize: [30, 55],
        iconAnchor: [20, 66],
        popupAnchor: [1, -34],

    });
    window.redIcon = markerIcon('https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png');
    window.blueIcon = markerIcon('https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png');
    window.greenIcon = markerIcon('https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png');

    const stations = [
        { name: 'PS1 City Proper', lat: 10.701501994092405, lng: 122.56369039944839, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS2 La Paz', lat: 10.70552222109631, lng: 122.56549995693831, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS3 Jaro', lat: 10.735918109716387, lng: 122.55998972270376, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS4 Molo', lat: 10.698346304433658, lng: 122.55105476464729, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS5 Mandurriao', lat: 10.71683400704982, lng: 122.53648059623264, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS6 Arevalo', lat: 10.68890021276814, lng: 122.51886825833218, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS7 City Proper', lat: 10.693697669664308, lng: 122.5578915097894, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS8 Brgy. Obrero', lat: 10.696296224219786, lng: 122.58505698638052, icon: policeIcon, layer: window.policeLayer },
        { name: 'ICPO Police Station 9', lat: 10.726572389429572, lng: 122.56519373620795, icon: policeIcon, layer: window.policeLayer },
        { name: 'ICPO Police Station 10', lat: 10.70553584277189, lng: 122.55517513417514, icon: policeIcon, layer: window.policeLayer },
        { name: 'ICARE Fire station', lat: 10.705088291583916, lng: 122.55490712638891, icon: fireIcons, layer: window.fireLayer },
        { name: 'Alta Tierra Fire Sub-station', lat: 10.739664436279549, lng: 122.56651531888511, icon: fireIcons, layer: window.fireLayer },
        { name: 'La Paz Fire Sub-Station', lat: 10.712651852092284, lng: 122.57295111469945, icon: fireIcons, layer: window.fireLayer },
        { name: 'Federation Iloilo Fire Station', lat: 10.697089988322267, lng: 122.56487023547012, icon: fireIcons, layer: window.fireLayer },
        { name: 'BFP Iloilo', lat: 10.689280564358054, lng: 122.58153763103257, icon: fireIcons, layer: window.fireLayer },
        { name: 'Bo. Obrero Fire Sub-Station', lat: 10.70033104702452, lng: 122.58796764071114, icon: fireIcons, layer: window.fireLayer },
        { name: 'Mandurriao Fire Sub-Station', lat: 10.719211489646474, lng: 122.53920666146492, icon: fireIcons, layer: window.fireLayer },
        { name: 'Arevalo Fire Sub-Station', lat: 10.688797426748417, lng: 122.51626529021178, icon: fireIcons, layer: window.fireLayer },
        { name: 'Sto. Niño Sur Fire Sub-Station', lat: 10.68223713089546, lng: 122.5099533777009, icon: fireIcons, layer: window.fireLayer },
        { name: 'Old Molo Fire Station', lat: 10.697030999439814, lng: 122.5488881609591, icon: fireIcons, layer: window.fireLayer },
        { name: 'San Isidro Fire Sub-Station', lat: 10.736444550002995, lng: 122.5458557423291, icon: fireIcons, layer: window.fireLayer },
        { name: 'BFP JARO FIRE SUB STATION', lat: 10.725305477601013, lng: 122.55751243802833, icon: fireIcons, layer: window.fireLayer },
        { name: 'Western Visayas Medical Center (Public)', lat: 10.718885489071287, lng: 122.54193891896666, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: 'Iloilo Mission Hospital', lat: 10.714817707214994, lng: 122.56058274040979, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: "St. Paul's Hospital Iloilo", lat: 10.702011896133618, lng: 122.56694877109325, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: "Iloilo Doctors' Hospital", lat: 10.696804152759018, lng: 122.55440768089073, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: 'The Medical City Iloilo', lat: 10.699644543003238, lng: 122.54277137544258, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: 'West Visayas State University Medical Center', lat: 10.717168244196454, lng: 122.56120580362972, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: 'QualiMed Hospital Iloilo', lat: 10.706542561402188, lng: 122.54782241379408, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: 'Medicus Medical Center', lat: 10.702756754480117, lng: 122.55224702393059, icon: hospitalIcon, layer: window.hospitalLayer },
        { name: "AMOSUP Seamen's Hospital", lat: 10.714828158629505, lng: 122.53455543124073, icon: hospitalIcon, layer: window.hospitalLayer }
    ];

    stations.forEach(s => {
        if (!isPointInPolygon(s.lat, s.lng)) return;
        const contactText = getStationContact(s.name) || 'Not Available';
        const popupHtml = `<div style="font-size:13px; color:#0f172a; font-weight:700; margin-bottom:4px;">${escapeMapHtml(s.name)}</div>
                           <div style="font-size:12px; color:#334155;">Contact Number: <span style="font-weight:700; color:#000000;">${escapeMapHtml(contactText)}</span></div>`;
        L.marker([s.lat, s.lng], { icon: s.icon }).addTo(s.layer).bindPopup(popupHtml);
    });

    window.emergencyAgencyData = {
        Police: stations.filter(s => s.layer === window.policeLayer).map(s => [s.name, s.lat, s.lng]),
        Fire: stations.filter(s => s.layer === window.fireLayer).map(s => [s.name, s.lat, s.lng]),
        Medic: stations.filter(s => s.layer === window.hospitalLayer).map(s => [s.name, s.lat, s.lng])
    };

    window.validAgencies = {};
    for (const [type, agencies] of Object.entries(window.emergencyAgencyData)) {
        window.validAgencies[type] = agencies.filter(([, lat, lng]) => isPointInPolygon(lat, lng));
    }

    loadReports();
    renderActiveCallerMarkers();

    setTimeout(() => {
        try { map.invalidateSize(); } catch (e) { /* ignore */ }
    }, 100);

    setTimeout(() => {
        try { map.invalidateSize(); } catch (e) { /* ignore */ }
    }, 500);

    setTimeout(refreshToggleState, 50);
}

function getCallerAlertCoordinates(alert) {
    const lat = Number(alert?.latitude ?? alert?.lat);
    const lng = Number(alert?.longitude ?? alert?.long ?? alert?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && isPointInPolygon(lat, lng)
        ? { lat, lng }
        : null;
}

function isEndedCallerAlert(alert) {
    const status = String(alert?.status || '').toLowerCase().trim();
    return ['ended', 'cancelled', 'canceled', 'failed', 'missed', 'expired', 'completed', 'resolved', 'closed'].includes(status);
}

function showCallerLocationPing(alertId, alert, { recenter = false } = {}) {
    const coordinates = getCallerAlertCoordinates(alert);
    const id = String(alertId || alert?.id || 'unknown-caller');
    if (dismissedCallerAlerts.has(id)) return false;
    const lat = coordinates?.lat;
    const lng = coordinates?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        console.warn('[Caller Location] Invalid coordinates:', { alertId: id, latitude: alert?.latitude ?? alert?.lat, longitude: alert?.longitude ?? alert?.long ?? alert?.lng });
        return false;
    }
    if (!map) initializeMap();
    if (!map || !window.L) {
        console.warn('[Caller Location] Dashboard map is not ready for caller ping');
        return false;
    }
    let marker = activeCallerMarkers.get(id);
    if (marker) {
        marker.setLatLng([lat, lng]);
        console.log('[Caller Location] Position updated:', { alertId: id, latitude: lat, longitude: lng });
    } else {
        const callerLocationIcon = L.icon({
            iconUrl: 'images/location.png',
            iconSize: [40, 40],
            iconAnchor: [20, 40],
            popupAnchor: [0, -40]
        });
        console.log('[Caller Location] Creating marker:', id);
        console.log('[Caller Location] location.png loaded');
        marker = L.marker([lat, lng], { icon: callerLocationIcon }).addTo(callerLocationLayer);
        activeCallerMarkers.set(id, marker);
        const popupContent = `<div style="font-size:12px;color:#334155"><strong style="display:block;margin-bottom:4px;font-size:13px;color:#0f172a">Incoming Emergency Call</strong><span>Caller location</span>${alert?.created_at ? `<span style="display:block;margin-top:2px;color:#64748b">${escapeMapHtml(new Date(alert.created_at).toLocaleString())}</span>` : ''}<button type="button" onclick="dismissCallerLocationPing('${escapeMapHtml(id)}')" style="width:100%;margin-top:8px;padding:6px 8px;border:0;border-radius:6px;background:#e2e8f0;color:#334155;font-size:12px;font-weight:700;cursor:pointer">Close ping</button></div>`;
        marker.bindPopup(popupContent, {
            className: 'caller-location-popup',
            minWidth: 150,
            maxWidth: 180,
            autoPanPadding: [24, 24]
        }).openPopup();
        console.log('[Caller Location] Marker added to Dashboard:', id);
    }
    if (recenter) map.setView([lat, lng], 16);
    return true;
}

function clearCallerLocationPing(alertId) {
    const id = String(alertId || '');
    const marker = activeCallerMarkers.get(id);
    if (marker && callerLocationLayer) callerLocationLayer.removeLayer(marker);
    activeCallerMarkers.delete(id);
    activeCallerAlerts.delete(id);
    dismissedCallerAlerts.delete(id);
    console.log('[Caller Location] Call ended - removing marker:', id);
}

function dismissCallerLocationPing(alertId) {
    const id = String(alertId || '');
    const marker = activeCallerMarkers.get(id);
    if (marker && callerLocationLayer) callerLocationLayer.removeLayer(marker);
    activeCallerMarkers.delete(id);
    dismissedCallerAlerts.add(id);
    console.log('[Caller Location] Ping dismissed by dispatcher:', id);
}

function syncCallerLocationAlert(alert, { notifyIncoming = false, eventType = null } = {}) {
    const alertId = alert?.id;
    if (!alertId) return;
    const coordinates = getCallerAlertCoordinates(alert);
    if (notifyIncoming) {
        console.log('[Incoming Call] Realtime alert:', { id: alertId, eventType, status: alert?.status, coordinates });
    }
    if (notifyIncoming && typeof window.handleEmergencyAlertIncomingCall === 'function') {
        window.handleEmergencyAlertIncomingCall(alert, { source: 'realtime', eventType });
        pendingRealtimeIncomingAlerts.delete(String(alertId));
    } else if (notifyIncoming) {
        if (eventType === 'INSERT') pendingRealtimeIncomingAlerts.set(String(alertId), alert);
        else if (isEndedCallerAlert(alert) || alert?.answered_by_admin_id) pendingRealtimeIncomingAlerts.delete(String(alertId));
        console.warn('[Call Init] Realtime call queued until PeerJS is ready:', alertId);
    }
    if (isEndedCallerAlert(alert)) {
        clearCallerLocationPing(alertId);
        return;
    }
    activeCallerAlerts.set(String(alertId), alert);
    // Location is retained during ringing, but is deliberately not rendered
    // until this admin has successfully answered the call.
    if (activeCallerMarkers.has(String(alertId))) showCallerLocationPing(alertId, alert);
}

function renderActiveCallerMarkers() {
    // Existing alert history is cached for location lookup only. It must not
    // replace the side panel's default "Waiting for call..." state.
}

function cacheCallerLocationAlert(alert) {
    if (alert?.id) activeCallerAlerts.set(String(alert.id), alert);
}

function drainPendingRealtimeIncomingAlerts() {
    if (typeof window.handleEmergencyAlertIncomingCall !== 'function') return;
    const queued = [...pendingRealtimeIncomingAlerts.values()];
    pendingRealtimeIncomingAlerts.clear();
    queued.forEach(alert => window.handleEmergencyAlertIncomingCall(alert, { source: 'realtime', eventType: 'INSERT' }));
}

async function showClaimedCallerLocation(alertId) {
    const id = String(alertId || '');
    let alert = activeCallerAlerts.get(id);
    if (!alert && window.supabaseClient && id) {
        const { data, error } = await window.supabaseClient.from('emergency_alerts').select('*').eq('id', id).maybeSingle();
        if (error) {
            console.error('[Caller Location] Failed to read claimed alert:', error);
            return false;
        }
        alert = data;
        if (alert) activeCallerAlerts.set(id, alert);
    }
    if (!alert) {
        console.warn('[Caller Location] No alert data available for claimed call:', id);
        return false;
    }
    return showCallerLocationPing(id, alert, { recenter: true });
}

async function loadActiveCallerLocations() {
    if (!window.supabaseClient) return;
    const { data, error } = await window.supabaseClient.from('emergency_alerts').select('*').order('created_at', { ascending: false });
    if (error) {
        console.error('[Caller Location] Failed to load emergency alerts:', error);
        return;
    }
    // Historical rows are location lookup data only. Fetching them must never
    // manufacture an incoming call during page initialization.
    (data || []).forEach(alert => syncCallerLocationAlert(alert, { notifyIncoming: false }));
}

function subscribeToCallerLocations() {
    if (!window.supabaseClient || callerLocationChannel) return;
    callerLocationChannel = window.supabaseClient.channel('caller-location-emergency-alerts')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_alerts' }, payload => {
            console.log('[Emergency Alerts Realtime]', { eventType: payload.eventType, newRecord: payload.new, oldRecord: payload.old });
            console.log('[Call Debug] emergency_alerts realtime event received');
            console.log('[Call Debug] Event type:', payload.eventType);
            const alert = payload.new || payload.old;
            if (payload.eventType === 'DELETE') clearCallerLocationPing(alert?.id);
            else syncCallerLocationAlert(alert, { notifyIncoming: true, eventType: payload.eventType });
        })
        .subscribe((status, error) => console.log('[Caller Location] Supabase subscription:', status, error || ''));
    loadActiveCallerLocations().catch(error => console.error('[Caller Location] Initial load failed:', error));
}

function centerMap() {
    if (!map) return;
    map.setView([10.7202, 122.5525], 13, { animate: true });
}

function toggleAll() {
    if (!map) return;
    const allVisible = map.hasLayer(window.policeLayer) && map.hasLayer(window.fireLayer) && map.hasLayer(window.hospitalLayer);
    [window.policeLayer, window.fireLayer, window.hospitalLayer].forEach(l => allVisible ? map.removeLayer(l) : l.addTo(map));
    refreshToggleState();
}
function togglePolice() {
    if (!map) return;
    map.hasLayer(window.policeLayer) ? map.removeLayer(window.policeLayer) : window.policeLayer.addTo(map);
    refreshToggleState();
}
function toggleFire() {
    if (!map) return;
    map.hasLayer(window.fireLayer) ? map.removeLayer(window.fireLayer) : window.fireLayer.addTo(map);
    refreshToggleState();
}
function toggleHospital() {
    if (!map) return;
    map.hasLayer(window.hospitalLayer) ? map.removeLayer(window.hospitalLayer) : window.hospitalLayer.addTo(map);
    refreshToggleState();
}
function refreshToggleState() {
    if (!map) return;
    const allVisible = map.hasLayer(window.policeLayer) && map.hasLayer(window.fireLayer) && map.hasLayer(window.hospitalLayer);
    ['btnPolice', 'btnFire', 'btnHospital'].forEach((btnId) => {
        const layerMap = { btnPolice: window.policeLayer, btnFire: window.fireLayer, btnHospital: window.hospitalLayer };
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.style.opacity = map.hasLayer(layerMap[btnId]) ? '1' : '0.45';
    });
    const allBtn = document.getElementById('btnAll');
    if (allBtn) allBtn.textContent = allVisible ? 'Hide All Stations' : 'Show All Stations';
}

function normalizeEmergencyCategory(category) {
    const value = String(category || '').toLowerCase().trim();
    if (value === 'police') return 'Police';
    if (value === 'fire') return 'Fire';
    if (value === 'medic' || value === 'medical' || value === 'hospital') return 'Medic';
    if (value.includes('obstruction') || value.includes('blocked') || value.includes('road')) return 'Police';
    return null;
}

function escapeMapHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function calculateDistanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(distanceKm) {
    if (!Number.isFinite(distanceKm)) return '';
    return distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m away` : `${distanceKm.toFixed(2)} km away`;
}

function getNearestAgencies(category, lat, lng, limit = 3) {
    const agencyType = normalizeEmergencyCategory(category);
    const agencies = window.validAgencies?.[agencyType] || [];
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!agencyType || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];

    return agencies
        .map(([name, aLat, aLng]) => ({
            name,
            type: agencyType,
            distanceKm: calculateDistanceKm(latitude, longitude, aLat, aLng)
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);
}

const POLICE_HOTLINES = Object.freeze({
    'PS1 City Proper': '0998-598-6242',
    'PS2 La Paz': '0998-598-6244',
    'PS3 Jaro': '0998-598-6246',
    'PS4 Molo': '0998-598-6248',
    'PS5 Mandurriao': '0998-598-6250',
    'PS6 Arevalo': '0998-598-6252',
    'PS7 City Proper': '0947-996-6568',
    'PS8 Brgy. Obrero': '0908-689-6098',
    'ICPO Police Station 9': '0908-322-8457',
    'ICPO Police Station 10': '0908-308-0940'
});

const HOSPITAL_CONTACT = '0919-066-1554';

const FIRE_HOTLINES = Object.freeze({
    'Arevalo Fire Sub-Station': '(033) 321 1096',
    'Sto. Niño Sur Fire Sub-Station': '(033) 314 7631',
    'BFP JARO FIRE SUB STATION': '(033) 500 0217',
    'ICARE Fire station': '0919-066-2333',
    'La Paz Fire Sub-Station': '(033) 320 6963',
    'Mandurriao Fire Sub-Station': '(033) 321 0779',
    'Old Molo Fire Station': '(033) 336 0639',
    'Bo. Obrero Fire Sub-Station': '(033) 335 1965',
    'San Isidro Fire Sub-Station': '(033) 330 1507',
    'Alta Tierra Fire Sub-station': '(033) 323 5139',
    'Federation Iloilo Fire Station': '(033) 337 9760',
    'BFP Iloilo': '500-5026'
});

const stationContactMap = {};
for (const [name, contact] of Object.entries(POLICE_HOTLINES)) {
    stationContactMap[name.trim()] = contact;
}
for (const [name, contact] of Object.entries(FIRE_HOTLINES)) {
    stationContactMap[name.trim()] = contact;
}
for (const [name, contact] of Object.entries({
    'Western Visayas Medical Center (Public)': HOSPITAL_CONTACT,
    'Iloilo Mission Hospital': HOSPITAL_CONTACT,
    "St. Paul's Hospital Iloilo": HOSPITAL_CONTACT,
    "Iloilo Doctors' Hospital": HOSPITAL_CONTACT,
    'The Medical City Iloilo': HOSPITAL_CONTACT,
    'West Visayas State University Medical Center': HOSPITAL_CONTACT,
    'QualiMed Hospital Iloilo': HOSPITAL_CONTACT,
    'Medicus Medical Center': HOSPITAL_CONTACT,
    "AMOSUP Seamen's Hospital": HOSPITAL_CONTACT
})) {
    stationContactMap[name.trim()] = contact;
}

function getStationContact(stationName) {
    const name = String(stationName || '').trim();
    if (!name) return null;
    return stationContactMap[name] || null;
}

function getRecommendedPoliceStation(lat, lng) {
    const results = getNearestAgencies('Police', lat, lng, 1);
    if (!results.length) return null;
    const nearest = results[0];
    return {
        name: nearest.name,
        hotline: getStationContact(nearest.name),
        distanceKm: nearest.distanceKm
    };
}

function getRecommendedFireStation(lat, lng) {
    const results = getNearestAgencies('Fire', lat, lng, 1);
    if (!results.length) return null;
    const nearest = results[0];
    return {
        name: nearest.name,
        hotline: getStationContact(nearest.name),
        distanceKm: nearest.distanceKm
    };
}

function getRecommendedHospital(lat, lng) {
    const results = getNearestAgencies('Medic', lat, lng, 1);
    if (!results.length) return null;
    const nearest = results[0];
    return {
        name: nearest.name,
        hotline: getStationContact(nearest.name),
        distanceKm: nearest.distanceKm
    };
}

function closeCategoryReports() {
    const panel = document.getElementById('categoryReportsPanel');
    if (panel) panel.classList.add('hidden');
}

function showNewReportToast(report) {
    const slots = Array.from(document.querySelectorAll('.new-report-toast-slot'));
    if (!slots.length) return;

    const category = report.category ? report.category.toUpperCase() : 'EMERGENCY';
    const desc = report.description ? `: ${report.description}` : '';
    const rawTime = report.created_at ? parseSupabaseTimestamp(report.created_at) : new Date();
    const time = rawTime && !Number.isNaN(rawTime.getTime())
        ? new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(rawTime)
        : new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const html = `<strong>${category}</strong>${desc}<br><span style="opacity:.85">${time}</span>`;

    let targetSlot = slots.find(slot => slot.classList.contains('hidden'));
    if (!targetSlot) {
        targetSlot = slots[0];
        targetSlot.classList.add('hidden');
        targetSlot.dataset.active = 'false';
    }

    const text = targetSlot.querySelector('.toast-text');
    if (!text) return;

    text.innerHTML = html;
    targetSlot.classList.remove('hidden');
    targetSlot.dataset.active = 'true';

    clearTimeout(targetSlot._timeout);
    targetSlot._timeout = setTimeout(() => {
        if (targetSlot.dataset.active === 'true') {
            targetSlot.classList.add('hidden');
            targetSlot.dataset.active = 'false';
        }
    }, 3000);
}

function showCategoryReports(category) {
    const panel = document.getElementById('categoryReportsPanel');
    const titleEl = document.getElementById('categoryReportsTitle');
    const listEl = document.getElementById('categoryReportsList');
    const noReportsEl = document.getElementById('categoryNoReports');

    if (!panel || !listEl) return;

    const reports = [];
    if (window.incidentLayer) {
        window.incidentLayer.eachLayer(layer => {
            if (normalizeEmergencyCategory(layer.incidentCategory) === category) {
                reports.push({
                    id: layer.incidentId,
                    category: layer.incidentCategory,
                    lat: layer.getLatLng().lat,
                    lng: layer.getLatLng().lng
                });
            }
        });
    }

    reports.sort((a, b) => String(b.id).localeCompare(String(a.id)));

    if (titleEl) titleEl.textContent = category;

    if (!reports.length) {
        listEl.innerHTML = '';
        if (noReportsEl) noReportsEl.classList.remove('hidden');
    } else {
        if (noReportsEl) noReportsEl.classList.add('hidden');
        listEl.innerHTML = reports.map(r => `
            <div class="bg-white/60 rounded-lg p-3 flex items-center justify-between mb-1 last:mb-0">
                <div>
                    <p class="text-gray-800 font-bold text-xs uppercase">${escapeMapHtml(r.category)}</p>
                    <p class="text-gray-600 text-[10px]">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</p>
                </div>
                <button onclick="panToIncident('${r.id}'); closeCategoryReports();" class="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold px-2 py-1 rounded ml-2 shrink-0">View</button>
            </div>
        `).join('');
    }

    panel.classList.remove('hidden');
}

function showAllReports() {
    const panel = document.getElementById('categoryReportsPanel');
    const titleEl = document.getElementById('categoryReportsTitle');
    const listEl = document.getElementById('categoryReportsList');
    const noReportsEl = document.getElementById('categoryNoReports');

    if (!panel || !listEl) return;

    const reports = [];
    if (window.incidentLayer) {
        window.incidentLayer.eachLayer(layer => {
            reports.push({
                id: layer.incidentId,
                category: layer.incidentCategory,
                lat: layer.getLatLng().lat,
                lng: layer.getLatLng().lng
            });
        });
    }

    reports.sort((a, b) => String(b.id).localeCompare(String(a.id)));

    if (titleEl) titleEl.textContent = 'All Reports';

    if (!reports.length) {
        listEl.innerHTML = '';
        if (noReportsEl) noReportsEl.classList.remove('hidden');
    } else {
        if (noReportsEl) noReportsEl.classList.add('hidden');
        listEl.innerHTML = reports.map(r => `
            <div class="bg-white/60 rounded-lg p-3 flex items-center justify-between mb-1 last:mb-0">
                <div>
                    <p class="text-gray-800 font-bold text-xs uppercase">${escapeMapHtml(r.category)}</p>
                    <p class="text-gray-600 text-[10px]">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</p>
                </div>
                <button onclick="panToIncident('${r.id}'); closeCategoryReports();" class="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold px-2 py-1 rounded ml-2 shrink-0">View</button>
            </div>
        `).join('');
    }

    panel.classList.remove('hidden');
}

function updateActiveCounters() {
    const counts = { Police: 0, Fire: 0, Medic: 0 };
    if (window.incidentLayer) {
        window.incidentLayer.eachLayer(layer => {
            const category = normalizeEmergencyCategory(layer.incidentCategory);
            if (category) counts[category] += 1;
        });
    }
    const policeEl = document.getElementById('policeCount');
    const fireEl = document.getElementById('fireCount');
    const medicEl = document.getElementById('medicCount');
    if (policeEl) policeEl.textContent = counts.Police;
    if (fireEl) fireEl.textContent = counts.Fire;
    if (medicEl) medicEl.textContent = counts.Medic;
    updateReportsList();
}

function updateReportsList() {
    const listEl = document.getElementById('reportsList');
    const noReportsEl = document.getElementById('noReports');
    if (!listEl) return;

    const reports = [];
    if (window.incidentLayer) {
        window.incidentLayer.eachLayer(layer => {
            reports.push({
                id: layer.incidentId,
                category: layer.incidentCategory,
                lat: layer.getLatLng().lat,
                lng: layer.getLatLng().lng
            });
        });
    }

    if (!reports.length) {
        listEl.innerHTML = '';
        if (noReportsEl) noReportsEl.classList.remove('hidden');
        return;
    }

    if (noReportsEl) noReportsEl.classList.add('hidden');
    listEl.innerHTML = reports.map(r => `
        <div class="bg-white/20 rounded-lg p-3 flex items-center justify-between">
            <div>
                <p class="text-white font-bold text-sm uppercase">${escapeMapHtml(r.category)}</p>
                <p class="text-white/70 text-xs">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</p>
            </div>
            <button onclick="panToIncident('${r.id}')" class="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-1 rounded">View</button>
        </div>
    `).join('');
}

function normalizeNotificationStatus(status) {
    const value = String(status || '').toLowerCase().trim();
    if (value.includes('respond')) return 'RESPONDING';
    if (value.includes('resolve')) return 'RESOLVED';
    if (value.includes('cancel')) return 'CANCELLED';
    if (value.includes('assign')) return 'ASSIGNED';
    return 'ACTIVE';
}

function getNotificationStatusPriority(status) {
    const normalized = normalizeNotificationStatus(status);
    if (normalized === 'ACTIVE' || normalized === 'RESPONDING' || normalized === 'ASSIGNED') return 0;
    if (normalized === 'RESOLVED') return 1;
    if (normalized === 'CANCELLED') return 2;
    return 0;
}

function formatDetailValue(value) {
    if (typeof value === 'object') {
        return JSON.stringify(value, null, 2);
    }
    return String(value);
}

function getHandledBySectionHtml(report) {
    if (report.handled_by) {
        return `
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Handled By</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">
                     <div class="font-semibold text-slate-900">${escapeMapHtml(report.handled_by)}</div>
                    <div class="text-xs text-slate-500"> ${escapeMapHtml(getHandlingStatus(report))}</div>
                </dd>
            </div>
        `;
    }

    if (report.status === 'resolved' || report.status === 'cancelled') {
        return '';
    }

    return '';
}

function getTypeBadge(type) {
    const styles = {
        Fire: 'bg-red-50 text-red-700 ring-red-600/20',
        Medic: 'bg-blue-50 text-blue-700 ring-blue-600/20',
        Police: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
        Unknown: 'bg-slate-100 text-slate-600 ring-slate-500/20'
    };
    return `<span class="inline-flex min-w-[92px] justify-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${styles[type] || styles.Unknown}">${escapeMapHtml(type)}</span>`;
}

function openMapReportDetails(report) {
    const id = report?.id;
    const status = normalizeNotificationStatus(report.status);
    const type = getNotificationCategory(report.category);
    const deviceId = getReporterDeviceId(report);
    const imageUrl = getNotificationImageUrl(report);
    const description = String(report.description || 'No description provided');
    const location = getNotificationLocation(report);
    const timestamp = formatNotificationTimestamp(report);
    const lat = Number(report.latitude || report.lat);
    const lng = Number(report.longitude || report.long || report.longtitude);
    const isTerminal = status === 'RESOLVED' || status === 'CANCELLED';

    if (!isTerminal && Number.isFinite(lat) && Number.isFinite(lng) && map) {
        map.flyTo([lat, lng], 15, { animate: true });
    }

    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('detailsContent');
    const title = document.getElementById('detailsTitle');
    if (!modal || !content) return;

    if (title) {
        title.textContent = `${type} report - ${timestamp}`;
    }

    const metaFields = Object.entries(report)
        .filter(([key]) => !['id','category','status','description','latitude','longitude','lat','lng','longtitude','image_url','created_at','updated_at','device_id','deviceId','reporter_device_id','reporter_device'].includes(key))
        .map(([key, value]) => `
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">${escapeMapHtml(key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()))}</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(formatDetailValue(value))}</dd>
            </div>
        `).join('');

    content.innerHTML = `
        <div class="grid gap-5 lg:grid-cols-[180px_1fr]">
            ${imageUrl ? `
                <div>
                    <button type="button" class="block overflow-hidden rounded-lg border border-slate-200 bg-slate-100 shadow-sm" onclick="window.openLightbox('${escapeMapHtml(imageUrl)}')">
                        <img src="${escapeMapHtml(imageUrl)}" alt="Report attachment" class="h-44 w-full object-cover">
                    </button>
                </div>
                <div class="space-y-4">
                    <div class="flex flex-wrap items-center gap-2">
                        ${getTypeBadge(type)}
                        <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">${escapeMapHtml(timestamp)}</span>
                    </div>
                    <div>
                        <p class="text-xs font-bold uppercase tracking-wide text-slate-500">Description</p>
                        <p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-800">${escapeMapHtml(description)}</p>
                    </div>
                </div>
            ` : `
                <div class="col-span-full space-y-4">
                    <div class="flex flex-wrap items-center gap-2">
                        ${getTypeBadge(type)}
                        <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">${escapeMapHtml(timestamp)}</span>
                    </div>
                    <div>
                        <p class="text-xs font-bold uppercase tracking-wide text-slate-500">Description</p>
                        <p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-800">${escapeMapHtml(description)}</p>
                    </div>
                </div>
            `}
        </div>
        <dl class="mt-5 grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Status</dt>
                <dd class="mt-1 break-words text-sm text-slate-800"><span class="rounded-full px-2 py-0.5 text-xs font-semibold ${getNotificationBadgeClass(status)}">${escapeMapHtml(status)}</span></dd>
            </div>
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Reporter Device ID</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${deviceId ? escapeMapHtml(deviceId) : '-'}</dd>
            </div>
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Location</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(location)}</dd>
            </div>
            ${metaFields || ''}
            ${getHandledBySectionHtml(report)}
        </dl>
    `;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function openNotificationDetailsModal(report) {
    console.log('[Notification] Opening modal for report:', report);
    const status = normalizeNotificationStatus(report.status);
    const type = getNotificationCategory(report.category);
    const deviceId = getReporterDeviceId(report);
    const imageUrl = getNotificationImageUrl(report);
    const description = String(report.description || 'No description provided');
    const location = getNotificationLocation(report);
    const timestamp = formatNotificationTimestamp(report);

    const rawDate = parseSupabaseTimestamp(report.created_at || report.updated_at || report.timestamp || new Date());
    const dateStr = Number.isNaN(rawDate.getTime()) ? '-' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(rawDate);
    const timeStr = Number.isNaN(rawDate.getTime()) ? '-' : new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(rawDate);

    const modal = document.getElementById('notificationDetailsModal');
    const content = document.getElementById('notificationDetailsContent');
    const title = document.getElementById('notificationDetailsTitle');
    if (!modal || !content) return;

    if (title) {
        title.textContent = `${type} report - ${timestamp}`;
    }

    const lat = Number(report.latitude || report.lat);
    const lng = Number(report.longitude || report.long || report.longtitude);
    const reporterName = report.reporter_name || report.reporterName || report.name || report.fullname || null;
    const contactNumber = report.phone_number || report.contact_number || report.contactNumber || report.phone || null;

    const metaFields = Object.entries(report)
        .filter(([key, value]) => {
            if (!value && value !== 0) return false;
            const excluded = ['id','category','status','description','latitude','longitude','lat','lng','longtitude','image_url','created_at','updated_at','device_id','reporter_device_id','reporter_name','phone_number','location','address','handled_by'];
            if (excluded.includes(key)) return false;
            return true;
        })
        .map(([key, value]) => `
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">${escapeMapHtml(key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()))}</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(formatDetailValue(value))}</dd>
            </div>
        `).join('');

    content.innerHTML = `
        <div class="grid gap-5 lg:grid-cols-[180px_1fr]">
            ${imageUrl ? `
                <div>
                    <button type="button" class="block overflow-hidden rounded-lg border border-slate-200 bg-slate-100 shadow-sm" onclick="window.openLightbox('${escapeMapHtml(imageUrl)}')">
                        <img src="${escapeMapHtml(imageUrl)}" alt="Report attachment" class="h-44 w-full object-cover">
                    </button>
                </div>
                <div class="space-y-4">
                    <div class="flex flex-wrap items-center gap-2">
                        ${getTypeBadge(type)}
                        <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">${escapeMapHtml(timestamp)}</span>
                    </div>
                    <div>
                        <p class="text-xs font-bold uppercase tracking-wide text-slate-500">Description</p>
                        <p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-800">${escapeMapHtml(description)}</p>
                    </div>
                </div>
            ` : `
                <div class="col-span-full space-y-4">
                    <div class="flex flex-wrap items-center gap-2">
                        ${getTypeBadge(type)}
                        <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">${escapeMapHtml(timestamp)}</span>
                    </div>
                    <div>
                        <p class="text-xs font-bold uppercase tracking-wide text-slate-500">Description</p>
                        <p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-800">${escapeMapHtml(description)}</p>
                    </div>
                </div>
            `}
        </div>
        <dl class="mt-5 grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Report ID</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(String(report.id || '-'))}</dd>
            </div>
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Status</dt>
                <dd class="mt-1 break-words text-sm text-slate-800"><span class="rounded-full px-2 py-0.5 text-xs font-semibold ${getNotificationBadgeClass(status)}">${escapeMapHtml(status)}</span></dd>
            </div>
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Date</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(dateStr)}</dd>
            </div>
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Time</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(timeStr)}</dd>
            </div>
            ${reporterName ? `
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Reporter's Name</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(reporterName)}</dd>
            </div>
            ` : ''}
            ${contactNumber ? `
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Contact Number</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(contactNumber)}</dd>
            </div>
            ` : ''}
            ${Number.isFinite(lat) ? `
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Latitude</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(String(lat.toFixed(5)))}</dd>
            </div>
            ` : ''}
            ${Number.isFinite(lng) ? `
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Longitude</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(String(lng.toFixed(5)))}</dd>
            </div>
            ` : ''}
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Location</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${escapeMapHtml(location)}</dd>
            </div>
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt class="text-xs font-bold uppercase tracking-wide text-slate-500">Reporter Device ID</dt>
                <dd class="mt-1 break-words text-sm text-slate-800">${deviceId ? escapeMapHtml(deviceId) : '-'}</dd>
            </div>
            ${metaFields || ''}
            ${getHandledBySectionHtml(report)}
         </dl>
     `;

     modal.classList.remove('hidden');
     modal.classList.add('flex');
     console.log('[Notification] Modal shown. Classes:', modal.className);
 }

 function closeNotificationDetailsModal() {
    const modal = document.getElementById('notificationDetailsModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function getNotificationCategory(category) {
    return normalizeEmergencyCategory(category) || 'Police';
}

function getNotificationIcon(category) {
    const type = getNotificationCategory(category);
    if (type === 'Fire') return 'images/fire.png';
    if (type === 'Medic') return 'images/hospital.png';
    return 'images/police.png';
}

function getNotificationBadgeClass(status) {
    if (status === 'RESOLVED') return 'bg-emerald-100 text-emerald-700';
    if (status === 'RESPONDING') return 'bg-amber-100 text-amber-700';
    if (status === 'CANCELLED') return 'bg-rose-100 text-rose-700';
    if (status === 'ASSIGNED') return 'bg-indigo-100 text-indigo-700';
    return 'bg-sky-100 text-sky-700';
}

function getNotificationImageUrl(report) {
    const candidate = report?.image_url || report?.photo_url || '';
    if (!candidate) return '';
    if (/^https?:\/\//i.test(candidate)) return candidate;
    const baseUrl = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : 'https://zjedyulcrxcttbukbynh.supabase.co';
    return `${baseUrl}/storage/v1/object/public/report-images/${candidate}`;
}

function getReporterDeviceId(report) {
    return report?.device_id || report?.deviceId || report?.reporter_device_id || report?.reporter_device || '';
}

function getNotificationLocation(report) {
    const lat = report?.latitude ?? report?.lat;
    const lng = report?.longitude ?? report?.long ?? report?.longtitude;
    if (lat != null && lng != null && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng))) {
        return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
    }
    return report?.location || report?.address || 'Location unavailable';
}

function formatNotificationTimestamp(report) {
    const raw = report?.created_at || report?.updated_at || report?.timestamp || new Date().toISOString();
    const date = parseSupabaseTimestamp(raw);
    if (Number.isNaN(date.getTime())) return 'Unknown time';
    return `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date)} • ${new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(date)}`;
}

function renderNotificationPanel() {
    const listEl = document.getElementById('notificationList');
    if (!listEl) return;

    const seen = new Set();
    const items = [];
    if (Array.isArray(window.allIncidents)) {
        window.allIncidents.forEach(report => {
            const id = String(report.id);
            if (seen.has(id)) return;
            seen.add(id);
            const category = getNotificationCategory(report.category);
            if (notificationFilter !== 'All' && category !== notificationFilter) return;
            items.push({ report, category });
        });
    }

    items.sort((a, b) => {
        const aPriority = getNotificationStatusPriority(a.report?.status);
        const bPriority = getNotificationStatusPriority(b.report?.status);
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aTime = new Date(a.report?.created_at || a.report?.updated_at || 0).getTime();
        const bTime = new Date(b.report?.created_at || b.report?.updated_at || 0).getTime();
        return bTime - aTime;
    });

    if (!items.length) {
        listEl.innerHTML = `
            <div class="rounded-xl border border-dashed border-slate-300 bg-slate-50/80 p-4 text-center text-sm text-slate-500">
                No notifications match the current filter.
            </div>
        `;
        return;
    }

    listEl.innerHTML = items.map(({ report, category }) => {
        const status = normalizeNotificationStatus(report.status);
        const deviceId = getReporterDeviceId(report);
        const imageUrl = getNotificationImageUrl(report);
        const isSelected = String(selectedNotificationId) === String(report.id);
        const description = String(report.description || 'No description provided').slice(0, 140);
        const clickHandler = status === 'RESOLVED' || status === 'CANCELLED'
            ? `openNotificationDetails('${report.id}')`
            : `handleActiveNotificationClick('${report.id}')`;
        return `
            <button type="button"
                onclick="${clickHandler}"
                class="notification-card w-full rounded-xl border ${isSelected ? 'selected' : 'border-slate-200 bg-white/95'} p-3 text-left shadow-sm hover:border-blue-300 hover:shadow-md">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex items-start gap-2">
                        <div class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100">
                            <img src="${getNotificationIcon(category)}" alt="${escapeMapHtml(category)}" class="h-5 w-5 object-contain" onerror="this.style.visibility='hidden'">
                        </div>
                        <div>
                            <div class="flex flex-wrap items-center gap-2">
                                <p class="text-sm font-semibold uppercase tracking-wide text-slate-800">${escapeMapHtml(category)}</p>
                                <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold ${getNotificationBadgeClass(status)}">${escapeMapHtml(status)}</span>
                            </div>
                            <p class="mt-1 text-sm text-slate-700 line-clamp-3">${escapeMapHtml(description)}</p>
                        </div>
                    </div>
                </div>
                <div class="mt-3 space-y-1.5 text-xs text-slate-600">
                    ${deviceId ? `<p><span class="font-semibold text-slate-700">Reporter ID:</span> ${escapeMapHtml(deviceId)}</p>` : ''}
                    <p><span class="font-semibold text-slate-700">Time:</span> ${escapeMapHtml(formatNotificationTimestamp(report))}</p>
                    <p><span class="font-semibold text-slate-700">Location:</span> ${escapeMapHtml(getNotificationLocation(report))}</p>
                    ${report.handled_by ? `<p><span class="font-semibold text-slate-700">Handled By:</span> ${escapeMapHtml(report.handled_by)}</p>` : ''}
                </div>
                ${imageUrl ? `<img src="${escapeMapHtml(imageUrl)}" alt="Incident preview" class="mt-3 h-24 w-full rounded-lg object-cover border border-slate-200" onerror="this.style.display='none'">` : ''}
            </button>
        `;
    }).join('');
}

function handleActiveNotificationClick(id) {
    const report = window.allIncidents?.find(n => String(n.id) === String(id));
    if (!report) {
        console.warn('[Notification] Report not found for id:', id, 'allIncidents:', window.allIncidents);
        return;
    }

    const status = normalizeNotificationStatus(report.status);
    if (status === 'RESOLVED' || status === 'CANCELLED') {
        openNotificationDetails(id);
        return;
    }

    selectedNotificationId = String(id);
    renderNotificationPanel();

    if (!map) return;

    let marker = null;
    if (window.incidentLayer) {
        window.incidentLayer.eachLayer(layer => {
            if (!marker && String(layer.incidentId) === String(id)) {
                marker = layer;
            }
        });
    }

    if (marker) {
        map.flyTo(marker.getLatLng(), 15, { animate: true });
        return;
    }

    const lat = Number(report.latitude || report.lat);
    const lng = Number(report.longitude || report.long || report.longtitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        map.flyTo([lat, lng], 15, { animate: true });
    }
}

function selectNotification(id) {
    selectedNotificationId = String(id);
    renderNotificationPanel();

    const report = window.allIncidents?.find(n => String(n.id) === String(id));
    if (!report) return;

    if (!map) {
        openNotificationDetailsModal(report);
        return;
    }

    let foundMarker = false;
    if (window.incidentLayer) {
        window.incidentLayer.eachLayer(layer => {
            if (String(layer.incidentId) === String(id)) {
                foundMarker = true;
                const status = String(layer._report?.status || '').toLowerCase().trim();
                if (status !== 'resolved' && status !== 'cancelled') {
                    map.flyTo(layer.getLatLng(), 15, { animate: true });
                    layer.openPopup();
                }
            }
        });
    }

    if (!foundMarker) {
        const status = String(report.status || '').toLowerCase().trim();
        if (status === 'resolved' || status === 'cancelled') {
            openNotificationDetailsModal(report);
            return;
        }

        const lat = Number(report.latitude || report.lat);
        const lng = Number(report.longitude || report.long || report.longtitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            map.flyTo([lat, lng], 15, { animate: true });
        }
    }

    openNotificationDetailsModal(report);
}

function panToIncident(id) {
    selectNotification(id);
}

function openNotificationDetails(id) {
    selectedNotificationId = String(id);
    renderNotificationPanel();

    const report = window.allIncidents?.find(n => String(n.id) === String(id));
    if (!report) {
        console.warn('[Notification] Report not found for id:', id, 'allIncidents:', window.allIncidents);
        return;
    }

    openNotificationDetailsModal(report);
}

async function loadReports() {
    if (!map) {
        console.warn('Map not initialized yet');
        return;
    }
    try {
        const { data, error } = await window.supabaseClient
            .from('incidents')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error loading reports:', error);
            return;
        }
        if (!data) return;

        window.allIncidents = (data || []).filter(report => {
            const lat = report.latitude || report.lat;
            const lng = report.longitude || report.long || report.longtitude;
            return lat && lng && isPointInPolygon(lat, lng);
        });
        window.incidentLayer.clearLayers();
        window.allIncidents.forEach(report => addIncidentMarker(report));
        renderNotificationPanel();
        updateActiveCounters();
    } catch (err) {
        console.error('Exception in loadReports:', err);
    }
}

function getHandlingStatus(report) {
    if (report.status === 'resolved') return 'RESOLVED';
    if (report.status === 'cancelled') return 'CANCELLED';
    if (report.handled_by) return 'ASSIGNED';
    return 'Waiting for an available admin';
}

function getHandledByHtml(report, id) {
    if (report.handled_by) {
        return `
            <div style="margin-top:8px; padding-top:8px; border-top:1px solid #e2e8f0;">
                <div style="font-size:11px; font-weight:700; color:#0f172a; text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px;">
                     Handled By
                </div>
                <div style="font-size:13px; color:#334155; line-height:1.5;">
                     <div style="font-weight:700; color:#0f172a;">${escapeMapHtml(report.handled_by)}</div>
                    <div style="font-size:12px; color:#64748b;">${escapeMapHtml(getHandlingStatus(report))}</div>
                </div>
            </div>
        `;
    }

    if (report.status === 'resolved' || report.status === 'cancelled') {
        return '';
    }

    return '';
}

function getIncidentPopupHtml(report, id) {
    const lat = Number(report.latitude || report.lat);
    const lng = Number(report.longitude || report.long || report.longtitude);
    const category = String(report.category || '').toLowerCase().trim();
    const isPolice = category.includes('police');
    const isFire = category.includes('fire');
    const isMedic = category.includes('medic') || category.includes('medical') || category.includes('hospital');
    const recommended = ((isPolice || isFire || isMedic) && Number.isFinite(lat) && Number.isFinite(lng))
        ? isPolice
            ? getRecommendedPoliceStation(lat, lng)
            : isFire
                ? getRecommendedFireStation(lat, lng)
                : getRecommendedHospital(lat, lng)
        : null;
    const recommendedHtml = recommended ? `
        <div style="margin-top:10px; border-top:1px solid #e2e8f0; padding-top:8px;">
            <div style="font-size:11px; font-weight:700; color:#0f172a; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px;">
                Suggested Station Contact
            </div>
            <div style="font-size:13px; color:#334155; line-height:1.5;">
                <div style="font-weight:700; color:#0f172a;">${escapeMapHtml(recommended.name)}</div>
                <div style="font-size:12px; color:#64748b; margin-top:2px;">📏 ${escapeMapHtml(formatDistance(recommended.distanceKm))}</div>
                <div style="font-size:12px; color:#64748b; margin-top:6px;">Contact Number: <span style="font-weight:700; color:#000000;">${escapeMapHtml(recommended.hotline || 'Not Available')}</span></div>
            </div>
        </div>
    ` : '';

    return `
        <div style="min-width:220px; max-width:260px;">
            <div style="font-size:14px; font-weight:700; color:#0f172a; text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid #e2e8f0; padding-bottom:6px; margin-bottom:6px;">
                ${escapeMapHtml((report.category || 'emergency').toUpperCase())}
            </div>
            <div style="font-size:13px; color:#334155; line-height:1.5;">
                ${escapeMapHtml(report.description || 'No description provided')}
            </div>
            ${report.phone_number ? `
                <div style="font-size:13px; color:#334155; line-height:1.5; margin-top:4px;">
                    <strong>Phone:</strong> ${escapeMapHtml(report.phone_number)}
                </div>
            ` : ''}
            ${report.image_url ? `
                <img src="${report.image_url}"
                     style="width:100%; max-height:120px; object-fit:cover; border-radius:6px; margin-top:8px; cursor:pointer;"
                     onclick="window.openLightbox('${report.image_url.replace(/'/g, "\\'")}')"
                     onerror="this.style.display='none'"/>
            ` : ''}
            ${recommendedHtml}
            ${getHandledByHtml(report, id)}
            <div style="margin-top:10px; display:flex; gap:8px;">
                <button onclick="markAsResolved('${id}')"
                    style="flex:1;background:#28a745;color:white;border:none;padding:8px;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">
                    DONE
                </button>
                <button onclick="markAsCancelled('${id}')"
                    style="flex:1;background:#dc3545;color:white;border:none;padding:8px;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">
                    CANCEL
                </button>
            </div>
        </div>
    `;
}

function addIncidentMarker(report) {
    if (!map) return false;

    const id = String(report.id);
    if (report.status === 'resolved' || report.status === 'cancelled') return false;

    if (window.incidentLayer) {
        const exists = window.incidentLayer.getLayers().some(l => String(l.incidentId) === id);
        if (exists) return false;
    }

    const lat = report.latitude || report.lat;
    const lng = report.longitude || report.long || report.longtitude;
    if (!lat || !lng || !isPointInPolygon(lat, lng)) return false;

    const category = String(report.category || '').toLowerCase().trim();
    const icon = category.includes('police') ? window.blueIcon : category === 'fire' ? window.redIcon : category.includes('medic') || category.includes('medical') || category.includes('hospital') ? window.greenIcon : window.redIcon;

    const marker = L.marker([lat, lng], { icon }).addTo(window.incidentLayer);
    marker.incidentId = String(id);
    marker.incidentCategory = report.category;
    marker._report = report;
    marker._nearest = getNearestAgencies(report.category, lat, lng);

    marker.bindPopup(getIncidentPopupHtml(report, id), { maxWidth: 260, minWidth: 260, direction: 'auto', autoPan: false });

    marker._popupPinned = false;
    let popupCloseTimer = null;

    marker.on('mouseover', function () {
        clearTimeout(popupCloseTimer);
        if (!marker._popupPinned) {
            map.dragging.disable();
            marker.openPopup();
        }
    });

    marker.on('mouseout', function () {
        if (!marker._popupPinned) {
            popupCloseTimer = setTimeout(() => {
                marker.closePopup();
                map.dragging.enable();
            }, 600);
        }
    });

    marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        clearTimeout(popupCloseTimer);
        marker._popupPinned = !marker._popupPinned;
        if (marker._popupPinned) {
            map.dragging.enable();
            marker.openPopup();
            if (marker.isPopupOpen() && map.getZoom() < 14) {
                map.setView(marker.getLatLng(), 14, { animate: true });
            }
            setTimeout(() => {
                const px = map.project(marker.getLatLng());
                px.y -= 160;
                map.panTo(map.unproject(px), { animate: true });
            }, 300);
        } else {
            marker.closePopup();
            map.dragging.enable();
        }
    });

    map.on('click', function () {
        if (marker._popupPinned) {
            marker._popupPinned = false;
            marker.closePopup();
            map.dragging.enable();
        }
    });

    marker.on('popupclose', function () {
        if (marker._popupPinned) marker.openPopup();
    });

    return true;
}

async function markAsResolved(incidentId) {
    const id = String(incidentId);
    const adminId = sessionStorage.getItem('adminUserID');
    let adminName = null;
    try {
        if (adminId && window.supabaseClient) {
            const { data } = await window.supabaseClient
                .from('admins')
                .select('fullname')
                .eq('id', adminId)
                .single();
            adminName = data?.fullname || null;
        }
    } catch (e) {
        console.error('Failed to fetch admin info for markAsResolved:', e);
    }

    const updateData = { status: 'resolved' };
    if (adminName) {
        updateData.handled_by = adminName;
    }

    try {
        const { error } = await window.supabaseClient
            .from('incidents')
            .update(updateData)
            .eq('id', id);

        if (error) {
            console.error("Database Error:", error.message);
            alert('Failed to update report status. Please try again.');
            return;
        }
    } catch (e) {
        console.error('Exception updating report:', e);
        alert('Failed to update report status. Please try again.');
        return;
    }

    removeMarkerFromMap(id);
}

async function markAsCancelled(incidentId) {
    const id = String(incidentId);
    const adminId = sessionStorage.getItem('adminUserID');
    let adminName = null;
    try {
        if (adminId && window.supabaseClient) {
            const { data } = await window.supabaseClient
                .from('admins')
                .select('fullname')
                .eq('id', adminId)
                .single();
            adminName = data?.fullname || null;
        }
    } catch (e) {
        console.error('Failed to fetch admin info for markAsCancelled:', e);
    }

    const updateData = { status: 'cancelled' };
    if (adminName) {
        updateData.handled_by = adminName;
    }

    try {
        const { error } = await window.supabaseClient
            .from('incidents')
            .update(updateData)
            .eq('id', id);

        if (error) {
            console.error("Database Error:", error.message);
            alert('Failed to update report status. Please try again.');
            return;
        }
    } catch (e) {
        console.error('Exception updating report:', e);
        alert('Failed to update report status. Please try again.');
        return;
    }

    removeMarkerFromMap(id);
}

function removeMarkerFromMap(id) {
    if (!window.incidentLayer) return;
    window.incidentLayer.eachLayer(layer => {
        if (String(layer.incidentId) === String(id)) {
            layer._popupPinned = false;
            try { layer.closePopup(); } catch (e) { /* ignore */ }
            window.incidentLayer.removeLayer(layer);
        }
    });
    renderNotificationPanel();
    updateActiveCounters();
    if (typeof window.refreshMapSize === 'function') {
        window.refreshMapSize();
    }
}

function bindNotificationPanelEvents() {
    const filterEl = document.getElementById('notificationFilter');
    if (!filterEl) return;
    filterEl.addEventListener('change', (event) => {
        notificationFilter = event.target.value || 'All';
        renderNotificationPanel();
    });
}

window.supabaseClient
    .channel('map-updates')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'incidents' }, (payload) => {
        const lat = payload.new.latitude || payload.new.lat;
        const lng = payload.new.longitude || payload.new.long;
        if (!lat || !lng || !isPointInPolygon(lat, lng)) return;

        if (!window.allIncidents) window.allIncidents = [];
        if (!window.allIncidents.find(n => String(n.id) === String(payload.new.id))) {
            window.allIncidents.unshift(payload.new);
        }

        const markerAdded = addIncidentMarker(payload.new);
        renderNotificationPanel();
        updateActiveCounters();

        if (!markerAdded) return;

        try {
            new Audio('https://www.soundjay.com/buttons/beep-01a.mp3').play().catch(() => {});
        } catch (e) { /* ignore */ }

        if (lat && lng) map.flyTo([lat, lng], 15);

        try { showNewReportToast(payload.new); } catch (e) { /* ignore */ }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'incidents' }, (payload) => {
        const lat = payload.new.latitude || payload.new.lat;
        const lng = payload.new.longitude || payload.new.long;
        if (!lat || !lng || !isPointInPolygon(lat, lng)) {
            if (window.allIncidents) {
                window.allIncidents = window.allIncidents.filter(n => String(n.id) !== String(payload.new.id));
            }
            removeMarkerFromMap(payload.new.id);
            updateActiveCounters();
            renderNotificationPanel();
            return;
        }

        const id = String(payload.new.id);
        if (window.allIncidents) {
            window.allIncidents = window.allIncidents.map(n => String(n.id) === id ? payload.new : n);
        }
        
        const status = (payload.new.status || '').toLowerCase().trim();
        if (status === 'resolved' || status === 'cancelled') {
            removeMarkerFromMap(id);
        } else if (status === 'active') {
            removeMarkerFromMap(id);
            addIncidentMarker(payload.new);
        }
        renderNotificationPanel();
        updateActiveCounters();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'incidents' }, (payload) => {
        const id = String(payload.old.id);
        if (window.allIncidents) {
            window.allIncidents = window.allIncidents.filter(n => String(n.id) !== String(id));
        }
        removeMarkerFromMap(id);
        updateActiveCounters();
    })
    .subscribe((status) => console.log('Supabase subscription:', status));

setInterval(() => {
    loadReports();
    updateActiveCounters();
}, 5000);

window.initializeMap = initializeMap;
window.showCallerLocationPing = showCallerLocationPing;
window.clearCallerLocationPing = clearCallerLocationPing;
window.dismissCallerLocationPing = dismissCallerLocationPing;
window.replayActiveCallerAlerts = renderActiveCallerMarkers;
window.cacheCallerLocationAlert = cacheCallerLocationAlert;
window.showClaimedCallerLocation = showClaimedCallerLocation;
window.drainPendingRealtimeIncomingAlerts = drainPendingRealtimeIncomingAlerts;
window.centerMap = centerMap;
window.selectNotification = selectNotification;
window.handleActiveNotificationClick = handleActiveNotificationClick;
window.openNotificationDetails = openNotificationDetails;
window.closeNotificationDetailsModal = closeNotificationDetailsModal;
window.markAsResolved = markAsResolved;
window.markAsCancelled = markAsCancelled;
window.refreshMapSize = function refreshMapSize() {
    if (map && typeof map.invalidateSize === 'function') {
        map.invalidateSize();
    }
};

subscribeToCallerLocations();

function initMapLegend() {
    const panel = document.getElementById('mapLegendPanel');
    const content = document.getElementById('mapLegendContent');
    if (!panel || !content) return;

    const items = [
        { icon: 'images/police.png', label: 'Police Station' },
        { icon: 'images/fire.png', label: 'Fire Station' },
        { icon: 'images/hospital.png', label: 'Hospital' },
        { icon: 'images/marker-icon-blue.png', label: 'Police Report' },
        { icon: 'images/marker-icon-red.png', label: 'Fire Report' },
        { icon: 'images/marker-icon-green.png', label: 'Medical Report' }
    ];

    const svgIcons = {
        'resolved': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-emerald-600" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
        'cancelled': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-red-500" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
        'user-location': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-blue-500" fill="currentColor"><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"/></svg>',
        'admin-dispatch': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-purple-600" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>',
        'online': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-emerald-500" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
        'offline': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-slate-400" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
        'boundary': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-slate-600" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2"/></svg>',
        'radius': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-slate-600" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.3"/></svg>',
        'cluster': '<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-slate-700" fill="currentColor"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><circle cx="12" cy="16" r="3"/></svg>'
    };

    content.innerHTML = items.map(item => {
        const iconHtml = item.icon.startsWith('svg:')
            ? (svgIcons[item.icon.slice(4)] || '')
            : `<img src="${item.icon}" alt="" class="h-3.5 w-3.5 object-contain shrink-0" onerror="this.style.visibility='hidden'">`;
        return `
            <div class="flex items-center gap-1">
                <div class="h-4 w-4 flex items-center justify-center shrink-0">${iconHtml}</div>
                <span class="text-[10px] font-semibold text-slate-800 leading-tight truncate">${item.label}</span>
            </div>
        `;
    }).join('');
}

function tryInitializeMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl) {
        console.error('Map container #map not found during init');
        return;
    }
    if (!window.L) {
        console.error('Leaflet is not loaded during init');
        return;
    }
    bindNotificationPanelEvents();
    initializeMap();
    initMapLegend();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryInitializeMap, 0));
} else {
    setTimeout(tryInitializeMap, 0);
}
