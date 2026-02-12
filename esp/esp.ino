#include "esp_camera.h"
#include <WiFi.h>
#include <PubSubClient.h>
#include "mbedtls/aes.h"
#include "mbedtls/base64.h"

// ID e location hardcoded lato ESP (inviati nel payload MQTT)
#define CAMERA_ID "cam-esp32-01"
#define CAMERA_LOCATION "Building A - Entrance"
// ====================== CONFIG UTENTE ======================
const char* ssid     = "SAM-HPLAPTOP9459";
const char* password = "B31i9688";

const char* mqttServer      = "192.168.137.1";   // IP del PC / broker MQTT
const int   mqttPort        = 1883;
const char* mqttTopicPhoto  = "camera1/alerts";   // dove inviamo le foto
const char* mqttTopicCmd    = "camera1/capture";  // dove ascoltiamo i comandi

// AES KEY / IV (uguale al Go)
const unsigned char AES_KEY[16] = {
  '0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'
};

const unsigned char AES_IV[16]  = {
  0x00,0x11,0x22,0x33,
  0x44,0x55,0x66,0x77,
  0x88,0x99,0xaa,0xbb,
  0xcc,0xdd,0xee,0xff
};

WiFiClient espClient;
PubSubClient client(espClient);

// ====================== PIN CAMERA S3-CAM ======================
#define PWDN_GPIO_NUM    -1
#define RESET_GPIO_NUM   -1
#define XCLK_GPIO_NUM    15
#define SIOD_GPIO_NUM    4
#define SIOC_GPIO_NUM    5

#define Y2_GPIO_NUM      11
#define Y3_GPIO_NUM      9
#define Y4_GPIO_NUM      8
#define Y5_GPIO_NUM      10
#define Y6_GPIO_NUM      12
#define Y7_GPIO_NUM      18
#define Y8_GPIO_NUM      17
#define Y9_GPIO_NUM      16

#define VSYNC_GPIO_NUM   6
#define HREF_GPIO_NUM    7
#define PCLK_GPIO_NUM    13
// ======================================================

bool cameraReady = false;
volatile bool captureRequested = false;

// ---------------- AES CBC PKCS#7 -----------------
int aesEncryptCBC(const uint8_t* input, size_t len,
                  uint8_t* output, size_t outCapacity, size_t* outLen) {

  size_t padLen = 16 - (len % 16);
  if (padLen == 0) padLen = 16;
  size_t totalLen = len + padLen;

  if (totalLen > outCapacity) return -1;

  uint8_t* buffer = (uint8_t*)malloc(totalLen);
  if (!buffer) return -1;

  memcpy(buffer, input, len);
  memset(buffer + len, padLen, padLen);

  mbedtls_aes_context ctx;
  mbedtls_aes_init(&ctx);
  mbedtls_aes_setkey_enc(&ctx, AES_KEY, 128);

  uint8_t iv[16];
  memcpy(iv, AES_IV, 16);

  int r = mbedtls_aes_crypt_cbc(&ctx,
                                MBEDTLS_AES_ENCRYPT,
                                totalLen,
                                iv,
                                buffer,
                                output);

  mbedtls_aes_free(&ctx);
  free(buffer);

  if (r != 0) return -1;

  *outLen = totalLen;
  return 0;
}

// ---------------- INIZIALIZZA CAMERA -----------------
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 10000000;           // 10 MHz
  config.pixel_format = PIXFORMAT_JPEG;

  config.frame_size   = FRAMESIZE_QVGA;     // 320x240
  config.jpeg_quality = 40;                 // qualità media
  config.fb_count     = 1;
  config.fb_location  = CAMERA_FB_IN_DRAM;
  config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("❌ Camera init failed: 0x%x\n", err);
    cameraReady = false;
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_framesize(s, FRAMESIZE_QVGA);
    s->set_quality(s, 40);
    s->set_vflip(s, 1);
    s->set_hmirror(s, 0);
  }

  cameraReady = true;
  Serial.println("📸 Camera inizializzata");
  return true;
}

