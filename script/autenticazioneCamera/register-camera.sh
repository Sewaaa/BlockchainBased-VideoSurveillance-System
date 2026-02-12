#!/bin/bash

source .secCam-v2.env 2>/dev/null || {
    FIREFLY_API="http://127.0.0.1:5000/api/v1"
    NAMESPACE="default"
    API_NAME="secCamv3"
}

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}📝 Registrazione Telecamera${NC}"
echo "============================="
echo ""

# Parametri

EFUSE_ID="${1:-D8F998D4DB1C}"
LOCATION="${2:-"ingresso"}"
MAC_ADDRESS="${3:-1C:DB:D4:98:F9:G8}"
MODEL="${4:-ESP32-CAM}"
WALLET_ADDRESS="$5"

if [ -z "$WALLET_ADDRESS" ]; then
    echo -e "${RED}Errore: Wallet address richiesto${NC}"
    echo ""
    echo "Uso: $0 <MAC> <eFuseID> <wallet> [location] [model]"
    echo ""
    echo "Esempio:"
    echo "$0 D8F998D4DB1C \"Ingresso\" 1C:DB:D4:98:F9:D8  \"ESP32-CAM\""
    echo ""
    echo "Per generare wallet:"
    echo "python3 esp32_camera_auth.py"
    exit 1
fi

echo "Telecamera da registrare:"
echo "  MAC Address:    $MAC_ADDRESS"
echo "  eFuse ID:      $EFUSE_ID"
echo "  Wallet:        $WALLET_ADDRESS"
echo "  Location:      $LOCATION"
echo "  Model:         $MODEL"
echo ""

read -p "Confermi registrazione? (y/n): " CONFIRM
[ "$CONFIRM" != "y" ] && exit 0

echo ""
echo -e "${BLUE}🔄 Invio transazione... ${NC}"

# Chiama registerAndAuthorizeCamera
RESPONSE=$(curl -s -X POST \
  "$FIREFLY_API/namespaces/$NAMESPACE/apis/$API_NAME/invoke/registerAndAuthorizeCamera?confirm=true" \
  -H 'Content-Type: application/json' \
  -d "{
    \"input\": {
      \"_eFuseId\": \"$EFUSE_ID\",
      \"_location\": \"$LOCATION\",
      \"_macAddress\": \"$MAC_ADDRESS\",
      \"_model\": \"$MODEL\",
      \"_walletAddress\": \"$WALLET_ADDRESS\"
    }
  }")

echo "$RESPONSE" | jq '.'
echo ""

REQUEST_ID=$(echo "$RESPONSE" | jq -r '.id // empty')

if [ -n "$REQUEST_ID" ]; then
    echo -e "${GREEN}✅ Richiesta inviata${NC}"
    echo "   Request ID: $REQUEST_ID"
    echo ""
    echo "⏳ Attendo conferma (20 secondi)..."
    
    STATUS=$(curl -s "$FIREFLY_API/namespaces/$NAMESPACE/operations/$REQUEST_ID" | jq -r '.status')
    
    if [ "$STATUS" == "Succeeded" ]; then
        echo -e "${GREEN}🎉 TELECAMERA REGISTRATA E AUTORIZZATA! ${NC}"
    else
        echo -e "${RED}❌ Errore:  $STATUS${NC}"
    fi
else
    echo -e "${RED}❌ Errore nella registrazione${NC}"
fi

echo ""