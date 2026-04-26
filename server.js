const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let adminClient = null;
let isAdminBusy = false;

wss.on('connection', (ws) => {
    console.log('New connection established');

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case 'register-admin':
                adminClient = ws;
                isAdminBusy = false;
                console.log('Admin Dashboard registered');
                break;

            case 'offer':
                if (!adminClient) {
                    ws.send(JSON.stringify({ type: 'error', message: 'System Offline' }));
                } else if (isAdminBusy) {
                    ws.send(JSON.stringify({ type: 'busy' })); // Line busy logic
                } else {
                    isAdminBusy = true; // Lock the line
                    adminClient.send(JSON.stringify(data));
                }
                break;

            case 'call-ended':
                isAdminBusy = false;
                console.log('Line is now free');
                break;

            default:
                // Forward candidates and answers to the "other" party
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                });
                break;
        }
    });

    ws.on('close', () => {
        if (ws === adminClient) {
            adminClient = null;
            isAdminBusy = false;
        }
    });
});