// ---------------- SCATTA, CIFRA E INVIA -----------------
void sendEncryptedPhoto() {
  if (!cameraReady) {
    if (!initCamera()) {
      Serial.println("❌ Impossibile inizializzare la camera per lo scatto");
      return;
    }
    delay(200);
  }

  Serial.printf("💾 Heap libero prima dello scatto: %u bytes\n", ESP.getFreeHeap());

  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("❌ Foto non acquisita");
    return;
  }

  size_t imgLen = fb->len;
  Serial.printf("📷 Foto acquisita: %u bytes\n", imgLen);

  // Cifratura direttamente sul buffer della foto
  uint8_t* encrypted = (uint8_t*)malloc(imgLen + 32);
  if (!encrypted) {
    Serial.println("❌ malloc encrypted fallita");
    esp_camera_fb_return(fb);
    return;
  }

  size_t encLen = 0;
  if (aesEncryptCBC(fb->buf, imgLen, encrypted, imgLen + 32, &encLen) != 0) {
    Serial.println("❌ Errore AES");
    free(encrypted);
    esp_camera_fb_return(fb);
    return;
  }

  // Base64
  size_t b64Cap = 4 * ((encLen + 2) / 3) + 4;
  unsigned char* b64Buf = (unsigned char*)malloc(b64Cap);
  if (!b64Buf) {
    Serial.println("❌ malloc b64Buf fallita");
    free(encrypted);
    esp_camera_fb_return(fb);
    return;
  }

  size_t b64Len = 0;
  if (mbedtls_base64_encode(b64Buf, b64Cap, &b64Len, encrypted, encLen) != 0) {
    Serial.println("❌ Errore base64");
    free(encrypted);
    free(b64Buf);
    esp_camera_fb_return(fb);
    return;
  }
  b64Buf[b64Len] = '\0';

  String cipherB64 = (char*)b64Buf;

  String macAddr = WiFi.macAddress();
  uint64_t efuse = ESP.getEfuseMac();
  char efuseHex[13];
  snprintf(efuseHex, sizeof(efuseHex), "%012llX", (unsigned long long)efuse);

  // IV in hex
  char ivHex[33];
  for (int i = 0; i < 16; i++) {
    sprintf(&ivHex[i * 2], "%02x", AES_IV[i]);
  }

  // JSON finale
  String json = "{\"cam\":\"" CAMERA_ID "\",\"location\":\"" CAMERA_LOCATION "\",\"mac\":\"" + macAddr +
              "\",\"efuse\":\"" + String(efuseHex) +
              "\",\"iv\":\"" + String(ivHex) +
              "\",\"cipher\":\"" + cipherB64 + "\"}";


  int jsonLen = json.length();
  Serial.print("📏 Lunghezza JSON: ");
  Serial.println(jsonLen);

  Serial.println("📤 Invio MQTT...");
  bool ok = client.publish(mqttTopicPhoto, json.c_str());
  if (ok) {
    Serial.println("✅ Foto cifrata inviata (publish OK)!");
  } else {
    Serial.println("❌ Errore publish MQTT (probabile pacchetto troppo grande o buffer insufficiente)");
  }

  free(encrypted);
  free(b64Buf);
  esp_camera_fb_return(fb);

  Serial.printf("💾 Heap libero dopo lo scatto: %u bytes\n", ESP.getFreeHeap());
}

// ---------------- CALLBACK MQTT -----------------
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String t = String(topic);
  if (t == mqttTopicCmd) {
    Serial.println("📨 Comando di cattura ricevuto via MQTT");
    captureRequested = true;
  }
}

// ---------------- MQTT RECONNECT -----------------
void reconnectMQTT() {
  while (!client.connected()) {
    Serial.println("Connessione al broker MQTT...");
    if (client.connect("esp32-s3-cam-client")) {
      Serial.println("✅ MQTT connesso");
      client.subscribe(mqttTopicCmd);   // ascolta i comandi di cattura
      break;
    }
    Serial.println("❌ Retry fra poco...");
    delay(1500);
  }
}

// ---------------- SETUP -----------------
void setup() {
  Serial.begin(115200);

  Serial.println("Connessione WiFi...");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(500);
  }
  Serial.println("\n✅ WiFi connesso");
  Serial.print("IP ESP32: ");
  Serial.println(WiFi.localIP());

  client.setServer(mqttServer, mqttPort);
  client.setCallback(mqttCallback);
  client.setBufferSize(32768); // buffer grande per il JSON
}

// ---------------- LOOP -----------------
void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();

  if (captureRequested) {
    captureRequested = false;
    Serial.println("🔔 Cattura richiesta → scatto foto");
    sendEncryptedPhoto();
  }
}
