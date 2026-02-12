const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
const TIMEOUT = '2m0s';
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({extended: true, limit: '50mb'}));
app.use(morgan('dev')); // Logging

// Configuration
const PORT = process.env.PORT || 3000;
const FIREFLY_API_URL = process.env.FIREFLY_API_URL || 'http://127.0.0.1:5000/api/v1';
const FIREFLY_NAMESPACE = process.env.FIREFLY_NAMESPACE || 'default';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORGANIZATION_NAME = process.env.ORGANIZATION_NAME || 'org_1';

// Validate configuration
if (!CONTRACT_ADDRESS) {
    console.error('❌ ERROR: CONTRACT_ADDRESS not set in .env file');
    process.exit(1);
}

console.log('📋 Configuration: ');
console.log('  - Firefly API:', FIREFLY_API_URL);
console.log('  - Namespace:', FIREFLY_NAMESPACE);
console.log('  - Contract:', CONTRACT_ADDRESS);
console.log('  - Organization:', ORGANIZATION_NAME);

// Firefly API helper
class FireflyClient {
    constructor() {
        this.baseURL = `${FIREFLY_API_URL}/namespaces/${FIREFLY_NAMESPACE}`;
        this.contractLocation = {address: CONTRACT_ADDRESS};
    }

    async invokeContract(methodName, params, idempotencyKey) {
        try {
            const payload = {
                input: params
            };

            console.log('🔥 Invoking Firefly contract:', methodName);
            console.log('   Payload:', JSON.stringify(payload, null, 2));

            const response = await axios.post(
                `${this.baseURL}/contracts/invoke`,
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000 // 30 second timeout
                }
            );

            console.log('✅ Firefly response:', response.data);
            return response.data;

        } catch (error) {
            console.error('❌ Firefly contract invoke error:', error.message);
            if (error.response) {
                console.error('   Response data:', error.response.data);
                console.error('   Status:', error.response.status);
            }
            throw error;
        }
    }

    async queryContract(methodName, params) {
        try {
            const url = `${FIREFLY_API_URL}/namespaces/${FIREFLY_NAMESPACE}/apis/secCamv3/query/${methodName}`;

            const requestBody = {
                input: params
            };

            console.log('🔍 Querying Firefly contract:', methodName);
            console.log('   url:', JSON.stringify(url, null, 2));
            console.log('   req body:', JSON.stringify(requestBody, null, 2));

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'Request-Timeout': TIMEOUT,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }

            const data = await response.json();
            return data;

        } catch (error) {
            console.error('❌ Firefly contract query error:', error.message);
            throw error;
        }
    }

    async checkStatus() {
        try {
            const response = await axios.get(`${FIREFLY_API_URL}/status`, {
                timeout: 5000
            });
            return response.data;
        } catch (error) {
            console.error('❌ Firefly status check failed:', error.message);
            throw error;
        }
    }

    generateIdempotencyKey() {
        return `photo-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    }
}

const fireflyClient = new FireflyClient();

// ============= ROUTES =============

// Health check
app.get('/health', async (req, res) => {
    try {
        const fireflyStatus = await fireflyClient.checkStatus();

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            firefly: {
                connected: true,
                node: fireflyStatus.node?.name || 'unknown'
            },
            contract: {
                address: CONTRACT_ADDRESS,
                namespace: FIREFLY_NAMESPACE
            }
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            message: 'Firefly connection failed',
            error: error.message
        });
    }
});

// ESP32-CAM photo upload endpoint
app.post('/upload-photo', async (req, res) => {
    try {
        const {photoHash, cameraAddress, location, metadata, timestamp} = req.body;

        console.log('\n📸 Photo upload request received:');
        console.log('  - Hash:', photoHash);
        console.log('  - Camera:', cameraAddress);
        console.log('  - Location:', location);
        console.log('  - Metadata:', metadata);

        // Validate inputs
        if (!photoHash) {
            return res.status(400).json({
                success: false,
                error: 'photoHash is required'
            });
        }

        if (!photoHash.startsWith('0x') || photoHash.length !== 66) {
            return res.status(400).json({
                success: false,
                error: 'Invalid photoHash format (must be 0x + 64 hex chars)'
            });
        }

        // Invoke contract via Firefly
        const idempotencyKey = `esp32-${timestamp || Date.now()}`;

        const result = await fireflyClient.invokeContract(
            'recordPhoto',
            {
                _photoHash: photoHash,
                _location: location || 'ESP32-CAM',
                _metadata: metadata || `Uploaded at ${new Date().toISOString()}`
            },
            idempotencyKey
        );

        res.json({
            success: true,
            fireflyResponse: result,
            photoHash: photoHash,
            message: 'Photo recorded on blockchain via Firefly'
        });

    } catch (error) {
        console.error('❌ Upload error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data || null
        });
    }
});

// Batch upload endpoint
app.post('/upload-batch', async (req, res) => {
    try {
        const {photoHashes, locations, metadatas} = req.body;

        console.log('\n📦 Batch upload request: ');
        console.log('  - Count:', photoHashes?.length || 0);

        if (!photoHashes || !Array.isArray(photoHashes)) {
            return res.status(400).json({
                success: false,
                error: 'photoHashes array is required'
            });
        }

        if (photoHashes.length > 50) {
            return res.status(400).json({
                success: false,
                error: 'Maximum 50 photos per batch'
            });
        }

        const result = await fireflyClient.invokeContract(
            'recordPhotoBatch',
            {
                _photoHashes: photoHashes,
                _locations: locations || Array(photoHashes.length).fill('Batch upload'),
                _metadatas: metadatas || Array(photoHashes.length).fill('Batch upload')
            }
        );

        res.json({
            success: true,
            fireflyResponse: result,
            count: photoHashes.length
        });

    } catch (error) {
        console.error('❌ Batch upload error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Verify photo endpoint
app.post('/verify-photo', async (req, res) => {
    /**
     * Blockchain API Communication Module
     * Communicates with the FireFly blockchain API to verify photos
     */


    const BASE_URL = 'http://127.0.0.1:5000';
    const NAMESPACE = 'default';
    const API_NAME = 'secCamv3';

    /**
     * Verify a photo hash on the blockchain
     * @param {string} photoHash - The photo hash to verify (with or without 0x prefix)
     * @returns {Promise<Object>} The API response
     */
    async function verifyPhoto(photoHash) {
        // Ensure the hash has 0x prefix
        const formattedHash = photoHash.startsWith('0x') ? photoHash : `0x${photoHash}`;

        const url = `${BASE_URL}/api/v1/namespaces/${NAMESPACE}/apis/${API_NAME}/query/verifyPhoto`;

        const requestBody = {
            input: {
                _photoHash: formattedHash
            }
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'Request-Timeout': TIMEOUT,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }


            const data = await response.json();
            console.log("data:", data);
            res.json({
                data: data
            });


        } catch (error) {
            console.error('Error verifying photo:', error);
            throw error;
        }
    }

    /**
     * Generic function to query any blockchain API endpoint
     * @param {string} queryName - The name of the query endpoint
     * @param {Object} inputParams - The input parameters for the query
     * @param {string} apiName - The API name (default: secCamv2)
     * @returns {Promise<Object>} The API response
     */
    async function queryBlockchain(queryName, inputParams, apiName = API_NAME) {
        const url = `${BASE_URL}/api/v1/namespaces/${NAMESPACE}/apis/${apiName}/query/${queryName}`;

        const requestBody = {
            input: inputParams
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'Request-Timeout': TIMEOUT,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error(`Error querying blockchain (${queryName}):`, error);
            throw error;
        }
    }

// Example usage
    async function main() {
        try {
            // Example 1: Verify a specific photo hash
            const photoHash = req.body.photoHash;
            console.log('Verifying photo hash:', photoHash);

            const result = await verifyPhoto(photoHash);
            console.log('Verification result:', JSON.stringify(result, null, 2));


        } catch (error) {
            console.error('Main execution error:', error);
        }
    }

// Export functions for use in other modules
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            verifyPhoto,
            queryBlockchain
        };
    }

// Run main function if executed directly
    if (require.main === module) {
        main();
    }
});

// Get total photos
app.get('/stats/total', async (req, res) => {
    try {
        const result = await fireflyClient.queryContract('getTotalPhotos', {});

        res.json({
            success: true,
            totalPhotos: result.output
        });

    } catch (error) {
        console.error('❌ Stats error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get camera status
app.get('/camera/:address', async (req, res) => {
    try {
        const {address} = req.params;

        const isAuthorizedResult = await fireflyClient.queryContract(
            'isCameraAuthorized',
            {_cameraAddress: address}
        );

        res.json({
            success: true,
            cameraAddress: address,
            isAuthorized: isAuthorizedResult.output
        });

    } catch (error) {
        console.error('❌ Camera status error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Authorize camera (admin only)
app.post('/camera/authorize', async (req, res) => {
    try {
        const {cameraAddress} = req.body;

        if (!cameraAddress) {
            return res.status(400).json({
                success: false,
                error: 'cameraAddress is required'
            });
        }

        const result = await fireflyClient.invokeContract(
            'authorizeCamera',
            {_cameraAddress: cameraAddress}
        );

        res.json({
            success: true,
            fireflyResponse: result
        });

    } catch (error) {
        console.error('❌ Authorize error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Revoke camera (admin only)
app.post('/camera/revoke', async (req, res) => {
    try {
        const {cameraAddress} = req.body;

        if (!cameraAddress) {
            return res.status(400).json({
                success: false,
                error: 'cameraAddress is required'
            });
        }

        const result = await fireflyClient.invokeContract(
            'revokeCamera',
            {_cameraAddress: cameraAddress}
        );

        res.json({
            success: true,
            fireflyResponse: result
        });

    } catch (error) {
        console.error('❌ Revoke error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /health',
            'POST /upload-photo',
            'POST /upload-batch',
            'POST /verify-photo',
            'GET  /stats/total',
            'GET  /camera/:address',
            'POST /camera/authorize',
            'POST /camera/revoke'
        ]
    });
});

// Error handler
app.use((error, req, res, next) => {
    console.error('💥 Unhandled error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

// Start server
async function startServer() {
    try {
        // Test Firefly connection
        console.log('\n🔥 Testing Firefly connection...');
        const status = await fireflyClient.checkStatus();
        console.log('✅ Firefly connected:', status.node?.name || 'unknown');

        // Start Express server
        app.listen(PORT, () => {
            console.log('\n' + '='.repeat(50));
            console.log('🚀 ESP32-CAM Firefly Relay Server Started');
            console.log('='.repeat(50));
            console.log(`📡 Server running on:  http://localhost:${PORT}`);
            console.log(`🔥 Firefly API: ${FIREFLY_API_URL}`);
            console.log(`📝 Contract:  ${CONTRACT_ADDRESS}`);
            console.log(`📂 Namespace: ${FIREFLY_NAMESPACE}`);
            console.log('='.repeat(50) + '\n');
            console.log('Ready to receive photos from ESP32-CAM!  📸\n');
        });

    } catch (error) {
        console.error('\n❌ Failed to start server: ');
        console.error('   Error:', error.message);
        console.error('\n💡 Please check: ');
        console.error('   1. Firefly is running (default:  http://127.0.0.1:5000)');
        console.error('   2. . env file is configured correctly');
        console.error('   3. CONTRACT_ADDRESS is set\n');
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n👋 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n👋 SIGINT received, shutting down gracefully...');
    process.exit(0);
});

// Start the server
startServer();