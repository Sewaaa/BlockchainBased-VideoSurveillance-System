// Firefly Configuration
const FIREFLY_CONFIG = {
    // Backend Relay Server
    RELAY_SERVER_URL: 'http://localhost:3000',

    // Firefly Core API endpoint
    FIREFLY_API_URL: 'http://localhost:5000/api/v1',

    // Firefly namespace
    NAMESPACE: 'default',

    // Contract details - YOUR ACTUAL CONTRACT ADDRESS
    CONTRACT_ADDRESS:  '0xef1de46764e7f47331d01ac7a960ad04afe0d76b',

    // Organization
    ORGANIZATION: 'org_1',

    // Settings
    MAX_BATCH_SIZE: 50,
    AUTO_REFRESH_INTERVAL: 30000,

    // Features
    FEATURES: {
        AUTO_REFRESH: false,
        REAL_TIME_EVENTS: false,
        IPFS_STORAGE: false
    }
};

// Helper function
function getRelayURL(endpoint) {
    return `${FIREFLY_CONFIG.RELAY_SERVER_URL}${endpoint}`;
}

// Debug logging
console.log('🔧 Firefly Config Loaded: ');
console.log('  Relay Server:', FIREFLY_CONFIG.RELAY_SERVER_URL);
console.log('  Contract:', FIREFLY_CONFIG.CONTRACT_ADDRESS);
console.log('  Namespace:', FIREFLY_CONFIG. NAMESPACE);