// =============================================
// Global State
// =============================================
let isConnected = false;
let isDbConnected = false;
let simulationInterval;
let socket;
let map, droneMarker, dronePath;

// =============================================
// DOM Element References
// =============================================
const connectBtn        = document.getElementById('connectBtn');
const connectionStatus  = document.getElementById('connectionStatus');
const logContainer      = document.getElementById('logContainer');
const cameraFeed        = document.getElementById('cameraFeed');
const centerControl     = document.getElementById('centerControl');   // FIX: was missing
const executeMissionBtn = document.getElementById('executeMissionBtn');
const takeoffBtn        = document.getElementById('takeoffBtn');
const landBtn           = document.getElementById('landBtn');

// Telemetry elements
const altitudeElement    = document.getElementById('altitude');
const speedElement       = document.getElementById('speed');
const batteryElement     = document.getElementById('battery');
const signalElement      = document.getElementById('signal');
const coordinatesElement = document.getElementById('coordinates');

// =============================================
// Map Initialisation  (runs after Leaflet loads)
// =============================================
function initMap() {
    map = L.map('map').setView([51.505, -0.09], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    droneMarker = L.marker([51.505, -0.09]).addTo(map);
    dronePath   = L.polyline([], { color: 'red' }).addTo(map);
}

// Dynamically load Leaflet then initialise the map
function loadMapLibrary() {
    const link       = document.createElement('link');
    link.rel         = 'stylesheet';
    link.href        = 'https://unpkg.com/leaflet@1.7.1/dist/leaflet.css';
    link.integrity   = 'sha512-xodZBNTC5n17Xt2atTPuE1HxjVMSvLVW9ocqUKLsCC5CXdbqCmblAshOMAS6/keqq/sMZMZ19scR4PsZChSR7A==';
    link.crossOrigin = '';
    document.head.appendChild(link);

    const script       = document.createElement('script');
    script.src         = 'https://unpkg.com/leaflet@1.7.1/dist/leaflet.js';
    script.integrity   = 'sha512-XQoYMqMTK8LvdxXYG3nZ448hOEQiglfqkJs1NOQV44cWnUrBc8PkAOcXy20w0vlaXaVUearIOBhiXZ5V3ynxwA==';
    script.crossOrigin = '';
    // FIX: init map only after the script has actually loaded
    script.onload      = initMap;
    document.head.appendChild(script);
}

// =============================================
// WebSocket — Connection Handler
// =============================================
connectBtn.addEventListener('click', () => {
    if (!isConnected) {
        socket = new WebSocket(`ws://${window.location.hostname}:5000/ws`);

        socket.onopen = () => {
            isConnected = true;
            addLogEntry('[System] WebSocket connection established');
            socket.send(JSON.stringify({ type: 'init', request: 'telemetry_and_status' }));
        };

        socket.onerror = (error) => {
            addLogEntry(`[Error] WebSocket error: ${error.message}`);
        };

        // FIX: moved onmessage inside connect block so `socket` is always defined
        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'db_status') {
                isDbConnected = data.connected;
                localStorage.setItem('dbConnected', isDbConnected);
                const dbStatus = document.getElementById('dbStatus');
                dbStatus.children[0].classList.toggle('disconnected', !isDbConnected);
                dbStatus.children[0].classList.toggle('connected',    isDbConnected);
                dbStatus.children[1].textContent = `DB: ${isDbConnected ? 'Connected' : 'Disconnected'}`;

            } else if (data.type === 'telemetry') {
                socket.send(JSON.stringify({ type: 'store_telemetry', data }));
                altitudeElement.textContent    = `${data.altitude.toFixed(1)} m`;
                speedElement.textContent       = `${data.speed.toFixed(1)} km/h`;
                batteryElement.textContent     = `${data.battery}%`;
                signalElement.textContent      = `${data.signal}%`;
                coordinatesElement.textContent = `${data.latitude.toFixed(6)}, ${data.longitude.toFixed(6)}`;

                const newPos = [data.latitude, data.longitude];
                droneMarker.setLatLng(newPos);
                const currentPath = dronePath.getLatLngs();
                currentPath.push(newPos);
                dronePath.setLatLngs(currentPath);
                if (Math.random() < 0.1) map.setView(newPos);

            } else if (data.type === 'log') {
                addLogEntry(data.message);

            } else if (data.type === 'flight_history') {
                if (data.error) {
                    addLogEntry(`[Error] Loading history: ${data.error}`);
                    return;
                }
                const historyContainer = document.getElementById('flightHistory');
                historyContainer.innerHTML = '';
                if (data.flights.length === 0) {
                    historyContainer.innerHTML = '<div class="text-gray-500">No flight history found</div>';
                    return;
                }
                data.flights.forEach(flight => {
                    const flightEl       = document.createElement('div');
                    flightEl.className   = 'flex justify-between items-center py-1 border-b border-gray-100';
                    flightEl.innerHTML   = `
                        <span>${new Date(flight.timestamp).toLocaleString()}</span>
                        <span class="text-sm ${flight.success ? 'text-green-600' : 'text-red-600'}">
                            ${flight.duration}s
                        </span>`;
                    historyContainer.appendChild(flightEl);
                });
            }
        };

        connectBtn.textContent = 'Disconnect';
        connectionStatus.children[0].classList.remove('disconnected');
        connectionStatus.children[0].classList.add('connected');
        connectionStatus.children[1].textContent = 'Connected - Raspberry Pi';

        addLogEntry('[System] Connected to drone controller');
        addLogEntry('[System] GPS signal acquired');
        addLogEntry('[System] IMU initialized');
        startTelemetrySimulation();

    } else {
        // Disconnect
        if (socket) socket.close();
        isConnected = false;
        connectBtn.textContent = 'Connect';
        connectionStatus.children[0].classList.remove('connected');
        connectionStatus.children[0].classList.add('disconnected');
        connectionStatus.children[1].textContent = 'Disconnected';
        clearInterval(simulationInterval);
        addLogEntry('[System] Drone controller disconnected');
        resetTelemetryDisplay();
    }
});

