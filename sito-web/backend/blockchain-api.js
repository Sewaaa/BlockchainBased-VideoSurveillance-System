/**
 * Blockchain API Communication Module
 * Communicates with the FireFly blockchain API to verify photos
 */

const BASE_URL = 'http://127.0.0.1:5000';
const NAMESPACE = 'default';
const API_NAME = 'secCamv3';
const TIMEOUT = '2m0s';

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
        return data;
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
        const photoHash = '0xbaff2acb328d842af195549ea2d823c9ef07318fc94229e8a5dd46f1e08524e4';
        console.log('Verifying photo hash:', photoHash);

        const result = await verifyPhoto(photoHash);
        console.log('Verification result:', JSON.stringify(result, null, 2));

        // Example 2: Using the generic query function
        // const genericResult = await queryBlockchain('verifyPhoto', {
        //   _photoHash: photoHash
        // });
        // console.log('Generic query result:', JSON.stringify(genericResult, null, 2));

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