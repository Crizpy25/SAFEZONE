// 1. CONFIGURATION
// Supabase client is initialized in auth.js and exposed as window.supabaseClient
// We'll use that shared instance to avoid duplication

// State for GPS Tracking
let trackingMarkers = new Map();
let map; // Declare map globally

// Initialize map after DOM is ready
function initializeMap() {
    console.log('Initializing map...');
    
    // Check if map element exists
    const mapElement = document.getElementById('map');
    if (!mapElement) {
        console.error('Map element not found');
        return;
    }

    console.log('Map element found, creating Leaflet map...');

    // 2. MAP SETUP
    const bounds = L.latLngBounds(
        [10.65, 122.48], // Southwest corner
        [10.77, 122.62]  // Northeast corner
    );

    map = L.map('map', {
        minZoom: 13.2,
        maxZoom: 18,
        maxBounds: bounds,
        maxBoundsViscosity: 0.7
    }).setView([10.7202, 122.5621], 13);

    console.log('Map created successfully');

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
    }).addTo(map);

    // 3. LAYER GROUPS
    window.policeLayer = L.layerGroup();
    window.fireLayer = L.layerGroup();
    window.hospitalLayer = L.layerGroup();
    window.incidentLayer = L.layerGroup().addTo(map); 
    window.trackingLayer = L.layerGroup().addTo(map); 

    // 4. ICONS
    const policeIcon = L.icon({
        iconUrl: "images/police.png",
        iconSize: [30, 30],
        iconAnchor: [17, 35],
        popupAnchor: [0, -35]
    });

    const fireIcons = L.icon({
        iconUrl: "images/fire.png",
        iconSize: [30, 30],
        iconAnchor: [17, 35],
        popupAnchor: [0, -35]
    });

    const hospitalIcon = L.icon({
        iconUrl: "images/hospital.png",
        iconSize: [30, 30],
        iconAnchor: [17, 35],
        popupAnchor: [0, -35]
    });

    const redIcon = L.icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });

    // Store icons globally
    window.redIcon = redIcon;

    // 5. STATIC DATA LOAD
    const policeStations = [
        ["PS1 City Proper",10.701501994092405, 122.56369039944839],
        ["PS2 La Paz",10.70552222109631, 122.56549995693831],
        ["PS3 Jaro",10.71560226623802, 122.56266469623272],
        ["Molo Police Station",10.698346304433658, 122.55105476464729],
        ["PS5 Mandurriao",10.71683400704982,122.53648059623264],
        ["Arevalo Police Station",10.68890021276814, 122.51886825833218],
        ["PS7 Lapuz",10.693878433584727, 122.55874469935698],
        ["Sambag Police Assistant",10.742333401995415, 122.5409438842518],
        ["Ungka Police Station",10.747512542219782, 122.54008363707585],
        ["ICPO Police Station 9",10.7272054892569, 122.56710895228002],
        ["ICPO Police Station 10",10.70553584277189, 122.55517513417514]
    ];
    policeStations.forEach(s => L.marker([s[1], s[2]], {icon: policeIcon}).addTo(window.policeLayer).bindPopup(s[0]));

    const fireStations = [
        ["La Paz Fire Sub-Station", 10.712651852092284, 122.57295111469945],
        ["Federation Iloilo Fire Station", 10.698697241164309, 122.57076622219913],
        ["BFP Iloilo", 10.690705849929284, 122.58144791800282],
        ["Bo. Obrero Fire Sub-Station", 10.702275407727985, 122.59067301967075],
        ["Mandurriao Fire Sub-Station", 10.719211489646474, 122.53920666146492],
        ["Arevalo Fire Sub-Station", 10.688797426748417, 122.51626529021178],
        ["Sto. Niño Sur Fire Sub-Station", 10.68223713089546, 122.5099533777009],
        ["BFP Jaro", 10.72744065268221, 122.56251218153137],
        ["Ungka Fire Sub-Station", 10.74690941039231, 122.53931659330536],
        ["Old Molo Fire Station", 10.697030999439814, 122.5488881609591],
        ["San Isidro Fire Sub-Station", 10.736444550002995, 122.5458557423291]
    ];
    fireStations.forEach(s => L.marker([s[1], s[2]], {icon: fireIcons}).addTo(window.fireLayer).bindPopup(s[0]));

    const hospitals = [
        ["Western Visayas Medical Center (Public)", 10.718885489071287, 122.54193891896666],
        ["Iloilo Mission Hospital", 10.714817707214994, 122.56058274040979],
        ["St. Paul's Hospital Iloilo", 10.702011896133618, 122.56694877109325],
        ["Iloilo Doctors' Hospital", 10.696804152759018, 122.55440768089073],
        ["The Medical City Iloilo", 10.699644543003238, 122.54277137544258],
        ["West Visayas State University Medical Center", 10.717168244196454, 122.56120580362972],
        ["QualiMed Hospital Iloilo", 10.706542561402188, 122.54782241379408],
        ["Medicus Medical Center", 10.702756754480117, 122.55224702393059],
        ["AMOSUP Seamen's Hospital", 10.714828158629505, 122.53455543124073],
    ];
    hospitals.forEach(s => L.marker([s[1], s[2]], {icon: hospitalIcon}).addTo(window.hospitalLayer).bindPopup(s[0]));

    // Load reports after map is initialized
    loadReports();
}