// =============================================
// Flight Control Buttons
// =============================================
document.querySelectorAll('.control-btn').forEach(btn => {
    btn.addEventListener('mousedown', () => {
        if (!isConnected || !socket) {
            addLogEntry('[Warning] Please connect to drone first');
            return;
        }
        const command = btn.id.replace('Btn', '').toLowerCase();
        socket.send(JSON.stringify({ type: 'control', command, action: 'start' }));
        addLogEntry(`[Command] ${command} pressed`);
    });

    btn.addEventListener('mouseup', () => {
        if (!isConnected) return;
        addLogEntry('[Command] Control released');
    });
});

centerControl.addEventListener('click', () => {
    if (!isConnected) return;
    addLogEntry('[Command] HOLD position activated');
});

takeoffBtn.addEventListener('click', () => {
    if (!isConnected) return;
    addLogEntry('[Command] Takeoff sequence initiated');
    simulateTakeoff();
});

landBtn.addEventListener('click', () => {
    if (!isConnected) return;
    addLogEntry('[Command] Landing sequence initiated');
    simulateLanding();
});

executeMissionBtn.addEventListener('click', () => {
    if (!isConnected || !socket) return;
    const autoLand    = document.getElementById('autoLandToggle').checked;
    const autoTakeoff = document.getElementById('autoTakeoffToggle').checked;

    if (autoLand || autoTakeoff) {
        socket.send(JSON.stringify({ type: 'mission', autoTakeoff, autoLand }));
        addLogEntry('[Mission] Autonomous flight sequence started');
        simulateAutonomousMission();
    } else {
        addLogEntry('[Warning] No autonomous mode selected');
    }
});

document.getElementById('loadHistoryBtn').addEventListener('click', () => {
    if (!isDbConnected) {
        addLogEntry('[Error] Database not connected');
        return;
    }
    socket.send(JSON.stringify({
        type: 'get_history',
        limit: 10,
        sort: 'desc',
        filters: { min_duration: 5, max_altitude: 100 }
    }));
});

