#!/usr/bin/env python3

import subprocess
import json
import os
import sys

def compile_contract(contract_file, output_dir="build"):
    """Compila smart contract usando Docker ethereum/solc"""
    
    print(f"🔨 Compilazione {contract_file}...")
    
    # Crea directory output
    os.makedirs(output_dir, exist_ok=True)
    
    # Comando Docker
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{os.getcwd()}:/sources",
        "ethereum/solc:0.8.19",
        "--optimize",
        "--optimize-runs", "200",
        "--abi",
        "--bin",
        "--bin-runtime",
        "--hashes",
        "--metadata",
        "--combined-json", "abi,bin,metadata",
        "--overwrite",
        "-o", f"/sources/{output_dir}",
        f"/sources/{contract_file}"
    ]
    
    try:
        # Esegui compilazione
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        print("✅ Compilazione riuscita!")
        
        # Leggi e mostra informazioni
        abi_file = os.path.join(output_dir, "SecurityCamera.abi")
        bin_file = os. path.join(output_dir, "SecurityCamera.bin")
        
        if os.path.exists(abi_file) and os.path.exists(bin_file):
            with open(abi_file, 'r') as f:
                abi = json.load(f)
            
            with open(bin_file, 'r') as f:
                bytecode = f.read().strip()
            
            print(f"\n📊 Statistiche:")
            print(f"   Funzioni: {len([x for x in abi if x['type'] == 'function'])}")
            print(f"   Eventi: {len([x for x in abi if x['type'] == 'event'])}")
            print(f"   Bytecode size: {len(bytecode)//2} bytes")
            print(f"\n📁 File generati in: {output_dir}/")
            
            return True
        else:
            print("❌ File di output non trovati")
            return False
            
    except subprocess.CalledProcessError as e:
        print(f"❌ Errore durante la compilazione:")
        print(e.stderr)
        return False

if __name__ == "__main__": 
    contract = sys.argv[1] if len(sys.argv) > 1 else "SecurityCameraV3-SignatureAuth.sol"
    
    if not os.path.exists(contract):
        print(f"❌ Errore: {contract} non trovato!")
        sys.exit(1)
    
    success = compile_contract(contract)
    sys.exit(0 if success else 1)
