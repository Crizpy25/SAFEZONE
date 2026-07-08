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
        console.warn('Map already initialized');
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

    console.log('Initializing map...');
    const rect = mapEl.getBoundingClientRect();
    console.log('Map container dimensions:', rect.width, 'x', rect.height);
    try {
        map = L.map('map', {
            minZoom: 13.2,
            maxZoom: 18,
            maxBoundsViscosity: 0.3
        }).setView([10.7202, 122.5525], 13);
        console.log('Leaflet map created successfully');
    } catch (e) {
        console.error('Failed to create Leaflet map:', e);
        return;
    }

    try {
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);
        console.log('Tile layer added');
    } catch (e) {
        console.error('Failed to add tile layer:', e);
    }

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);

    window.policeLayer = L.layerGroup().addTo(map);
    window.fireLayer = L.layerGroup().addTo(map);
    window.hospitalLayer = L.layerGroup().addTo(map);
    window.incidentLayer = L.layerGroup().addTo(map);

    const policeIcon = L.icon({
        iconUrl: 'images/police.png',
        iconSize: [30, 30],
        iconAnchor: [17, 35],
        popupAnchor: [0, -35]
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
        { name: 'PS3 Jaro', lat: 10.71560226623802, lng: 122.56266469623272, icon: policeIcon, layer: window.policeLayer },
        { name: 'Molo Police Station', lat: 10.698346304433658, lng: 122.55105476464729, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS5 Mandurriao', lat: 10.71683400704982, lng: 122.53648059623264, icon: policeIcon, layer: window.policeLayer },
        { name: 'Arevalo Police Station', lat: 10.68890021276814, lng: 122.51886825833218, icon: policeIcon, layer: window.policeLayer },
        { name: 'PS7 Lapuz', lat: 10.693878433584727, lng: 122.55874469935698, icon: policeIcon, layer: window.policeLayer },
        { name: 'Sambag Police Assistant', lat: 10.742333401995415, lng: 122.5409438842518, icon: policeIcon, layer: window.policeLayer },
        { name: 'Ungka Police Station', lat: 10.747512542219782, lng: 122.54008363707585, icon: policeIcon, layer: window.policeLayer },
        { name: 'ICPO Police Station 9', lat: 10.7272054892569, lng: 122.56710895228002, icon: policeIcon, layer: window.policeLayer },
        { name: 'ICPO Police Station 10', lat: 10.70553584277189, lng: 122.55517513417514, icon: policeIcon, layer: window.policeLayer },
        { name: 'ICARE Fire station', lat: 10.705088291583916, lng: 122.55490712638891, icon: fireIcons, layer: window.fireLayer },
        { name: 'La Paz Fire Sub-Station', lat: 10.712651852092284, lng: 122.57295111469945, icon: fireIcons, layer: window.fireLayer },
        { name: 'Federation Iloilo Fire Station', lat: 10.698697241164309, lng: 122.57076622219913, icon: fireIcons, layer: window.fireLayer },
        { name: 'BFP Iloilo', lat: 10.690705849929284, lng: 122.58144791800282, icon: fireIcons, layer: window.fireLayer },
        { name: 'Bo. Obrero Fire Sub-Station', lat: 10.702275407727985, lng: 122.59067301967075, icon: fireIcons, layer: window.fireLayer },
        { name: 'Mandurriao Fire Sub-Station', lat: 10.719211489646474, lng: 122.53920666146492, icon: fireIcons, layer: window.fireLayer },
        { name: 'Arevalo Fire Sub-Station', lat: 10.688797426748417, lng: 122.51626529021178, icon: fireIcons, layer: window.fireLayer },
        { name: 'Sto. Niño Sur Fire Sub-Station', lat: 10.68223713089546, lng: 122.5099533777009, icon: fireIcons, layer: window.fireLayer },
        { name: 'BFP Jaro', lat: 10.72744065268221, lng: 122.56251218153137, icon: fireIcons, layer: window.fireLayer },
        { name: 'Ungka Fire Sub-Station', lat: 10.74690941039231, lng: 122.53931659330536, icon: fireIcons, layer: window.fireLayer },
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
        L.marker([s.lat, s.lng], { icon: s.icon }).addTo(s.layer).bindPopup(s.name);
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

    setTimeout(() => {
        try { map.invalidateSize(); } catch (e) { /* ignore */ }
    }, 100);

    setTimeout(() => {
        try { map.invalidateSize(); } catch (e) { /* ignore */ }
    }, 500);

    setTimeout(refreshToggleState, 50);
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

function closeCategoryReports() {
    const panel = document.getElementById('categoryReportsPanel');
    if (panel) panel.classList.add('hidden');
}

function showNewReportToast(report) {
    const slots = Array.from(document.querySelectorAll('.new-report-toast-slot'));
    if (!slots.length) return;

    const category = report.category ? report.category.toUpperCase() : 'EMERGENCY';
    const desc = report.description ? `: ${report.description}` : '';
    const rawTime = report.created_at ? new Date(report.created_at) : new Date();
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

function panToIncident(id) {
    if (!window.incidentLayer) return;
    window.incidentLayer.eachLayer(layer => {
        if (String(layer.incidentId) === String(id)) {
            map.flyTo(layer.getLatLng(), 15, { animate: true });
            layer.openPopup();
        }
    });
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
            .not('status', 'in', '("resolved","cancelled")');

        if (error) {
            console.error('Error loading reports:', error);
            return;
        }
        if (!data) return;

        window.incidentLayer.clearLayers();
        data.forEach(report => addIncidentMarker(report));
        updateActiveCounters();
    } catch (err) {
        console.error('Exception in loadReports:', err);
    }
}

function addIncidentMarker(report) {
    if (!map) return false;

    const id = report.id;
    if (!id || report.status === 'resolved' || report.status === 'cancelled') return false;

    const lat = report.latitude || report.lat;
    const lng = report.longitude || report.long || report.longtitude;
    if (!lat || !lng || !isPointInPolygon(lat, lng)) return false;

    const category = String(report.category || '').toLowerCase().trim();
    const icon = category.includes('police') ? window.blueIcon : category === 'fire' ? window.redIcon : category.includes('medic') || category.includes('medical') || category.includes('hospital') ? window.greenIcon : window.redIcon;

    const marker = L.marker([lat, lng], { icon }).addTo(window.incidentLayer);
    marker.incidentId = String(id);
    marker.incidentCategory = report.category;
    marker._nearest = getNearestAgencies(report.category, lat, lng);

    const nearestHtml = marker._nearest.length
        ? marker._nearest.slice(0, 1).map(a => `
            <div style="margin-top:6px;">
              <div style="font-weight:700;color:#0f172a;">Nearest responder: ${escapeMapHtml(a.name)}</div>
              <div style="font-size:12px;color:#64748b;">${escapeMapHtml(a.type)} — ${escapeMapHtml(formatDistance(a.distanceKm))}</div>
            </div>
          `).join('')
        : `<span style="color:#94a3b8;">No nearby responder found</span>`;

    const popupContent = `
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
            <div id="nearest-responder-${id}" style="margin-top:8px; border-top:1px solid #e2e8f0; padding-top:6px; font-size:12px; color:#64748b;">
                ${nearestHtml}
            </div>
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

    marker.bindPopup(popupContent, { maxWidth: 260, minWidth: 260, direction: 'auto', autoPan: false });

    let popupPinned = false;
    let popupCloseTimer = null;

    marker.on('mouseover', function () {
        clearTimeout(popupCloseTimer);
        if (!popupPinned) {
            map.dragging.disable();
            marker.openPopup();
        }
    });

    marker.on('mouseout', function () {
        if (!popupPinned) {
            popupCloseTimer = setTimeout(() => {
                marker.closePopup();
                map.dragging.enable();
            }, 600);
        }
    });

    marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        clearTimeout(popupCloseTimer);
        popupPinned = !popupPinned;
        if (popupPinned) {
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
        if (popupPinned) {
            popupPinned = false;
            marker.closePopup();
            map.dragging.enable();
        }
    });

    marker.on('popupclose', function () {
        if (popupPinned) marker.openPopup();
    });

    marker.on('popupopen', function () {
        const el = document.getElementById(`nearest-responder-${id}`);
        if (!el) return;
        const nearest = marker._nearest || [];
        if (nearest.length) {
            el.innerHTML = `
                <div style="font-weight:700; color:#0f172a; margin-bottom:2px;">Nearest responder: ${escapeMapHtml(nearest[0].name)}</div>
                <div style="font-size:11px; color:#64748b;">${escapeMapHtml(nearest[0].type)} — ${escapeMapHtml(formatDistance(nearest[0].distanceKm))}</div>
            `;
        } else {
            el.innerHTML = `<span style="color:#94a3b8;">No nearby responder found</span>`;
        }
    });

    return true;
}

async function markAsResolved(incidentId) {
    const id = typeof incidentId === 'number' ? incidentId : /^\d+$/.test(String(incidentId)) ? Number(incidentId) : incidentId;
    const { data, error } = await window.supabaseClient
        .from('incidents')
        .update({ status: 'resolved' })
        .eq('id', id)
        .select();

    if (error) {
        console.error("Database Error:", error.message);
        return;
    }
    removeMarkerFromMap(id);
}

async function markAsCancelled(incidentId) {
    const id = typeof incidentId === 'number' ? incidentId : /^\d+$/.test(String(incidentId)) ? Number(incidentId) : incidentId;
    const { data, error } = await window.supabaseClient
        .from('incidents')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .select();

    if (error) {
        console.error("Database Error:", error.message);
        return;
    }
    removeMarkerFromMap(id);
}

function removeMarkerFromMap(id) {
    if (!window.incidentLayer) return;
    window.incidentLayer.eachLayer(layer => {
        if (String(layer.incidentId) === String(id)) {
            window.incidentLayer.removeLayer(layer);
        }
    });
    updateActiveCounters();
}

supabaseClient
    .channel('map-updates')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'incidents' }, (payload) => {
        const lat = payload.new.latitude || payload.new.lat;
        const lng = payload.new.longitude || payload.new.long;
        if (!lat || !lng || !isPointInPolygon(lat, lng)) return;

        const markerAdded = addIncidentMarker(payload.new);
        if (!markerAdded) return;
        updateActiveCounters();

        try {
            new Audio('https://www.soundjay.com/buttons/beep-01a.mp3').play().catch(() => {});
        } catch (e) { /* ignore */ }

        if (lat && lng) map.flyTo([lat, lng], 15);

        try { showNewReportToast(payload.new); } catch (e) { /* ignore */ }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'incidents' }, (payload) => {
        const id = String(payload.new.id);
        const status = (payload.new.status || '').toLowerCase().trim();
        if (status === 'resolved' || status === 'cancelled') {
            removeMarkerFromMap(id);
        } else if (status === 'active') {
            removeMarkerFromMap(id);
            addIncidentMarker(payload.new);
        }
        updateActiveCounters();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'incidents' }, (payload) => {
        const id = String(payload.old.id);
        removeMarkerFromMap(id);
        updateActiveCounters();
    })
    .subscribe((status) => console.log('Supabase subscription:', status));

setInterval(() => {
    loadReports();
    updateActiveCounters();
}, 5000);

window.initializeMap = initializeMap;
window.centerMap = centerMap;

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
    initializeMap();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryInitializeMap, 0));
} else {
    setTimeout(tryInitializeMap, 0);
}
