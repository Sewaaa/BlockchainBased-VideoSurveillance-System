package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"mime/multipart"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/tarm/serial"
)

// -------------------------------------------------------
//  Config FireFly (API REST)
// -------------------------------------------------------
const (
	fireflyAPI = "http://127.0.0.1:5000/api/v1"
	namespace  = "default"
	apiName    = "secCamv3"
)

// -------------------------------------------------------
//  Config camera (key store locale + relay)
// -------------------------------------------------------
const (
	cameraKeysFile = "..\\script\\autenticazioneCamera\\camera_keys.json"
	relayAddress   = "0xbaecd1f353293981312b558d663e41299f3baa34"
)

// IPFS local API (daemon)
const ipfsAddURL = "http://127.0.0.1:5001/api/v0/add?recursive=true&wrap-with-directory=true"

// Chiave AES condivisa con ESP32 (16 byte => AES-128).
// Nota: qui è hardcoded, va bene per esempio
var aesKey = []byte("0123456789ABCDEF")

// Chiave locale per cifrare/decifrare la private key salvata in camera_keys.json (AES-256-GCM).
var keyEncKey = []byte("5831b0c486b30acfd1db20e20a970725")

// EncryptedPayload rappresenta il JSON ricevuto via MQTT dall’ESP32-CAM.
// - Cam: ID della camera che ha scattato (es. "cam-esp32-01")
// - Location: posizione della camera (hardcoded lato ESP)
// - IV: vettore iniziale AES in HEX (16 byte = 32 caratteri hex)
// - Cipher: foto cifrata (ciphertext) in Base64 per poterli mettere nel JSON MQTT
type EncryptedPayload struct {
	Cam      string `json:"cam"`
	Location string `json:"location"`
	IV       string `json:"iv"`
	Cipher   string `json:"cipher"`
	Mac      string `json:"mac"`
	Efuse    string `json:"efuse"`
}

type cameraKeyEntry struct {
	Address    string `json:"address"`
	PrivateKey string `json:"privateKey"`
	Mnemonic   string `json:"mnemonic"`
	CreatedAt  string `json:"createdAt"`
}

type cameraInfoResponse struct {
	Output map[string]any `json:"output"`
}

type ipfsAddResponse struct {
	Name string `json:"Name"`
	Hash string `json:"Hash"`
	Size string `json:"Size"`
}

// pkcs7Unpad rimuove il padding PKCS#7 da un buffer plaintext.
// Questa funzione:
// 1) legge l'ultimo byte (padLen)
// 2) controlla che gli ultimi padLen byte valgano padLen
// 3) taglia via il padding e ritorna i dati reali
// Note: AES‑CBC lavora a blocchi da 16 byte, quindi se la foto non è multipla di 16 l’ESP aggiunge padding (PKCS#7) in aesEncryptCBC()
func pkcs7Unpad(b []byte) ([]byte, error) {
	// plaintext vuoto = errore
	if len(b) == 0 {
		return nil, errors.New("empty plaintext")
	}

	// l'ultimo byte indica quanti byte di padding ci sono
	padLen := int(b[len(b)-1])

	// padLen non può essere 0 e non può superare la lunghezza del buffer
	if padLen == 0 || padLen > len(b) {
		return nil, errors.New("bad padding")
	}

	// tutti gli ultimi padLen byte devono essere uguali a padLen
	for i := 0; i < padLen; i++ {
		if b[len(b)-1-i] != byte(padLen) {
			return nil, errors.New("bad padding")
		}
	}

	// ritorna senza il padding
	return b[:len(b)-padLen], nil
}

// decryptAESImage decifra una foto cifrata con AES-128-CBC.
// Input:
// - ivHex: IV in formato HEX
// - cipherB64: ciphertext in formato BASE64
// Output:
// - []byte che dovrebbero essere i byte JPEG originali (plaintext)
func decryptAESImage(ivHex, cipherB64 string) ([]byte, error) {
	// IV: HEX -> bytes
	iv, err := hex.DecodeString(ivHex)
	if err != nil {
		return nil, fmt.Errorf("decode iv: %w", err)
	}

	// IV deve essere lungo 16 byte (BlockSize AES)
	if len(iv) != aes.BlockSize {
		return nil, fmt.Errorf("iv size must be %d", aes.BlockSize)
	}

	// Ciphertext: BASE64 -> bytes
	ct, err := base64.StdEncoding.DecodeString(cipherB64)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}

	// Ciphertext deve essere multiplo di 16 byte
	if len(ct)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("ciphertext not multiple of block size")
	}

	// Crea oggetto AES con la chiave condivisa
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}

	// Decrittazione AES-CBC
	mode := cipher.NewCBCDecrypter(block, iv)
	plain := make([]byte, len(ct))
	mode.CryptBlocks(plain, ct)

	// Rimuove PKCS#7 padding
	plain, err = pkcs7Unpad(plain)
	if err != nil {
		return nil, fmt.Errorf("unpad: %w", err)
	}

	return plain, nil
}

