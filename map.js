const map = L.map('map').setView([10.7202,122.5621],13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© OpenStreetMap'
}).addTo(map);

const policeLayer = L.layerGroup().addTo(map);
const fireLayer = L.layerGroup().addTo(map);
const hospitalLayer = L.layerGroup().addTo(map);

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

const policeIcon = L.icon({
    iconUrl: "images/police.png",
    iconSize: [30,30],
    iconAnchor: [17,35],
    popupAnchor: [0,-35]
});

policeStations.forEach(function(station){
    L.marker([station[1],station[2]], {icon: policeIcon})
    .addTo(policeLayer)
    .bindPopup(station[0]);
});

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
];
const fireIcons = L.icon({
    iconUrl: "images/fire.png",
    iconSize: [30,30],
    iconAnchor: [17,35],
    popupAnchor: [0,-35]
});

fireStations.forEach(function(station){
    L.marker([station[1],station[2]], {icon: fireIcons})
    .addTo(fireLayer)
    .bindPopup(station[0]);
});

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

const hospitalIcon = L.icon({
    iconUrl: "images/hospital.png",
    iconSize: [30,30],
    iconAnchor: [17,35],
    popupAnchor: [0,-35]
});

hospitals.forEach(function(station){
    L.marker([station[1],station[2]], {icon: hospitalIcon})
    .addTo(hospitalLayer)
    .bindPopup(station[0]);
});

// Filter functions
function togglePolice() {
    if (map.hasLayer(policeLayer)) {
        map.removeLayer(policeLayer);
    } else {
        policeLayer.addTo(map);
    }
}

function toggleFire() {
    if (map.hasLayer(fireLayer)) {
        map.removeLayer(fireLayer);
    } else {
        fireLayer.addTo(map);
    }
}s

function toggleHospital() {
    if (map.hasLayer(hospitalLayer)) {
        map.removeLayer(hospitalLayer);
    } else {
        hospitalLayer.addTo(map);
    }
}

function showAllLayers() {
    const allVisible = map.hasLayer(policeLayer) && map.hasLayer(fireLayer) && map.hasLayer(hospitalLayer);
    
    if (allVisible) {
        // Hide all layers
        map.removeLayer(policeLayer);
        map.removeLayer(fireLayer);
        map.removeLayer(hospitalLayer);
    } else {
        // Show all layers
        if (!map.hasLayer(policeLayer)) policeLayer.addTo(map);
        if (!map.hasLayer(fireLayer)) fireLayer.addTo(map);
        if (!map.hasLayer(hospitalLayer)) hospitalLayer.addTo(map);
    }
}

var marker;

function refreshLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(function(position) {
            var lat = position.coords.latitude;
            var lng = position.coords.longitude;

            map.setView([lat, lng], 16);

            if (marker) {
                map.removeLayer(marker);
            }

            marker = L.marker([lat, lng]).addTo(map)
                .bindPopup("Your Location<br>Lat: " + lat + "<br>Lng: " + lng)
                .openPopup();
        }, function(error) {
            alert("Unable to retrieve location");
        }, {
            enableHighAccuracy: true
        });
    } else {
        alert("Geolocation not supported");
    }
}

