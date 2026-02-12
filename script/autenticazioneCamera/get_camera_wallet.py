"""
Script per ottenere il wallet associato a un Camera ID tramite API REST
e salvare/gestire la private key
"""

import json
import os
import requests
from datetime import datetime
from eth_account import Account

# ⚙️ Configurazione
CONFIG = {
    "API_BASE_URL": "http://127.0.0.1:5000",
    "NAMESPACE": "default",
    "API_NAME": "secCamv3",
    "TIMEOUT": 120,  # 2 minuti
    "PRIVATE_KEY_FILE": "./camera_keys.json"
}


def get_camera_info(camera_id:  str) -> dict:
    """
    Ottiene info camera dall'API REST FireFly
    """
    # Costruisci URL
    url = f"{CONFIG['API_BASE_URL']}/api/v1/namespaces/{CONFIG['NAMESPACE']}/apis/{CONFIG['API_NAME']}/query/getCameraInfo"

    # Headers
    headers = {
        "accept": "application/json",
        "Request-Timeout": "2m0s",
        "Content-Type": "application/json"
    }

    # Body
    payload = {
        "input": {
            "_cameraId": camera_id
        }
    }

    print(f"🔍 Recupero info per Camera ID: {camera_id}")
    print(f"📡 API URL: {url}\n")

    try:
        # Esegui POST request
        response = requests.post(
            url,
            headers=headers,
            json=payload,
            timeout=CONFIG["TIMEOUT"]
        )

        # Verifica status code
        response.raise_for_status()

        # Parse risposta
        data = response.json()

        if "output" not in data:
            raise ValueError("Risposta API non valida:  'output' mancante")

        camera_info = data["output"]

        print("✅ Camera Info ricevuta:")
        print(json.dumps(camera_info, indent=2))
        print()

        return camera_info

    except requests.exceptions.Timeout:
        print("❌ Errore: Timeout della richiesta (>2 minuti)")
        raise
    except requests.exceptions.ConnectionError:
        print(f"❌ Errore: Impossibile connettersi a {CONFIG['API_BASE_URL']}")
        print("   Verifica che FireFly sia in esecuzione")
        raise
    except requests.exceptions.HTTPError as e:
        print(f"❌ Errore HTTP: {e. response.status_code}")
        print(f"   Risposta: {e.response.text}")
        raise
    except Exception as error:
        print(f"❌ Errore:  {str(error)}")
        raise


def generate_camera_wallet() -> dict:
    """
    Genera un nuovo wallet per la camera
    ⚠️ IMPORTANTE: La private key NON è nel contratto!
    Deve essere generata OFF-CHAIN e conservata in sicurezza
    """
    # Abilita funzionalità non deterministiche
    Account.enable_unaudited_hdwallet_features()

    # Genera account casuale
    account, mnemonic = Account.create_with_mnemonic()

    return {
        "address": account.address,
        "privateKey": account.key.hex(),
        "mnemonic": mnemonic
    }


def save_private_key(camera_id: str, wallet_data: dict):
    """
    Salva private key in file sicuro
    ⚠️ ATTENZIONE:  Proteggi questo file!  Non committarlo su Git!
    """
    keys = {}

    # Leggi file esistente se presente
    if os.path.exists(CONFIG["PRIVATE_KEY_FILE"]):
        with open(CONFIG["PRIVATE_KEY_FILE"], 'r') as f:
            keys = json.load(f)

    # Aggiungi nuova chiave
    keys[camera_id] = {
        "address": wallet_data["address"],
        "privateKey": wallet_data["privateKey"],
        "mnemonic": wallet_data. get("mnemonic", ""),
        "createdAt": datetime.now().isoformat()
    }

    # Salva con permessi restrittivi
    with open(CONFIG["PRIVATE_KEY_FILE"], 'w') as f:
        json.dump(keys, f, indent=2)

    # Imposta permessi file (solo owner può leggere/scrivere)
    try:
        os.chmod(CONFIG["PRIVATE_KEY_FILE"], 0o600)
    except:
        pass  # Potrebbe fallire su Windows

    print(f"✅ Private key salvata in: {CONFIG['PRIVATE_KEY_FILE']}")
    print("⚠️ IMPORTANTE:  Proteggi questo file e NON committarlo su Git!\n")


def load_private_key(camera_id: str) -> dict:
    """
    Carica private key dal file
    """
    if not os.path.exists(CONFIG["PRIVATE_KEY_FILE"]):
        raise FileNotFoundError("File private keys non trovato!")

    with open(CONFIG["PRIVATE_KEY_FILE"], 'r') as f:
        keys = json.load(f)

    if camera_id not in keys:
        raise KeyError(f"Private key per Camera ID {camera_id} non trovata!")

    return keys[camera_id]