// generateCameraID replica keccak256(abi.encodePacked(macAddress, eFuseId)) che fa il contratto Solidity.
// calcola lo stesso hash che calcola il contratto
func generateCameraID(macAddress, efuseID string) string {
	packed := append([]byte(macAddress), []byte(efuseID)...)
	hash := crypto.Keccak256(packed)
	return "0x" + hex.EncodeToString(hash)
}

var errCameraNotFound = errors.New("camera id not found in keys file")

// loadCameraPrivateKey carica la private key dal file JSON locale:
// - cerca il camID (case-insensitive, con o senza "0x")
// - se la chiave è cifrata ("enc:v1:...") la decifra con keyEncKey
// - ritorna private key con prefisso "0x" e l'address associato
func loadCameraPrivateKey(camID, keysPath string) (string, string, error) {
	data, err := os.ReadFile(keysPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", "", errCameraNotFound
		}
		return "", "", err
	}

	var keys map[string]cameraKeyEntry
	if err := json.Unmarshal(data, &keys); err != nil {
		return "", "", err
	}

	target := strings.ToLower(strings.TrimPrefix(camID, "0x"))
	for key, entry := range keys {
		if strings.ToLower(strings.TrimPrefix(key, "0x")) != target {
			continue
		}
		if entry.PrivateKey == "" {
			return "", "", errors.New("private key missing in keys file")
		}
		privateKey := entry.PrivateKey
		if strings.HasPrefix(privateKey, "enc:v1:") {
			privateKey, err = decryptPrivateKey(privateKey)
			if err != nil {
				return "", "", err
			}
		}
		if !strings.HasPrefix(privateKey, "0x") {
			privateKey = "0x" + privateKey
		}
		return privateKey, entry.Address, nil
	}
	return "", "", errCameraNotFound
}

// decryptPrivateKey decifra una private key salvata come "enc:v1:" + base64(nonce|ciphertext).
// Usa AES-256-GCM con keyEncKey; ritorna la chiave in chiaro (stringa).
func decryptPrivateKey(enc string) (string, error) {
	enc = strings.TrimPrefix(enc, "enc:v1:")
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", fmt.Errorf("decode encrypted key: %w", err)
	}
	if len(raw) < 12+16 {
		return "", errors.New("encrypted key too short")
	}

	nonce := raw[:12]
	ciphertext := raw[12:]

	if len(keyEncKey) != 32 {
		return "", errors.New("invalid keyEncKey length")
	}
	block, err := aes.NewCipher(keyEncKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt private key: %w", err)
	}

	return strings.TrimSpace(string(plain)), nil
}

// encryptPrivateKey cifra la private key con AES-256-GCM usando keyEncKey.
// Ritorna "enc:v1:" + base64(nonce|ciphertext) per salvarla in camera_keys.json.
func encryptPrivateKey(privateKey string) (string, error) {
	if len(keyEncKey) != 32 {
		return "", errors.New("invalid keyEncKey length")
	}
	block, err := aes.NewCipher(keyEncKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(strings.TrimSpace(privateKey)), nil)
	raw := append(nonce, ciphertext...)
	return "enc:v1:" + base64.StdEncoding.EncodeToString(raw), nil
}

