class FireflyIntegration {
    constructor() {
        this.relayUrl = FIREFLY_CONFIG.RELAY_SERVER_URL;
        this.connected = false;
        this.contractAddress = null;
        this.autoRefreshInterval = null;
        this.init();
    }

    async init() {
        console.log('🔥 Initializing Firefly Integration...');
        this.setupEventListeners();
        this.addEventLog('System initialized. Click "Connect to Firefly" to begin.');
    }

    setupEventListeners() {
        // Connection
        document.getElementById('connectWallet').addEventListener('click', () => this.connectFirefly());

        // Photo operations
        document.getElementById('uploadPhoto').addEventListener('click', () => this.uploadPhoto());
        document.getElementById('verifyPhoto').addEventListener('click', () => this.verifyPhoto());
        document.getElementById('batchUpload').addEventListener('click', () => this.batchUpload());

        // Camera management
        document.getElementById('authorizeCamera').addEventListener('click', () => this.authorizeCamera());
        document.getElementById('revokeCamera').addEventListener('click', () => this.revokeCamera());
        document.getElementById('checkCamera').addEventListener('click', () => this.checkCameraStatus());

        // Photo loading
        document.getElementById('loadRecent').addEventListener('click', () => this.loadRecentPhotos());
        document.getElementById('refreshPhotos').addEventListener('click', () => this.loadRecentPhotos());

        // Config copying
        document.getElementById('copyConfig').addEventListener('click', () => this.copyESP32Config());
        document.getElementById('copyArduino').addEventListener('click', () => this.copyArduinoConfig());

        // Event log
        document.getElementById('clearLog').addEventListener('click', () => this.clearEventLog());

        // Photo preview
        document.getElementById('photoInput').addEventListener('change', (e) => this.previewPhoto(e.target.files[0]));
    }

