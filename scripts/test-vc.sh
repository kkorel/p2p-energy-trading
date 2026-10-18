#!/bin/bash
# VC Verification Testing Script
# Run from project root: bash scripts/test-vc.sh

BASE_URL="${BAP_URL:-http://localhost:4000}"

echo "=============================================="
echo "  Verifiable Credentials Testing Script"
echo "  Base URL: $BASE_URL"
echo "=============================================="
echo ""

# Test 1: Get supported schemas
echo "=== TEST 1: Get VC Schemas ==="
curl -s "$BASE_URL/api/vc/schemas" | jq .
echo ""

# Test 2: Verify a valid Generation Profile VC
echo "=== TEST 2: Verify Generation Profile VC ==="
curl -s -X POST "$BASE_URL/api/vc/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "credential": {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://ies.gov.in/credentials/v1"
      ],
      "id": "urn:uuid:e0630c1e-test-generation",
      "type": ["VerifiableCredential", "GenerationProfileCredential"],
      "issuer": "did:example:ies-issuer-001",
      "issuanceDate": "2024-01-15T00:00:00Z",
      "credentialSubject": {
        "id": "did:example:provider-meera",
        "providerId": "provider-meera-001",
        "providerName": "Meera Sample",
        "installedCapacityKW": 23,
        "sourceType": "HYDRO",
        "sourceDescription": "MicroHydro generation unit",
        "gridConnectionStatus": "CONNECTED",
        "commissioningDate": "2023-06-01"
      },
      "proof": {
        "type": "Ed25519Signature2020",
        "created": "2024-01-15T00:00:00Z",
        "verificationMethod": "did:example:ies-issuer-001#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "z3FXQjecWufY46yg7vp2E2rYcdxLp..."
      }
    }
  }' | jq .
echo ""

# Test 3: Verify a Solar Generation Profile
echo "=== TEST 3: Verify Solar Generation Profile ==="
curl -s -X POST "$BASE_URL/api/vc/verify-generation-profile" \
  -H "Content-Type: application/json" \
  -d '{
    "credential": {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://ies.gov.in/credentials/v1"
      ],
      "id": "urn:uuid:cd356c76-solar-generation",
      "type": ["VerifiableCredential", "GenerationProfileCredential"],
      "issuer": {
        "id": "did:example:ies-issuer-001",
        "name": "IES Credential Issuer"
      },
      "issuanceDate": "2024-02-20T00:00:00Z",
      "credentialSubject": {
        "id": "did:example:provider-priya",
        "providerId": "provider-priya-001",
        "providerName": "PRIYA SAMPLE",
        "installedCapacityKW": 23,
        "sourceType": "SOLAR",
        "gridConnectionStatus": "CONNECTED"
      },
      "proof": {
        "type": "Ed25519Signature2020",
        "created": "2024-02-20T00:00:00Z",
        "verificationMethod": "did:example:ies-issuer-001#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "z58DAdFfa9SkqZMVPxAQpic7ndTe..."
      }
    },
    "expectedProviderId": "provider-priya-001"
  }' | jq .
echo ""

# Test 4: Verify with invalid structure (should fail)
echo "=== TEST 4: Invalid VC Structure (should fail) ==="
curl -s -X POST "$BASE_URL/api/vc/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "credential": {
      "type": ["SomeCredential"],
      "subject": "missing required fields"
    }
  }' | jq .
echo ""

# Test 5: Verify from JSON string
echo "=== TEST 5: Verify from JSON String ==="
curl -s -X POST "$BASE_URL/api/vc/verify-json" \
  -H "Content-Type: application/json" \
  -d '{
    "json": "{\"@context\":[\"https://www.w3.org/2018/credentials/v1\"],\"id\":\"urn:uuid:test-json\",\"type\":[\"VerifiableCredential\",\"UtilityCustomerCredential\"],\"issuer\":\"did:example:utility-issuer\",\"issuanceDate\":\"2024-01-01T00:00:00Z\",\"credentialSubject\":{\"id\":\"did:example:customer-neha\",\"fullName\":\"Neha Sample\",\"fullAddress\":\"Green avenue, 10th cross road, Odisha\",\"serviceConnectionDate\":\"2020-12-22\"}}"
  }' | jq .
echo ""

# Test 6: Check expired credential
echo "=== TEST 6: Expired Credential (should show expiration failure) ==="
curl -s -X POST "$BASE_URL/api/vc/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "credential": {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      "id": "urn:uuid:expired-test",
      "type": ["VerifiableCredential", "TestCredential"],
      "issuer": "did:example:test-issuer",
      "issuanceDate": "2020-01-01T00:00:00Z",
      "expirationDate": "2021-01-01T00:00:00Z",
      "credentialSubject": {
        "id": "did:example:test-subject",
        "name": "Test Subject"
      }
    }
  }' | jq .
echo ""

echo "=============================================="
echo "  All tests completed!"
echo "=============================================="