// getRelayNonce legge il nonce del relay (msg.sender on-chain) via FireFly.
// Serve per prevenire replay e per firmare correttamente la foto.
func getRelayNonce(relayAddr string) (uint64, error) {
	// Endpoint FireFly per query getNonce del contratto
	url := fmt.Sprintf("%s/namespaces/%s/apis/%s/query/getNonce", fireflyAPI, namespace, apiName)
	// Payload con address del relay (msg.sender on-chain)
	payload := map[string]any{
		"input": map[string]any{
			"_cameraAddress": relayAddr,
		},
	}

	// Serializza JSON
	b, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}

	// Crea richiesta HTTP
	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")

	// Esegui chiamata
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	// Leggi risposta
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("firefly http %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse JSON
	var data map[string]any
	if err := json.Unmarshal(respBody, &data); err != nil {
		return 0, err
	}

	// Alcune versioni di FireFly restituiscono direttamente "output"
	if v, ok := data["output"]; ok {
		return parseNonce(v)
	}

	// Altre versioni annidano i campi in output
	if out, ok := data["output"].(map[string]any); ok {
		if v, ok := out["0"].(any); ok {
			return parseNonce(v)
		}
		if v, ok := out["_0"]; ok {
			return parseNonce(v)
		}
		if v, ok := out["nonce"]; ok {
			return parseNonce(v)
		}
	}

	// Se non trovato, segnala errore con il body completo
	return 0, fmt.Errorf("nonce not found in getNonce output: %s", string(respBody))
}

// parseNonce normalizza il nonce da FireFly (numero o stringa) a uint64.
func parseNonce(v any) (uint64, error) {
	switch t := v.(type) {
	case float64:
		return uint64(t), nil
	case int:
		return uint64(t), nil
	case int64:
		return uint64(t), nil
	case string:
		return strconv.ParseUint(t, 10, 64)
	default:
		return 0, fmt.Errorf("unsupported nonce type %T", v)
	}
}

// createAndSaveWallet genera un wallet nuovo, cifra la private key e la salva su camera_keys.json.
// Ritorna l'entry salvata e la private key in chiaro (solo per output iniziale).
func createAndSaveWallet(camID, keysPath string) (cameraKeyEntry, string, error) {
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		return cameraKeyEntry{}, "", err
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey).Hex()
	privHex := hex.EncodeToString(crypto.FromECDSA(privateKey))

	encKey, err := encryptPrivateKey("0x" + privHex)
	if err != nil {
		return cameraKeyEntry{}, "", err
	}

	entry := cameraKeyEntry{
		Address:    address,
		PrivateKey: encKey,
		Mnemonic:   "",
		CreatedAt:  time.Now().Format(time.RFC3339),
	}

	keys := map[string]cameraKeyEntry{}
	if data, err := os.ReadFile(keysPath); err == nil {
		_ = json.Unmarshal(data, &keys)
	}

	keys[camID] = entry
	out, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return cameraKeyEntry{}, "", err
	}
	if err := os.WriteFile(keysPath, out, 0600); err != nil {
		return cameraKeyEntry{}, "", err
	}

	return entry, "0x" + privHex, nil
}

// getCameraInfo esegue una query FireFly per ottenere i dettagli on-chain della camera.
func getCameraInfo(camID string) (map[string]any, error) {
	url := fmt.Sprintf("%s/namespaces/%s/apis/%s/query/getCameraInfo", fireflyAPI, namespace, apiName)
	payload := map[string]any{
		"input": map[string]any{
			"_cameraId": camID,
		},
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("firefly http %d: %s", resp.StatusCode, string(respBody))
	}

	var out cameraInfoResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, err
	}
	return out.Output, nil
}

// getCameraAuthorization controlla autorizzazione camera e ritorna (authorized, walletAddress).
func getCameraAuthorization(camID string) (bool, string, error) {
	info, err := getCameraInfo(camID)
	if err != nil {
		return false, "", err
	}

	authorized := false
	if v, ok := info["isAuthorized"]; ok {
		switch t := v.(type) {
		case bool:
			authorized = t
		case string:
			authorized = strings.EqualFold(t, "true")
		}
	}

	wallet := ""
	if v, ok := info["walletAddress"].(string); ok {
		wallet = v
	}

	return authorized, wallet, nil
}

// solidityPackedMessage ricrea abi.encodePacked(photoHash, location, metadata, nonce) come fa Solidity.
//serve a firmare localmente lo stesso messaggio che Solidity si aspetta on‑chain.
func solidityPackedMessage(photoHashHex, location, metadata string, nonce uint64) ([]byte, error) {
	hashHex := strings.TrimPrefix(photoHashHex, "0x")
	hashBytes, err := hex.DecodeString(hashHex)
	if err != nil {
		return nil, fmt.Errorf("decode photo hash: %w", err)
	}
	if len(hashBytes) != 32 {
		return nil, fmt.Errorf("photo hash must be 32 bytes, got %d", len(hashBytes))
	}

	nonceBuf := make([]byte, 32)
	n := new(big.Int).SetUint64(nonce)
	n.FillBytes(nonceBuf)

	packed := make([]byte, 0, 32+len(location)+len(metadata)+32)
	packed = append(packed, hashBytes...)
	packed = append(packed, []byte(location)...)
	packed = append(packed, []byte(metadata)...)
	packed = append(packed, nonceBuf...)
	return packed, nil
}

