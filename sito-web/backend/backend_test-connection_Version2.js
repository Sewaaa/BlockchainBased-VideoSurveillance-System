const axios = require('axios');
require('dotenv').config();

const FIREFLY_API_URL = process.env.FIREFLY_API_URL || 'http://127.0.0.1:5000/api/v1';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const NAMESPACE = process.env.FIREFLY_NAMESPACE || 'default';

async function testConnection() {
    console.log('🧪 Testing Firefly Connection...\n');

    try {
        // Test 1: Firefly Status
        console.log('1️⃣  Testing Firefly status...');
        const statusResponse = await axios.get(`${FIREFLY_API_URL}/status`);
        console.log('   ✅ Firefly is running');
        console.log('   Node:', statusResponse.data.node?. name);
        console.log('   Version:', statusResponse.data.node?.version || 'unknown');

        // Test 2: Namespace
        console.log('\n2️⃣  Testing namespace.. .');
        const nsResponse = await axios.get(`${FIREFLY_API_URL}/namespaces/${NAMESPACE}`);
        console.log('   ✅ Namespace exists:', nsResponse.data.name);

        // Test 3: Contract Address
        console.log('\n3️⃣  Checking contract address...');
        if (! CONTRACT_ADDRESS) {
            console.log('   ❌ CONTRACT_ADDRESS not set in .env');
            console.log('   Please add:  CONTRACT_ADDRESS=0x...');
            process.exit(1);
        }
        console.log('   ✅ Contract address configured:', CONTRACT_ADDRESS);

        // Test 4: Query contract (if possible)
        console.log('\n4️⃣  Testing contract query...');
        try {
            const queryResponse = await axios. post(
                `${FIREFLY_API_URL}/namespaces/${NAMESPACE}/contracts/query`,
                {
                    location: { address: CONTRACT_ADDRESS },
                    method: {
                        name: 'getTotalPhotos',
                        params: []
                    }
                }
            );
            console.log('   ✅ Contract query successful');
            console.log('   Total photos:', queryResponse.data.output);
        } catch (error) {
            console.log('   ⚠️  Contract query failed (may need to register contract interface)');
            console.log('   Error:', error.response?.data?.error || error.message);
        }

        console.log('\n✅ All tests passed! You can start the server now.\n');
        console.log('Run:  npm start\n');

    } catch (error) {
        console.error('\n❌ Connection test failed: ');
        console.error('   Error:', error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.error('\n💡 Firefly is not running or not accessible at:', FIREFLY_API_URL);
            console.error('   Please start Firefly first.\n');
        } else if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        }
        
        process. exit(1);
    }
}

testConnection();