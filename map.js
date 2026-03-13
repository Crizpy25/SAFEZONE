const map = L.map('map').setView([10.7202,122.5621],13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© OpenStreetMap'
}).addTo(map);

const policeStations = [
    ["PS1 City Proper",10.701501994092405, 122.56369039944839],
    ["PS2 La Paz",10.706318562235216, 122.56678639092755],
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
    .addTo(map)
    .bindPopup(station[0]);
});

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