// signPhotoMessage firma il messaggio con prefisso Ethereum Signed Message e ritorna la firma (hex).
func signPhotoMessage(privateKeyHex, photoHashHex, location, metadata string, nonce uint64) (string, error) {
	packed, err := solidityPackedMessage(photoHashHex, location, metadata, nonce)
	if err != nil {
		return "", err
	}
	messageHash := crypto.Keccak256(packed)

	prefix := fmt.Sprintf("\x19Ethereum Signed Message:\n%d", len(messageHash))
	ethHash := crypto.Keccak256(append([]byte(prefix), messageHash...))

	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0x")
	priv, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		return "", err
	}

	sig, err := crypto.Sign(ethHash, priv)
	if err != nil {
		return "", err
	}
	sig[64] += 27
	return hex.EncodeToString(sig), nil
}

// uploadToIPFS carica su IPFS il ciphertext (base64) come file e ritorna CID file + CID directory.
func uploadToIPFS(cipherB64, filename string) (string, string, error) {
	// Decodifica Base64 del ciphertext
	cipherBytes, err := base64.StdEncoding.DecodeString(cipherB64)
	if err != nil {
		return "", "", fmt.Errorf("decode cipher base64: %w", err)
	}

	// Prepara multipart/form-data con il file
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return "", "", fmt.Errorf("create form file: %w", err)
	}
	if _, err := part.Write(cipherBytes); err != nil {
		return "", "", fmt.Errorf("write form file: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", "", fmt.Errorf("close multipart writer: %w", err)
	}

	// Esegui chiamata HTTP a IPFS /add
	client := &http.Client{Timeout: 2 * time.Minute}
	req, err := http.NewRequest("POST", ipfsAddURL, body)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	// Leggi risposta
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("ipfs http %d: %s", resp.StatusCode, string(respBody))
	}

	var fileCID string
	var dirCID string

	// La risposta di IPFS add può avere più righe JSON (file + directory)
	scanner := bufio.NewScanner(bytes.NewReader(respBody))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var r ipfsAddResponse
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			continue
		}
		if r.Name == filename && r.Hash != "" {
			fileCID = r.Hash
		}
		if r.Hash != "" {
			dirCID = r.Hash
		}
	}
	if err := scanner.Err(); err != nil {
		return "", "", err
	}

	// Fallback: se non trovi il fileCID, usa il CID directory
	if fileCID == "" {
		fileCID = dirCID
	}
	if fileCID == "" {
		return "", "", errors.New("ipfs add response missing CID")
	}

	return fileCID, dirCID, nil
}

// FireFlyInvokeInput sono i parametri passati alla funzione recordPhoto(...).
// I nomi JSON (es. "_photoHash", "_metadata", e in altre chiamate "_location")
// seguono la configurazione dell'API FireFly e devono combaciare.
type FireFlyInvokeInput struct {
	Metadata  string `json:"_metadata"`
	PhotoHash string `json:"_photoHash"`
}

// verifyPhotoOnChain
// Chiama FireFly (query verifyPhoto) per controllare
// se l'hash della foto è già registrato sulla blockchain.
// Ritorna true se esiste, false se non esiste.
func verifyPhotoOnChain(hash0x string) (bool, error) {
	url := fmt.Sprintf("%s/namespaces/%s/apis/%s/query/verifyPhoto", fireflyAPI, namespace, apiName)

	// body JSON come negli script .sh
	body := fmt.Sprintf(`{"input":{"_photoHash":"%s"}}`, hash0x)

	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequest("POST", url, strings.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, fmt.Errorf("firefly http %d: %s", resp.StatusCode, string(respBody))
	}

	// FireFly può rispondere in due modi:
	// - {"exists": true}
	// - {"output": {"exists": true, ...}}
	//Il codice gestisce entrambi i formati perché FireFly può restituire uno o l’altro a seconda della configurazione o della versione.
	var data map[string]any
	if err := json.Unmarshal(respBody, &data); err != nil {
		return false, err
	}

	// caso 1: exists top-level
	if v, ok := data["exists"].(bool); ok {
		return v, nil
	}

	// caso 2: output.exists
	if out, ok := data["output"].(map[string]any); ok {
		if v, ok := out["exists"].(bool); ok {
			return v, nil
		}
	}

	// se non trovato, assumiamo che non esista
	return false, nil
}

