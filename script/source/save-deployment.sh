#!/bin/bash


CONTRACT_ADDRESS="0xcce4d621483724d0aa131754858f42ff8e01f74c"
FIREFLY_API="http://localhost:5000/api/v1"
NAMESPACE="default"

# Salva deployment info
cat > build/deployment.json << EOF
{
  "contractAddress": "$CONTRACT_ADDRESS",
  "contractName": "SecurityCamera",
  "network": "firefly-ethereum",
  "stack": "test1",
  "timestamp": "$(date -Iseconds)",
  "fireflyAPI": "$FIREFLY_API",
  "namespace": "$NAMESPACE"
}
EOF

echo "✅ Informazioni salvate in build/deployment.json"
cat build/deployment.json
