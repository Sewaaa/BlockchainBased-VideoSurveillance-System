# BlockchainBased-VideoSurveillance-System

University project: **IoT Security & Data Security Project**

Developed by:
- Samuele Sparno
- Lorenzo Di Palo

## Abstract

This project implements a blockchain-based IoT surveillance pipeline for photo evidence.
An ESP32-CAM captures encrypted images after motion detection, a Go gateway processes and hashes the data, and FireFly + smart contract provide on-chain notarization and verification.
The objective is to improve authenticity, integrity, and auditability of surveillance events.

## Project Idea and Motivation

Traditional camera systems rely on centralized trust: backend, storage, and logs can be altered.
The idea of this project is to bind each photo event to cryptographic proof and on-chain traceability, reducing dependence on a single trusted server.

## Objectives

- Authenticate camera-originated events using wallet signatures.
- Guarantee image integrity through SHA-256 digest verification.
- Prevent duplicate/invalid records on-chain.
- Provide replay resistance with nonce-based signing.
- Enable third-party verification of notarized photo hashes.

## System Architecture

Main components:
- `arduino/` - PIR sensor trigger (`MOTION` over serial)
- `esp/` - ESP32-CAM firmware (capture + AES + MQTT publish)
- `mqtt-go/` - Go receiver (gateway logic, IPFS upload, FireFly interaction)
- `script/` - Solidity contract and camera onboarding/auth tools
- `sito-web/` - verification dashboard (frontend + backend relay)

Technologies:
- MQTT for device-to-gateway messaging
- AES encryption on edge payload
- IPFS for encrypted payload storage
- FireFly API for blockchain interaction
- Solidity smart contract for authorization and notarization rules

## End-to-End Workflow

1. PIR detects motion and notifies Go receiver through serial.
2. Go receiver publishes capture command on MQTT.
3. ESP32-CAM captures and encrypts photo, then publishes encrypted payload on MQTT.
4. Go receiver:
   - validates camera identity and authorization context
   - uploads encrypted payload to IPFS
   - decrypts locally, computes SHA-256, stores local evidence files
   - checks if hash is already registered on-chain
   - if hash is new, signs `(hash + location + metadata + nonce)` and submits record through FireFly

## Security Design

### Camera Authentication
- Camera registration/authorization is controlled on-chain.
- Signed records are validated with `ecrecover`.
- Recovered signer must map to a registered and authorized camera.

### Integrity and Notarization
- SHA-256 digest of decrypted image is used as integrity proof.
- Smart contract blocks duplicate digest registration (`photoExists` check).
- Verification can be repeated later by recomputing the hash from a file.

### Replay Protection
- Nonce is managed on-chain per relay (`nonces[msg.sender]` model).
- Signed payload includes nonce.
- Used nonces are rejected by contract state progression.

### Storage Integrity
- Encrypted blobs are stored on IPFS (content-addressed).
- In Go/MQTT flow, CID is included in signed metadata.
- Content tampering changes CID and breaks consistency checks.

## Camera Onboarding Model

Before a camera can produce valid on-chain records:

1. Create/prepare camera wallet off-chain.
2. Register and authorize camera in the smart contract (owner/admin action).
3. Store matching private key in local key store:
   - `script/autenticazioneCamera/camera_keys.json`

Utility scripts:
- `script/autenticazioneCamera/generate_camera_id.py`
- `script/autenticazioneCamera/get_camera_wallet.py`
- `script/autenticazioneCamera/register-camera.sh`
- `script/autenticazioneCamera/sign_photo.py`

## Current Implementation Notes

- Go receiver currently requires pre-provisioned camera keys.
- Automatic wallet creation on missing key has been removed.
- If camera key is missing, processing stops before signing.
- If hash already exists on-chain, on-chain write is skipped; local files already created remain.

## Setup and Run

Prerequisites:
- MQTT broker
- Go toolchain
- Node.js (for backend relay)
- IPFS daemon (`127.0.0.1:5001`)
- FireFly API (`127.0.0.1:5000`)
- Arduino/ESP32 toolchain

Run sequence:

1. Start MQTT broker.
2. Start IPFS daemon.
3. Start FireFly and deploy/configure contract API.
4. Flash Arduino and ESP32-CAM firmware.
5. Start Go receiver:

```bash
cd mqtt-go
go run main.go
```

6. Start backend relay:

```bash
cd sito-web/backend
npm install
npm start
```

7. Open frontend:
- `sito-web/frontend/index.html`

## Produced Evidence Artifacts

Per processed event (Go receiver):
- `foto_<id>.cid` - IPFS references and related metadata
- `foto_<id>.sha256` - SHA-256 digest of decrypted image

## Limitations

- AES configuration is educational/prototype-oriented and should be hardened for production.
- Local key management is file-based and should be replaced with hardened secret storage.
- Trust model still depends on secure operation of relay and infrastructure.

## Conclusion

The project demonstrates a practical integration of IoT, cryptography, distributed storage, and blockchain notarization.
It provides a concrete academic prototype for verifiable surveillance evidence with clear security controls against spoofing, duplication, replay, and storage tampering.

