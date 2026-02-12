#!/usr/bin/env python3
"""
Firma foto per SecurityCamera V3
Firma LOCALE senza contattare RPC
Supporta formato JSON multi-camera
"""

import json
import sys
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3
import hashlib


def load_credentials(json_file, camera_id=None, address=None):
    """
    Carica private key dal file JSON multi-camera

    Args:
        json_file: Path al file JSON
        camera_id: ID della camera (hash, con o senza 0x)
        address: Address della camera (alternativo a camera_id)

    Returns:
        dict: Credenziali della camera selezionata
    """
    try:
        with open(json_file, 'r') as f:
            cameras = json.load(f)

        if not cameras:
            raise ValueError("File JSON vuoto")

        # Se non specificato, usa la prima camera
        if not camera_id and not address:
            camera_id = list(cameras.keys())[0]
            print(f"⚠️  Nessuna camera specificata, uso la prima: {camera_id[: 16]}...")

        # Cerca per camera_id
        if camera_id:
            # Rimuovi 0x se presente
            camera_id_clean = camera_id.replace('0x', '').lower()

            for key, data in cameras.items():
                if key.replace('0x', '').lower() == camera_id_clean:
                    return {
                        'camera_id':  key,
                        'address':  data['address'],
                        'private_key': '0x' + data['privateKey'] if not data['privateKey'].startswith('0x') else data['privateKey'],
                        'mnemonic': data. get('mnemonic', ''),
                        'created_at':  data.get('createdAt', '')
                    }

            raise ValueError(f"Camera ID {camera_id} non trovato")

        # Cerca per address
        if address:
            for key, data in cameras.items():
                if data['address']. lower() == address.lower():
                    return {
                        'camera_id': key,
                        'address': data['address'],
                        'private_key':  '0x' + data['privateKey'] if not data['privateKey'].startswith('0x') else data['privateKey'],
                        'mnemonic': data.get('mnemonic', ''),
                        'created_at': data.get('createdAt', '')
                    }

            raise ValueError(f"Address {address} non trovato")

    except FileNotFoundError:
        print(f"❌ File {json_file} non trovato")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"❌ Errore nel parsing del file JSON")
        sys.exit(1)

def list_cameras(json_file):
    """Mostra tutte le camere disponibili nel file JSON"""
    try:
        with open(json_file, 'r') as f:
            cameras = json.load(f)

        print("\n📹 CAMERE DISPONIBILI:")
        print("=" * 80)

        for idx, (camera_id, data) in enumerate(cameras.items(), 1):
            print(f"\n{idx}. Camera ID: {camera_id}")
            print(f"   Address:     {data['address']}")
            print(f"   Creata il:  {data. get('createdAt', 'N/A')}")

        print("\n" + "=" * 80)

    except Exception as e:
        print(f"❌ Errore nella lettura delle camere: {e}")

def sign_photo(private_key, photo_hash, location, metadata, nonce):
    """
    Firma i dati della foto localmente (NO RPC)

    Args:
        private_key:  Chiave privata della telecamera
        photo_hash: Hash della foto (bytes32)
        location: Posizione
        metadata: Metadati
        nonce: Nonce corrente della telecamera

    Returns:
        dict: Dati firmati pronti per recordPhotoWithSignature
    """

    # Crea account dalla private key
    account = Account.from_key(private_key)

    # Converti photo_hash in bytes32 se è stringa
    if isinstance(photo_hash, str):
        if not photo_hash.startswith('0x'):
            photo_hash = '0x' + photo_hash

    # Crea il messaggio da firmare (stesso formato del contratto)
    # keccak256(abi.encodePacked(photoHash, location, metadata, nonce))
    message_hash = Web3.solidity_keccak(
        ['bytes32', 'string', 'string', 'uint256'],
        [photo_hash, location, metadata, nonce]
    )

    # Firma il messaggio (aggiunge automaticamente il prefix Ethereum Signed Message)
    message = encode_defunct(hexstr=message_hash. hex())
    signed_message = account.sign_message(message)

    return {
        'photo_hash': photo_hash,
        'location': location,
        'metadata': metadata,
        'nonce': nonce,
        'signature': signed_message.signature. hex(),
        'camera_address': account.address,
        'r': hex(signed_message.r),
        's': hex(signed_message.s),
        'v': signed_message.v
    }