def get_wallet_from_camera_id(camera_id: str) -> str:
    """
    Ottiene il wallet address associato a un camera ID dall'API
    """
    camera_info = get_camera_info(camera_id)
    return camera_info.get("walletAddress")


def save_wallet_from_api(camera_id: str):
    """
    Recupera il wallet dall'API e richiede la private key all'utente per salvarla
    """
    print("=" * 70)
    print("🔐 RECUPERO WALLET DA API E SALVATAGGIO PRIVATE KEY")
    print("=" * 70 + "\n")

    # Ottieni info dalla blockchain
    camera_info = get_camera_info(camera_id)
    wallet_address = camera_info.get("walletAddress")

    if not wallet_address:
        print("❌ Wallet address non trovato per questo Camera ID")
        return

    print(f"✅ Wallet trovato: {wallet_address}\n")

    # Chiedi la private key all'utente
    print("⚠️ ATTENZIONE: Per firmare foto con questa camera,")
    print("   è necessaria la PRIVATE KEY del wallet.")
    print()
    private_key = input(f"Inserisci la private key di {wallet_address}: ").strip()

    if not private_key:
        print("❌ Private key non inserita.  Operazione annullata.")
        return

    # Valida la private key
    try:
        if not private_key.startswith('0x'):
            private_key = '0x' + private_key

        account = Account.from_key(private_key)

        # Verifica che corrisponda al wallet
        if account.address. lower() != wallet_address.lower():
            print(f"❌ ERRORE: La private key non corrisponde al wallet!")
            print(f"   Private key address: {account.address}")
            print(f"   Wallet atteso: {wallet_address}")
            return

        print(f"✅ Private key valida per {account.address}\n")

        # Salva
        wallet_data = {
            "address": account.address,
            "privateKey": private_key,
            "mnemonic": ""
        }

        save_private_key(camera_id, wallet_data)

        print("✅ Configurazione completata!")
        print(f"   Camera ID: {camera_id}")
        print(f"   Wallet: {wallet_address}")
        print(f"   MAC: {camera_info.get('macAddress')}")
        print(f"   eFuse: {camera_info.get('eFuseId')}")
        print(f"   Autorizzata: {camera_info.get('isAuthorized')}")
        print(f"   Foto caricate: {camera_info.get('photoCount')}")

    except Exception as e:
        print(f"❌ Errore nella validazione della private key: {str(e)}")


def main():
    """
    Main interattivo
    """
    print("🔑 Camera Wallet Manager - FireFly API Edition\n")
    print("Opzioni:")
    print("1. Genera NUOVO wallet (per nuova camera)")
    print("2. Recupera wallet esistente dall'API e salva private key")
    print("3. Mostra info camera dall'API")
    print()

    scelta = input("Scegli opzione (1/2/3): ").strip()

    if scelta == "1":
        # Genera nuovo wallet
        print("\n" + "=" * 70)
        print("📝 GENERAZIONE NUOVO WALLET")
        print("=" * 70 + "\n")

        camera_id = input("Inserisci Camera ID: ").strip()

        wallet_data = generate_camera_wallet()

        print("\n✅ Wallet generato:")
        print(f"  Address: {wallet_data['address']}")
        print(f"  Private Key: {wallet_data['privateKey']}")
        print(f"  Mnemonic: {wallet_data['mnemonic']}\n")

        salva = input("Salvare questo wallet? (s/n): ").strip().lower()
        if salva == 's':
            save_private_key(camera_id, wallet_data)
            print("\n⚠️ IMPORTANTE:")
            print(f"   Registra questo wallet nel contratto con:")
            print(f"   registerAndAuthorizeCamera(... , '{wallet_data['address']}', ... )")

    elif scelta == "2":
        # Recupera da API
        camera_id = input("\nInserisci Camera ID: ").strip()
        save_wallet_from_api(camera_id)

    elif scelta == "3":
        # Solo info
        print("\n" + "=" * 70)
        print("📊 INFO CAMERA")
        print("=" * 70 + "\n")

        camera_id = input("Inserisci Camera ID: ").strip()

        try:
            camera_info = get_camera_info(camera_id)

            print("\n📸 Dettagli Camera:")
            print(f"  Camera ID: {camera_info. get('cameraId')}")
            print(f"  MAC Address: {camera_info.get('macAddress')}")
            print(f"  eFuse ID: {camera_info.get('eFuseId')}")
            print(f"  Wallet:  {camera_info.get('walletAddress')}")
            print(f"  Modello: {camera_info.get('model')}")
            print(f"  Location: {camera_info.get('location')}")
            print(f"  Autorizzata: {camera_info. get('isAuthorized')}")
            print(f"  Registrata il: {camera_info.get('registeredAt')}")
            print(f"  Foto caricate: {camera_info.get('photoCount')}")
        except Exception as e:
            print(f"❌ Errore: {str(e)}")

    else:
        print("❌ Opzione non valida")


if __name__ == "__main__":
    main()