// recordPhotoOnChain
// Chiama FireFly (invoke recordPhoto) per registrare
// l'hash della foto sulla blockchain.
// Usa confirm=true per aspettare la conferma.
func recordPhotoOnChain(hash0x, metadata string) error {
	url := fmt.Sprintf("%s/namespaces/%s/apis/%s/invoke/recordPhoto?confirm=true", fireflyAPI, namespace, apiName)

	// body JSON come negli script .sh (ma costruito in modo safe)
	payload := map[string]any{
		"input": map[string]any{
			"_photoHash": hash0x,
			"_metadata":  metadata,
		},
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 2 * time.Minute}
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("firefly http %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// recordPhotoWithSignatureOnChain
// Chiama FireFly (invoke recordPhotoWithSignature) per registrare
// hash + firma.
func recordPhotoWithSignatureOnChain(hash0x, location, metadata, signature string) error {
	url := fmt.Sprintf("%s/namespaces/%s/apis/%s/invoke/recordPhotoWithSignature?confirm=true", fireflyAPI, namespace, apiName)

	payload := map[string]any{
		"input": map[string]any{
			"_photoHash": hash0x,
			"_location":  location,
			"_metadata":  metadata,
			"_signature": signature,
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 2 * time.Minute}
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("firefly http %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// main è il punto di ingresso del programma.
// Fa 3 cose:
// 1) si connette a MQTT e ascolta le foto cifrate su camera1/alerts
// 2) quando arriva una foto: upload cifrato su IPFS, decifra, calcola SHA-256, invia hash a FireFly
// 3) legge la seriale Arduino: se riceve "MOTION" pubblica un comando su camera1/capture
func main() {
	// ================= MQTT =================

	// Opzioni client MQTT
	opts := mqtt.NewClientOptions()
	opts.AddBroker("tcp://192.168.137.1:1883") // IP del broker MQTT (PC)
	opts.SetClientID("go-subscriber-aes-image")

	// Crea client
	client := mqtt.NewClient(opts)

	// Connessione al broker
	if token := client.Connect(); token.Wait() && token.Error() != nil {
		log.Fatal(token.Error())
	}
	fmt.Println("✅ Connesso al broker MQTT")

	// Callback chiamata ogni volta che arriva un messaggio su camera1/alerts
	cb := func(_ mqtt.Client, msg mqtt.Message) {
		fmt.Printf("📥 Messaggio su [%s]\n", msg.Topic())

		// 1)  JSON payload MQTT ricevuto e lo converte nella struct Go
		var p EncryptedPayload
		if err := json.Unmarshal(msg.Payload(), &p); err != nil {
			fmt.Println("❌ JSON invalido:", err) //se è malformato/non compatibile
			return
		}

		// Valida i campi minimi richiesti per calcolare cameraId e firmare
		if p.Mac == "" || p.Efuse == "" {
			fmt.Printf("❌ camera_id assente: MAC/EFUSE mancanti nel payload (mac=%q efuse=%q)\n", p.Mac, p.Efuse)
			return
		}
		if strings.TrimSpace(p.Location) == "" {
			fmt.Printf("❌ location assente: 'location' mancante nel payload (cam=%q)\n", p.Cam)
			return
		}
		camID := generateCameraID(p.Mac, p.Efuse)
		fmt.Printf("ℹ️  camera_id=%s mac=%s efuse=%s location=%s\n", camID, p.Mac, p.Efuse, p.Location)

		// Carica la private key locale 
		privateKey, savedAddr, err := loadCameraPrivateKey(camID, cameraKeysFile)
		if err != nil {
			if errors.Is(err, errCameraNotFound) {
				fmt.Println("❌ Chiave privata per firmare non trovata, può essere che stai usando una camera senza wallet e non autorizzata.")
				return
			}
			fmt.Println("❌ errore lettura private key:", err)
			return
		}

		// Verifica autorizzazione camera on-chain
		authorized, walletAddr, err := getCameraAuthorization(camID)
		if err != nil {
			fmt.Printf("❌ verifica autorizzazione fallita (%s): %v\n", camID, err)
			return
		}
		if !authorized {
			fmt.Printf("❌ camera non autorizzata (%s)\n", camID)
			if savedAddr != "" {
				fmt.Printf("   wallet locale: %s\n", savedAddr)
			}
			return
		}
		if walletAddr != "" {
			fmt.Printf("✅ camera autorizzata (%s) wallet=%s\n", camID, walletAddr)
		} else {
			fmt.Printf("✅ camera autorizzata (%s)\n", camID)
		}

		// Se FireFly ritorna wallet address, verifica che la private key locale combaci
		if walletAddr != "" {
			priv, err := crypto.HexToECDSA(strings.TrimPrefix(privateKey, "0x"))
			if err != nil {
				fmt.Println("❌ private key non valida:", err)
				return
			}
			derivedAddr := crypto.PubkeyToAddress(priv.PublicKey).Hex()
			if !strings.EqualFold(derivedAddr, walletAddr) {
				fmt.Printf("❌ private key non corrisponde al wallet: got %s want %s\n", derivedAddr, walletAddr)
				return
			}
		}

		// Genera ID locale per i file salvati su disco
		photoID := fmt.Sprintf("foto_%d", time.Now().UnixNano())
		encFilename := photoID + ".enc"

		// Upload cifrato su IPFS (solo CID in locale)
		fileCID, dirCID, err := uploadToIPFS(p.Cipher, encFilename)
		if err != nil {
			fmt.Println("IPFS upload error:", err)
			return
		}

		cidInfo := fmt.Sprintf("cid=%s\ndir_cid=%s\nname=%s\ncam=%s\niv=%s\n",
			fileCID, dirCID, encFilename, camID, p.IV,
		)
		if err := os.WriteFile(photoID+".cid", []byte(cidInfo), 0644); err != nil {
			fmt.Println("Errore salvataggio CID:", err)
			return
		}
		fmt.Printf("CID IPFS salvato in %s (cid=%s)\n", photoID+".cid", fileCID)

		// 2) Decrypt AES-CBC (ritorna bytes del JPEG)
		plainImg, err := decryptAESImage(p.IV, p.Cipher)
		if err != nil {
			fmt.Println("❌ Errore AES:", err)
			return
		}

		// 4) Calcola SHA-256 della foto decifrata (digest puro, senza 0x)
		hashBytes := sha256.Sum256(plainImg)
		hashHex := hex.EncodeToString(hashBytes[:])
		fmt.Printf("🔐 SHA-256 immagine: %s\n", hashHex)

		// 5) Salva hash su PC (standard: senza 0x)
		_ = os.WriteFile(photoID+".sha256", []byte(hashHex+"\n"), 0644)

		// hash in formato “blockchain style” (solo per FireFly/on-chain)
		hashOnChain := "0x" + hashHex

		// 6) Verifica su blockchain e registra se manca
		// Verifica se l'hash è già on-chain
		exists, err := verifyPhotoOnChain(hashOnChain)
		if err != nil {
			fmt.Println("❌ verifyPhoto error:", err)
			return
		}
		if exists {
			fmt.Println("ℹ️ Hash già presente on-chain, salto registrazione.")
			return
		}

		// 6b) Prepara metadata (piu utili)
		ts := time.Now().Format(time.RFC3339)

		size := int64(len(plainImg))

		metadata := fmt.Sprintf(
			"camera=%s;topic=%s;file=%s;ts=%s;size=%d;sha256=%s;cid=%s;dir_cid=%s;enc_name=%s",
			camID, msg.Topic(), photoID+".jpg", ts, size, hashHex, fileCID, dirCID, encFilename,
		)

		// Legge nonce del relay per prevenire replay e firmare correttamente
		if relayAddress == "CHANGE_ME_RELAY_ADDRESS" {
			fmt.Println("❌ relayAddress non configurato")
			return
		}
		nonce, err := getRelayNonce(relayAddress)
		if err != nil {
			fmt.Println("❌ get relay nonce:", err)
			return
		}
		fmt.Printf("ℹ️  nonce=%d\n", nonce)

		// Firma il messaggio (hash + location + metadata + nonce)
		signature, err := signPhotoMessage(privateKey, hashOnChain, p.Location, metadata, nonce)
		if err != nil {
			fmt.Println("❌ sign photo:", err)
			return
		}

		// Invoca il contratto con hash + firma
		if err := recordPhotoWithSignatureOnChain(hashOnChain, p.Location, metadata, signature); err != nil {
			fmt.Println("❌ recordPhotoWithSignature error:", err)
			// Riprova una volta se il nonce era obsoleto
			newNonce, nerr := getRelayNonce(relayAddress)
			if nerr == nil && newNonce != nonce {
				fmt.Printf("ℹ️  retry con nonce aggiornato=%d\n", newNonce)
				signature, err = signPhotoMessage(privateKey, hashOnChain, p.Location, metadata, newNonce)
				if err == nil {
					if err2 := recordPhotoWithSignatureOnChain(hashOnChain, p.Location, metadata, signature); err2 == nil {
						fmt.Println("✅ Hash registrato on-chain (firma OK, retry)")
						return
					}
				}
			}
			return
		}
		fmt.Println("✅ Hash registrato on-chain (firma OK)")
	}

	// Subscribe al topic dove arrivano le foto cifrate
	if token := client.Subscribe("camera1/alerts", 0, cb); token.Wait() && token.Error() != nil {
		log.Fatal(token.Error())
	}
	fmt.Println("✅ Iscritto a camera1/alerts")

	// ================= SERIALE ARDUINO + PIR =================

	// Nome porta seriale 
	serialPortName := "COM5"

	serialCfg := &serial.Config{
		Name: serialPortName,
		Baud: 9600,
	}

	// Prova ad aprire la seriale.
	// Se fallisce, il programma continua comunque (solo MQTT).
	ser, err := serial.OpenPort(serialCfg)
	if err != nil {
		log.Printf("⚠️  Impossibile aprire la seriale %s: %v\n", serialPortName, err)
	} else {
		fmt.Println("✅ Serial aperta su", serialPortName)
		// Cooldown anti-burst: evita publish multipli troppo ravvicinati
		// quando il PIR emette piu' eventi MOTION consecutivi.
		const motionCooldown = 4 * time.Second
		// Timestamp dell'ultimo comando capture pubblicato su MQTT.
		var lastMotionPublished time.Time

		// Lettura seriale in goroutine, così non blocca il main 
		// (lettura dalla porta seriale gira in un thread leggero separato go func(),
		//  quindi il main può continuare a fare altro
		go func() {
			scanner := bufio.NewScanner(ser)

			// Legge i dati che arrivano dalla porta seriale dell’Arduino
			// quindi le stringhe inviate dallo sketch PIR (tipicamente "MOTION")
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if line == "" {
					continue
				}

				fmt.Println("🔎 Dalla seriale Arduino:", line)

				// Se Arduino manda "MOTION", pubblichi un comando MQTT
				// che l'ESP32-CAM interpreta come "scatta una foto".
				if line == "MOTION" {
					// Ignora trigger entro 4s dall'ultimo publish:
					// serve a dare tempo alla pipeline (salvataggio + on-chain).
					if !lastMotionPublished.IsZero() && time.Since(lastMotionPublished) < motionCooldown {
						fmt.Printf("⏳ MOTION ignorato: cooldown attivo (%.1fs)\n", motionCooldown.Seconds())
						continue
					}
					// Registra subito l'istante per bloccare burst successivi.
					lastMotionPublished = time.Now()
					fmt.Println("🚨 Movimento rilevato → invio comando MQTT a camera1/capture")

					// Publish comando
					t := client.Publish("camera1/capture", 0, false, "1")
					t.Wait()

					if t.Error() != nil {
						fmt.Println("❌ Errore publish comando:", t.Error())
					}
				}
			}

			// Errore lettura scanner
			if err := scanner.Err(); err != nil {
				fmt.Println("❌ Errore lettura seriale:", err)
			}
		}()
	}

	// ================= ATTESA SIGNALE PER USCIRE =================

	// Aspetta Ctrl+C (SIGINT) o chiusura da sistema (SIGTERM)
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, os.Interrupt, syscall.SIGTERM)
	<-sigc

	// Cleanup
	fmt.Println("⏹️ Chiusura...")
	client.Disconnect(250)

	if ser != nil {
		ser.Close()
	}
}
