#!/usr/bin/env python3
"""
Decifra una foto AES-128-CBC a partire dal file .cid generato dal receiver.
Richiede IPFS API locale attiva (127.0.0.1:5001) e pycryptodome installato.
"""

import argparse
import sys
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen, Request

try:
    from Crypto.Cipher import AES
except Exception as exc:  # pragma: no cover - runtime dependency
    print("Errore: pycryptodome non installato. Installa con: pip install pycryptodome")
    raise SystemExit(1) from exc


def parse_cid_file(path: Path) -> dict:
    data = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()
    return data


def ipfs_cat(cid: str) -> bytes:
    arg = quote(f"/ipfs/{cid}", safe="/")
    url = f"http://127.0.0.1:5001/api/v0/cat?arg={arg}"
    req = Request(url, method="POST")
    with urlopen(req, timeout=120) as resp:
        return resp.read()


def pkcs7_unpad(data: bytes) -> bytes:
    if not data:
        raise ValueError("plaintext vuoto")
    pad_len = data[-1]
    if pad_len == 0 or pad_len > 16:
        raise ValueError("padding non valido")
    if data[-pad_len:] != bytes([pad_len]) * pad_len:
        raise ValueError("padding non valido")
    return data[:-pad_len]


def decrypt_aes_cbc(ciphertext: bytes, key: bytes, iv: bytes) -> bytes:
    if len(key) != 16:
        raise ValueError("AES-128 richiede una chiave di 16 byte")
    if len(iv) != 16:
        raise ValueError("IV deve essere di 16 byte")
    cipher = AES.new(key, AES.MODE_CBC, iv)
    plain = cipher.decrypt(ciphertext)
    return pkcs7_unpad(plain)


def main() -> int:
    parser = argparse.ArgumentParser(description="Decifra foto da file .cid")
    parser.add_argument("cid_file", help="Path al file .cid")
    parser.add_argument("--key", default="0123456789ABCDEF", help="Chiave AES (16 byte, default progetto)")
    parser.add_argument("--out", default=None, help="Output JPG (default: <photo_id>.jpg)")
    parser.add_argument("--enc", default=None, help="Path file .enc locale (se non vuoi scaricare da IPFS)")
    args = parser.parse_args()

    cid_path = Path(args.cid_file)
    if not cid_path.exists():
        print(f"File .cid non trovato: {cid_path}")
        return 1

    meta = parse_cid_file(cid_path)
    file_cid = meta.get("cid", "")
    dir_cid = meta.get("dir_cid", "")
    name = meta.get("name", "")
    iv_hex = meta.get("iv", "")

    if not iv_hex:
        print("IV mancante nel file .cid")
        return 1

    try:
        iv = bytes.fromhex(iv_hex)
    except ValueError:
        print("IV non valido (hex)")
        return 1

    if args.enc:
        cipher_bytes = Path(args.enc).read_bytes()
    else:
        if file_cid:
            cipher_bytes = ipfs_cat(file_cid)
        elif dir_cid and name:
            cipher_bytes = ipfs_cat(f"{dir_cid}/{name}")
        else:
            print("CID mancante nel file .cid")
            return 1

    try:
        plain = decrypt_aes_cbc(cipher_bytes, args.key.encode("utf-8"), iv)
    except Exception as exc:
        print(f"Errore decrittazione: {exc}")
        return 1

    photo_id = cid_path.stem
    out_path = Path(args.out) if args.out else Path(f"{photo_id}.jpg")
    out_path.write_bytes(plain)
    print(f"OK: salvato {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