import argparse

def main():
    # ===== PARSING ARGOMENTI =====
    parser = argparse.ArgumentParser(description='Firma foto per SecurityCamera V3')
    parser.add_argument('--photo', '-p', required=True, help='Path file foto (es. a.png)')
    parser.add_argument('--camera-id', '-c', required=True, help='ID della camera (hash con o senza 0x)')
    parser.add_argument('--location', '-l', default='Building A - Entrance', help='Posizione della camera')
    parser.add_argument('--metadata', '-m', default='Motion detected', help='Metadati della foto')
    parser.add_argument('--nonce', '-n', type=int, default=0, help='Nonce corrente della camera')
    parser.add_argument('--credentials', default='./camera_keys.json', help='File JSON con le credenziali')

    args = parser.parse_args()

    # ===== CONFIGURAZIONE =====
    CREDENTIALS_FILE = args.credentials
    CAMERA_ID = args.camera_id
    photo_file = args.photo
    location = args.location
    metadata = args.metadata
    nonce = args.nonce

    print("🔐 SecurityCamera V3 - Firma Foto Locale")
    print("=" * 80)

    # Leggi e calcola hash della foto
    try:
        with open(photo_file, 'rb') as f:
            photo_data = f.read()
            photo_hash = "0x" + hashlib.sha256(photo_data).hexdigest()
        print(f"📸 File foto: {photo_file}")
        print(f"📊 Hash foto: {photo_hash}\n")
    except FileNotFoundError:
        print(f"❌ File foto non trovato: {photo_file}")
        sys.exit(1)

    # Mostra camere disponibili
    list_cameras(CREDENTIALS_FILE)

    # Carica credenziali della camera selezionata
    print(f"\n📂 Caricamento credenziali...")
    credentials = load_credentials(
        CREDENTIALS_FILE,
        camera_id=CAMERA_ID
    )

    print(f"✅ Camera selezionata:")
    print(f"   Camera ID: {credentials['camera_id']}")
    print(f"   Address:   {credentials['address']}")
    print(f"   Creata il: {credentials['created_at']}\n")

    # Firma la foto
    print("✍️  Firma in corso...")
    signed_data = sign_photo(
        private_key=credentials['private_key'],
        photo_hash=photo_hash,
        location=location,
        metadata=metadata,
        nonce=nonce
    )

    print("✅ Firma completata!\n")

    # Mostra risultati
    print("📋 DATI FIRMATI:")
    print("-" * 80)
    print(f"Photo Hash:      {signed_data['photo_hash']}")
    print(f"Location:        {signed_data['location']}")
    print(f"Metadata:        {signed_data['metadata']}")
    print(f"Nonce:           {signed_data['nonce']}")
    print(f"Camera Address:  {signed_data['camera_address']}")
    print(f"\n🔑 FIRMA (signature):")
    print(f"{signed_data['signature']}")
    print(f"\n📊 Componenti firma:")
    print(f"v: {signed_data['v']}")
    print(f"r: {signed_data['r']}")
    print(f"s: {signed_data['s']}")

    # Salva in file per uso successivo
    output_file = "signed_photo.json"
    output_data = {
        **signed_data,
        'camera_id': credentials['camera_id']
    }

    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)
    print(f"\n💾 Firma salvata in: {output_file}")

    # Mostra esempio di chiamata al contratto
    print("\n" + "=" * 80)
    print("📤 ESEMPIO CHIAMATA AL CONTRATTO (Web3.js/ethers.js):")
    print("-" * 80)
    print("await contract.recordPhotoWithSignature(")
    print(f"    '{signed_data['photo_hash']}',")
    print(f"    '{signed_data['location']}',")
    print(f"    '{signed_data['metadata']}',")
    print(f"    '{signed_data['signature']}'")
    print(")")

    print("\n" + "=" * 80)
    print("📤 ESEMPIO CHIAMATA AL CONTRATTO (Python/Web3.py):")
    print("-" * 80)
    print("tx_hash = contract.functions.recordPhotoWithSignature(")
    print(f"    '{signed_data['photo_hash']}',")
    print(f"    '{signed_data['location']}',")
    print(f"    '{signed_data['metadata']}',")
    print(f"    '{signed_data['signature']}'")
    print(").transact({'from': relay_address})")

if __name__ == "__main__":
    main()