// =============================================
// Helper Functions
// =============================================
function addLogEntry(message) {
    const logEntry = document.createElement('div');
    const timestamp = new Date().toISOString().substr(11, 8);

    if      (message.includes('[System]'))                              logEntry.className = 'text-blue-600';
    else if (message.includes('[Command]'))                             logEntry.className = 'text-green-600';
    else if (message.includes('[Warning]') || message.includes('[Error]')) logEntry.className = 'text-yellow-600';
    else                                                                logEntry.className = 'text-gray-500';

    logEntry.textContent = `[${timestamp}] ${message}`;
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function resetTelemetryDisplay() {
    altitudeElement.textContent    = '0 m';
    speedElement.textContent       = '0 km/h';
    batteryElement.textContent     = '0%';
    signalElement.textContent      = '0%';
    coordinatesElement.textContent = '0.000000, 0.000000';
    if (map) {
        map.setView([51.505, -0.09], 13);
        droneMarker.setLatLng([51.505, -0.09]);
        dronePath.setLatLngs([[51.505, -0.09]]);
    }
}

// =============================================
// Simulation Functions
// =============================================
function startTelemetrySimulation() {
    let speed    = 0;
    let battery  = 100;
    let latitude  = 51.505;
    let longitude = -0.09;

    // FIX: the original code was missing the setInterval() wrapper — added here
    simulationInterval = setInterval(() => {
        speed    = Math.max(0, speed + (Math.random() - 0.4));
        battery  = Math.max(10, battery - (Math.random() * 0.02));
        latitude  += (Math.random() - 0.5) * 0.0005;
        longitude += (Math.random() - 0.5) * 0.0005;

        altitudeElement.textContent    = `${(Math.random() * 50).toFixed(1)} m`;
        speedElement.textContent       = `${speed.toFixed(1)} km/h`;
        batteryElement.textContent     = `${Math.floor(battery)}%`;
        signalElement.textContent      = `${90 + Math.floor(Math.random() * 10)}%`;
        coordinatesElement.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

        if (map) {
            const newPos = [latitude, longitude];
            droneMarker.setLatLng(newPos);
            const currentPath = dronePath.getLatLngs();
            currentPath.push(newPos);
            dronePath.setLatLngs(currentPath);
            if (Math.random() < 0.05) map.setView(newPos);
        }
    }, 300);
}

function simulateTakeoff() {
    let currentAltitude = 0;
    const takeoffInterval = setInterval(() => {
        if (currentAltitude >= 100) {
            clearInterval(takeoffInterval);
            addLogEntry('[Status] Takeoff complete at 100m');
            return;
        }
        currentAltitude += 2;
        altitudeElement.textContent = `${currentAltitude.toFixed(1)} m`;
    }, 100);
}

function simulateLanding() {
    let currentAltitude = parseFloat(altitudeElement.textContent);
    const landingInterval = setInterval(() => {
        if (currentAltitude <= 0.5) {
            clearInterval(landingInterval);
            altitudeElement.textContent = '0.0 m';
            addLogEntry('[Status] Landing complete');
            return;
        }
        currentAltitude -= 2;
        altitudeElement.textContent = `${currentAltitude.toFixed(1)} m`;
    }, 100);
}

function simulateAutonomousMission() {
    if (document.getElementById('autoTakeoffToggle').checked) {
        setTimeout(() => {
            simulateTakeoff();
            addLogEntry('[Autonomous] Takeoff sequence completed');
        }, 1000);
    }
    if (document.getElementById('autoLandToggle').checked) {
        setTimeout(() => {
            simulateLanding();
            addLogEntry('[Autonomous] Landing sequence completed');
        }, 5000);
    }
}

// =============================================
// Startup
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    loadMapLibrary();   // loads Leaflet → triggers initMap() on script.onload

    // Restore DB status from localStorage
    const storedDbStatus = localStorage.getItem('dbConnected');
    if (storedDbStatus === 'true') {
        const dbStatus = document.getElementById('dbStatus');
        dbStatus.children[0].classList.add('connected');
        dbStatus.children[0].classList.remove('disconnected');
        dbStatus.children[1].textContent = 'DB: Connected';
        isDbConnected = true;
    }
    if (!isConnected) {
        addLogEntry('[System] Ready to connect to drone controller');
        addLogEntry('[System] Ensure Arduino/Raspberry Pi is powered on');
    }
});