    async connectFirefly() {
        const btn = document.getElementById('connectWallet');
        btn.disabled = true;
        btn.textContent = 'Connecting...';

        try {
            // Test relay server connection
            const response = await fetch(getRelayURL('/health'));

            if (!response.ok) {
                throw new Error(`Relay server returned ${response.status}`);
            }

            const data = await response.json();
            console.log('Health check:', data);

            if (data.status === 'ok') {
                this.connected = true;
                this.contractAddress = data.contract?.address;

                // Update UI
                btn.textContent = '✅ Connected';
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-success');

                document.getElementById('accountAddress').textContent = FIREFLY_CONFIG.ORGANIZATION;
                document.getElementById('accountAddress').classList.remove('hidden');

                document.getElementById('networkStatus').textContent = '🔥 Firefly';
                document.getElementById('networkStatus').classList.add('status-indicator', 'online');

                this.addEventLog(`✅ Connected to Firefly via ${this.relayUrl}`);
                this.addEventLog(`📝 Contract:  ${this.contractAddress || 'Unknown'}`);

                // Update ESP32 config display
                this.updateESP32ConfigDisplay();

                // Load initial data
                await this.updateUI();

                // Start auto-refresh if enabled
                if (FIREFLY_CONFIG.FEATURES.AUTO_REFRESH) {
                    this.startAutoRefresh();
                }

            } else {
                throw new Error('Relay server is not healthy');
            }

        } catch (error) {
            console.error('Connection error:', error);
            btn.textContent = 'Connection Failed';
            btn.classList.add('btn-danger');

            this.addEventLog(`❌ Connection failed: ${error.message}`);
            alert(`Failed to connect to relay server at ${this.relayUrl}\n\nError: ${error.message}\n\nMake sure the backend server is running! `);

            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Retry Connection';
                btn.classList.remove('btn-danger');
                btn.classList.add('btn-primary');
            }, 3000);
        }
    }

    async uploadPhoto() {
        const fileInput = document.getElementById('photoInput');
        const location = document.getElementById('locationInput').value;
        const rawMetadata = document.getElementById('metadataInput').value.trim();
        const metadata = this.truncateText(rawMetadata, 140);
        const statusDiv = document.getElementById('uploadStatus');
        const uploadBtn = document.getElementById('uploadPhoto');

        if (!this.connected) {
            this.showStatus(statusDiv, 'Please connect to Firefly first', 'error');
            return;
        }

        if (!fileInput.files[0]) {
            this.showStatus(statusDiv, 'Please select a photo', 'error');
            return;
        }

        uploadBtn.disabled = true;

        try {
            this.showStatus(statusDiv, 'Computing hash...', 'info');

            // Compute hash
            const hash = await this.computeFileHash(fileInput.files[0]);
            console.log('Photo hash:', hash);

            this.showStatus(statusDiv, 'Uploading to blockchain via Firefly...', 'info');

            // Upload via relay server
            const response = await fetch(getRelayURL('/upload-photo'), {
                method: 'POST', headers: {
                    'Content-Type': 'application/json'
                }, body: JSON.stringify({
                    photoHash: hash,
                    cameraAddress: 'Web Interface',
                    location: location || 'Manual Upload',
                    metadata: metadata || `Uploaded at ${new Date().toISOString()}`
                })
            });

            const result = await response.json();

            if (result.success) {
                this.showStatus(statusDiv, `✅ Photo uploaded successfully!`, 'success');
                this.addEventLog(`📸 Photo uploaded: ${hash.substring(0, 10)}...`);

                // Clear inputs
                fileInput.value = '';
                document.getElementById('locationInput').value = '';
                document.getElementById('metadataInput').value = '';
                document.getElementById('photoPreview').innerHTML = '';

                // Update UI
                await this.updateUI();
            } else {
                throw new Error(result.error || 'Upload failed');
            }

        } catch (error) {
            console.error('Upload error:', error);
            this.showStatus(statusDiv, `❌ Upload failed: ${error.message}`, 'error');
        } finally {
            uploadBtn.disabled = false;
        }
    }

    async batchUpload() {
        const fileInput = document.getElementById('batchInput');
        const statusDiv = document.getElementById('batchStatus');
        const progressBar = document.getElementById('batchProgress');
        const uploadBtn = document.getElementById('batchUpload');

        if (!this.connected) {
            this.showStatus(statusDiv, 'Please connect to Firefly first', 'error');
            return;
        }

        if (!fileInput.files.length) {
            this.showStatus(statusDiv, 'Please select photos', 'error');
            return;
        }

        if (fileInput.files.length > FIREFLY_CONFIG.MAX_BATCH_SIZE) {
            this.showStatus(statusDiv, `Maximum ${FIREFLY_CONFIG.MAX_BATCH_SIZE} photos per batch`, 'error');
            return;
        }

        uploadBtn.disabled = true;

        try {
            progressBar.classList.add('show');
            this.showStatus(statusDiv, 'Processing batch... ', 'info');

            const hashes = [];
            const locations = [];
            const metadatas = [];

            // Compute all hashes
            for (let i = 0; i < fileInput.files.length; i++) {
                const hash = await this.computeFileHash(fileInput.files[i]);
                hashes.push(hash);
                locations.push('Batch Upload');
                metadatas.push(`File ${i + 1} - ${new Date().toISOString()}`);

                const progress = ((i + 1) / fileInput.files.length) * 50;
                progressBar.innerHTML = `<div class="progress-fill" style="width: ${progress}%">${Math.floor(progress)}%</div>`;
            }

            this.showStatus(statusDiv, 'Submitting batch to blockchain...', 'info');

            // Upload batch via relay server
            const response = await fetch(getRelayURL('/upload-batch'), {
                method: 'POST', headers: {
                    'Content-Type': 'application/json'
                }, body: JSON.stringify({
                    photoHashes: hashes, locations: locations, metadatas: metadatas
                })
            });

            const result = await response.json();

            progressBar.innerHTML = '<div class="progress-fill" style="width: 100%">100%</div>';

            if (result.success) {
                this.showStatus(statusDiv, `✅ Batch uploaded! ${hashes.length} photos recorded.`, 'success');
                this.addEventLog(`📦 Batch upload: ${hashes.length} photos`);

                fileInput.value = '';
                await this.updateUI();

                setTimeout(() => {
                    progressBar.classList.remove('show');
                }, 3000);
            } else {
                throw new Error(result.error || 'Batch upload failed');
            }

        } catch (error) {
            console.error('Batch upload error:', error);
            this.showStatus(statusDiv, `❌ Batch upload failed: ${error.message}`, 'error');
            progressBar.classList.remove('show');
        } finally {
            uploadBtn.disabled = false;
        }
    }

    async verifyPhoto() {
        const fileInput = document.getElementById('verifyInput');
        const resultDiv = document.getElementById('verifyResult');
        const verifyBtn = document.getElementById('verifyPhoto');

        if (!this.connected) {
            alert('Please connect to Firefly first');
            return;
        }

        if (!fileInput.files[0]) {
            alert('Please select a photo to verify');
            return;
        }

        verifyBtn.disabled = true;

        try {
            // Compute hash
            const hash = await this.computeFileHash(fileInput.files[0]);
            console.log('Verifying hash:', hash);

            // Verify via relay server
            const response = await fetch(getRelayURL('/verify-photo'), {
                method: 'POST', headers: {
                    'Content-Type': 'application/json'
                }, body: JSON.stringify({photoHash: hash})
            });

            const result = await response.json();

            console.log(result);

            if (result.data.exists === true) {
                const timestamp = parseInt(result.data.timestamp);
                const date = new Date(timestamp * 1000);
                const fullMetadata = result.data.metadata || 'N/A';
                const formattedMetadata = this.escapeHtml(fullMetadata).replace(/;/g, ';<br>');

                resultDiv.innerHTML = `
                    <h3 style="color: green;">✅ Photo Verified on Firefly!</h3>
                    <p><strong>Hash:</strong> <span class="hash">${hash}</span></p>
                    <p><strong>Timestamp:</strong> ${date.toLocaleString()}</p>
                    <p><strong>Camera:</strong> ${this.escapeHtml(result.data.cameraAddress || 'N/A')}</p>
                    <p><strong>Location:</strong> ${this.escapeHtml(result.data.location || 'N/A')}</p>
                    <p><strong>Metadata:</strong> <span class="metadata-value">${formattedMetadata}</span></p>
                `;
                this.addEventLog(`✅ Photo verified: ${hash.substring(0, 10)}...`);
            } else {
                resultDiv.innerHTML = `
                    <h3 style="color:  red;">❌ Photo Not Found</h3>
                    <p>This photo has not been recorded on the blockchain. </p>
                    <p><strong>Hash:</strong> <span class="hash">${hash}</span></p>
                `;
                this.addEventLog(`❌ Photo not found: ${hash.substring(0, 10)}...`);
            }

            resultDiv.classList.add('show');

        } catch (error) {
            console.error('Verify error:', error);
            resultDiv.innerHTML = `<h3>Error</h3><p>${error.message}</p>`;
            resultDiv.classList.add('show');
        } finally {
            verifyBtn.disabled = false;
        }
    }

    async authorizeCamera() {
        const address = document.getElementById('cameraAddress').value.trim();
        const statusDiv = document.getElementById('cameraStatus');

        if (!this.connected) {
            this.showStatus(statusDiv, 'Please connect to Firefly first', 'error');
            return;
        }

        if (!address || !address.startsWith('0x')) {
            this.showStatus(statusDiv, 'Invalid address format', 'error');
            return;
        }

        try {
            const response = await fetch(getRelayURL('/camera/authorize'), {
                method: 'POST', headers: {
                    'Content-Type': 'application/json'
                }, body: JSON.stringify({cameraAddress: address})
            });

            const result = await response.json();

            if (result.success) {
                this.showStatus(statusDiv, `✅ Camera authorized! `, 'success');
                this.addEventLog(`✅ Camera authorized: ${this.formatAddress(address)}`);
            } else {
                throw new Error(result.error || 'Authorization failed');
            }

        } catch (error) {
            console.error('Authorize error:', error);
            this.showStatus(statusDiv, `❌ Failed:  ${error.message}`, 'error');
        }
    }

    async revokeCamera() {
        const address = document.getElementById('cameraAddress').value.trim();
        const statusDiv = document.getElementById('cameraStatus');

        if (!this.connected) {
            this.showStatus(statusDiv, 'Please connect to Firefly first', 'error');
            return;
        }

        if (!address || !address.startsWith('0x')) {
            this.showStatus(statusDiv, 'Invalid address format', 'error');
            return;
        }

        try {
            const response = await fetch(getRelayURL('/camera/revoke'), {
                method: 'POST', headers: {
                    'Content-Type': 'application/json'
                }, body: JSON.stringify({cameraAddress: address})
            });

            const result = await response.json();

            if (result.success) {
                this.showStatus(statusDiv, `✅ Camera revoked!`, 'success');
                this.addEventLog(`❌ Camera revoked: ${this.formatAddress(address)}`);
            } else {
                throw new Error(result.error || 'Revocation failed');
            }

        } catch (error) {
            console.error('Revoke error:', error);
            this.showStatus(statusDiv, `❌ Failed: ${error.message}`, 'error');
        }
    }

    async checkCameraStatus() {
        const address = document.getElementById('cameraAddress').value.trim();
        const statusDiv = document.getElementById('cameraStatus');

        if (!this.connected) {
            this.showStatus(statusDiv, 'Please connect to Firefly first', 'error');
            return;
        }

        if (!address || !address.startsWith('0x')) {
            this.showStatus(statusDiv, 'Invalid address format', 'error');
            return;
        }

        try {
            const response = await fetch(getRelayURL(`/camera/${address}`));
            const result = await response.json();

            if (result.success) {
                const status = result.isAuthorized ? '✅ Authorized' : '❌ Not Authorized';
                this.showStatus(statusDiv, `Status: ${status}`, 'info');
            } else {
                throw new Error(result.error || 'Status check failed');
            }

        } catch (error) {
            console.error('Check status error:', error);
            this.showStatus(statusDiv, `❌ Failed: ${error.message}`, 'error');
        }
    }

    async updateUI() {
        if (!this.connected) return;

        try {
            // Get total photos
            const statsResponse = await fetch(getRelayURL('/stats/total'));
            const statsData = await statsResponse.json();

            if (statsData.success) {
                document.getElementById('totalPhotos').textContent = statsData.totalPhotos || '0';
            }

        } catch (error) {
            console.error('Error updating UI:', error);
        }
    }

    async loadRecentPhotos(limit = 12) {
        if (!this.connected) {
            alert('Please connect to Firefly first');
            return;
        }

        const photoGrid = document.getElementById('photoGrid');
        photoGrid.innerHTML = '<p class="placeholder-text">Loading photos...</p>';

        try {
            // Note: This requires additional backend endpoints
            // For now, show a message
            photoGrid.innerHTML = `
                <p class="placeholder-text">
                    Photo listing feature requires additional backend endpoints. <br>
                    Photos are being recorded on the blockchain successfully! <br>
                    Check the event log for recent uploads.
                </p>
            `;

            this.addEventLog('ℹ️ Photo listing feature coming soon');

        } catch (error) {
            console.error('Error loading photos:', error);
            photoGrid.innerHTML = `<p class="placeholder-text">Error loading photos: ${error.message}</p>`;
        }
    }

    // ============= UTILITY METHODS =============

    async computeFileHash(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function (e) {
                const wordArray = CryptoJS.lib.WordArray.create(e.target.result);
                const hash = CryptoJS.SHA256(wordArray);
                resolve('0x' + hash.toString());
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    previewPhoto(file) {
        if (!file) return;

        const preview = document.getElementById('photoPreview');
        const reader = new FileReader();

        reader.onload = function (e) {
            preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
        };

        reader.readAsDataURL(file);
    }

    updateESP32ConfigDisplay() {
        const configPre = document.getElementById('esp32Config');
        configPre.textContent = `{
  "relayServerUrl": "${this.relayUrl}/upload-photo",
  "contractAddress": "${this.contractAddress || 'Loading... '}",
  "namespace": "${FIREFLY_CONFIG.NAMESPACE}",
  "organization": "${FIREFLY_CONFIG.ORGANIZATION}"
}`;

        const arduinoPre = document.getElementById('arduinoConfig');
        arduinoPre.textContent = `const char* relayServerUrl = "${this.relayUrl}/upload-photo";
const char* cameraAddress = "0xYOUR_CAMERA_WALLET_ADDRESS";
const char* location = "ESP32-CAM-001";`;
    }

    copyESP32Config() {
        const config = document.getElementById('esp32Config').textContent;
        navigator.clipboard.writeText(config);
        this.addEventLog('📋 ESP32 config copied to clipboard');
        alert('Configuration copied to clipboard!');
    }

    copyArduinoConfig() {
        const config = document.getElementById('arduinoConfig').textContent;
        navigator.clipboard.writeText(config);
        this.addEventLog('📋 Arduino config copied to clipboard');
        alert('Arduino configuration copied to clipboard!');
    }

    formatAddress(address) {
        if (!address) return 'N/A';
        if (address.length < 10) return address;
        return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    }

    truncateText(value, maxLength = 120) {
        if (!value) return '';
        if (value.length <= maxLength) return value;
        return `${value.substring(0, maxLength - 3)}...`;
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    showStatus(element, message, type) {
        element.textContent = message;
        element.className = `status-message ${type}`;
    }

    addEventLog(message) {
        const eventLog = document.getElementById('eventLog');
        const eventItem = document.createElement('div');
        eventItem.className = 'event-item';
        eventItem.innerHTML = `
            <div class="event-time">${new Date().toLocaleString()}</div>
            <div class="event-message">${message}</div>
        `;
        eventLog.insertBefore(eventItem, eventLog.firstChild);

        // Keep only last 50 events
        while (eventLog.children.length > 50) {
            eventLog.removeChild(eventLog.lastChild);
        }
    }

    clearEventLog() {
        const eventLog = document.getElementById('eventLog');
        eventLog.innerHTML = `
            <div class="event-item">
                <div class="event-time">${new Date().toLocaleString()}</div>
                <div class="event-message">Event log cleared</div>
            </div>
        `;
    }

    startAutoRefresh() {
        if (this.autoRefreshInterval) return;

        this.autoRefreshInterval = setInterval(() => {
            this.updateUI();
        }, FIREFLY_CONFIG.AUTO_REFRESH_INTERVAL);

        this.addEventLog('🔄 Auto-refresh enabled');
    }

    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
            this.addEventLog('⏸️ Auto-refresh disabled');
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.fireflyIntegration = new FireflyIntegration();
    console.log('🎯 Firefly Integration loaded');
});