// 6. TOGGLE FUNCTIONS
function togglePolice() { 
    if (!map) return;
    map.hasLayer(window.policeLayer) ? map.removeLayer(window.policeLayer) : window.policeLayer.addTo(map); 
}

function toggleFire() { 
    if (!map) return;
    map.hasLayer(window.fireLayer) ? map.removeLayer(window.fireLayer) : window.fireLayer.addTo(map); 
}

function toggleHospital() { 
    if (!map) return;
    map.hasLayer(window.hospitalLayer) ? map.removeLayer(window.hospitalLayer) : window.hospitalLayer.addTo(map); 
}

function showAllLayers() {
    if (!map) return;
    const allVisible = map.hasLayer(window.policeLayer) && map.hasLayer(window.fireLayer) && map.hasLayer(window.hospitalLayer);
    if (allVisible) {
        [window.policeLayer, window.fireLayer, window.hospitalLayer].forEach(l => map.removeLayer(l));
    } else {
        [window.policeLayer, window.fireLayer, window.hospitalLayer].forEach(l => l.addTo(map));
    }
}

// 7. SUPABASE DYNAMIC LOGIC (Incidents & GPS)
async function loadReports() {
    if (!map) {
        console.warn('Map not initialized yet');
        return;
    }
    
    try {
        console.log('Loading reports from Supabase...');
        const { data, error } = await window.supabaseClient
            .from('incidents')
            .select('*')
            // This query fetches anything that isn't 'resolved'
            .not('status', 'eq', 'resolved'); 

        if (error) {
            console.error('Error loading reports:', error);
            return;
        }
        
        if (!data) {
            console.warn('No data returned from incidents table');
            return;
        }
        
        console.log('Reports loaded:', data.length, 'incidents');
        window.incidentLayer.clearLayers(); 
        data.forEach(report => addIncidentMarker(report));
    } catch (err) {
        console.error('Exception in loadReports:', err);
    }
}

