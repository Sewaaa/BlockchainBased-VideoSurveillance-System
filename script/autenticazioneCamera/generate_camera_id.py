"""
Script per generare Camera ID da MAC Address e eFuse ID
Replica la logica del contratto:  keccak256(abi.encodePacked(macAddress, eFuseId))
"""

from web3 import Web3
from eth_abi. packed import encode_packed

# ✅ Dati della camera
camera_data = {
    "mac_address": "1C:DB:D4:98:F9:D8",
    "efuse_id": "D8F998D4DB1C"
}


def generate_camera_id(mac_address:  str, efuse_id: str) -> str:
    """
    Genera Camera ID seguendo la logica del contratto
    keccak256(abi.encodePacked(string, string))
    """
    # Codifica i parametri come nel contratto (abi. encodePacked)
    # Per stringhe, encodePacked usa bytes UTF-8 senza padding
    encoded = encode_packed(['string', 'string'], [mac_address, efuse_id])
    
    # Calcola keccak256
    camera_id = Web3.keccak(encoded)
    
    return camera_id.hex()


def main():
    print("📸 Generazione Camera ID\n")
    print("Input:")
    print(f"  MAC Address: {camera_data['mac_address']}")
    print(f"  eFuse ID: {camera_data['efuse_id']}\n")
    
    camera_id = generate_camera_id(
        camera_data['mac_address'],
        camera_data['efuse_id']
    )
    
    print("✅ Camera ID generato:")
    print(f"  {camera_id}\n")
    
    return camera_id


if __name__ == "__main__":
    main()