function addIncidentMarker(report) {
    if (!map) return;
    
    const id = report.id;
    if (!id) return;
    if (report.status === 'resolved') return;

    const lat = report.latitude || report.lat;
    const lng = report.longitude || report.long || report.longtitude;
    if (!lat || !lng) return;

    const marker = L.marker([lat, lng], { icon: window.redIcon });
    marker.incidentId = String(id);
    marker.addTo(window.incidentLayer);

    const popupContent = `
        <div style="text-align: center; max-width: 220px;">
            <b> ${(report.category || 'emergency').toUpperCase()}</b>
            <hr>
            <p>${report.description || 'No description'}</p>

            ${report.image_url ? `
                <img src="${report.image_url}"
                     style="width:100%; border-radius:6px;"
                     onerror="this.style.display='none'"/>
            ` : ''}

            <button onclick="markAsResolved('${id}')"
                style="margin-top:8px;width:100%;background:#28a745;color:white;border:none;padding:6px;border-radius:4px;">
                Mark as Done
            </button>
        </div>
    `;

    marker.bindPopup(popupContent, {
        maxWidth: 250,
        autoPan: true,
        autoPanPaddingTopLeft: [0, 140],
        autoPanPaddingBottomRight: [0, 40]
    });

    // ✅ THIS fixes your "cut popup"
    marker.on('popupopen', function () {

    // ✅ Step 1: Fix zoom if too far
    if (map.getZoom() < 14) {
        map.setView(marker.getLatLng(), 14, { animate: true });
    }

    // ✅ Step 2: Pan AFTER zoom
    setTimeout(() => {
        const px = map.project(marker.getLatLng());
        px.y -= 160;
        map.panTo(map.unproject(px), { animate: true });
    }, 300);

});
}
async function markAsResolved(incidentId) {
    const { data, error } = await supabaseClient
        .from('incidents')
        .update({ status: 'resolved' }) 
        .eq('id', incidentId)
        .select(); 

    if (error) {
        console.error("Database Error:", error.message);
        alert("Failed to update database: " + error.message);
    } else if (data.length === 0) {
        console.warn("No rows updated. Does the ID exist?");
        alert("Warning: No record was updated. Check the ID.");
    } else {
        console.log("Database updated successfully:", data);
    }
}

// 8. REAL-TIME SUBSCRIPTION (CLEANED & CONSOLIDATED)
supabaseClient
  .channel('map-updates')

  // ---------------- NEW INCIDENTS ----------------
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'incidents' },
    (payload) => {
      console.log("New incident received:", payload.new);

      addIncidentMarker(payload.new);

      // alert sound
      new Audio('https://www.soundjay.com/buttons/beep-01a.mp3')
        .play()
        .catch(() => console.log("Audio blocked"));

      // focus map
      const lat = payload.new.latitude || payload.new.lat;
      const lng = payload.new.longitude || payload.new.long;

      if (lat && lng) {
        map.flyTo([lat, lng], 15);
      }
    }
  )

  // ---------------- STATUS UPDATES ----------------
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'incidents' },
    (payload) => {

      console.log("Incident update detected:", payload.new);

      const id = String(payload.new.id);
      const status = (payload.new.status || '').toLowerCase().trim();

      if (status === 'resolved') {
        removeMarkerFromMap(id);
        return;
      }

      if (status === 'active') {
        // prevent duplicate markers
        removeMarkerFromMap(id);
        addIncidentMarker(payload.new);
      }
    }
  )



  .subscribe((status) => {
    console.log("Supabase Connection Status:", status);
  });
// 9. HELPER FUNCTIONS
function removeMarkerFromMap(id) {
  console.log("Removing marker:", id);

  window.incidentLayer.eachLayer((layer) => {
    if (String(layer.incidentId) === String(id)) {
      window.incidentLayer.removeLayer(layer);
      console.log("Marker removed:", id);
    }
  });
}

function handleLocationUpdate(payload) {
    const record = payload.new;
    if (!record.latitude || !record.longitude) return;
    
    const id = record.vehicle_id || record.device_id;
    let markerData = trackingMarkers.get(id);

    if (markerData) {
        animateMarkerMovement(markerData.marker, markerData.lat, markerData.lng, record.latitude, record.longitude);
        markerData.lat = record.latitude;
        markerData.lng = record.longitude;
    } else {
        const marker = L.marker([record.latitude, record.longitude]).addTo(window.trackingLayer);
        trackingMarkers.set(id, { marker, lat: record.latitude, lng: record.longitude });
    }
}


setInterval(loadReports, 5000); // Reload reports every 5 seconds

// Map initialization will be triggered by auth.js after authentication
console.log('Map.js loaded, waiting for authentication to trigger map initialization...');