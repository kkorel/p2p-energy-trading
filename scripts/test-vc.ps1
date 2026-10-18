# VC Verification Testing Script for Windows PowerShell
# Run from project root: .\scripts\test-vc.ps1

$BaseUrl = if ($env:BAP_URL) { $env:BAP_URL } else { "http://localhost:4000" }

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Verifiable Credentials Testing Script" -ForegroundColor Cyan
Write-Host "  Base URL: $BaseUrl" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# Helper function to make API calls
function Invoke-VCTest {
    param(
        [string]$TestName,
        [string]$Method,
        [string]$Endpoint,
        [object]$Body = $null
    )
    
    Write-Host "=== $TestName ===" -ForegroundColor Yellow
    
    try {
        $uri = "$BaseUrl$Endpoint"
        $params = @{
            Uri = $uri
            Method = $Method
            ContentType = "application/json"
        }
        
        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Depth 10)
        }
        
        $response = Invoke-RestMethod @params
        $response | ConvertTo-Json -Depth 10
    }
    catch {
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) {
            $_.ErrorDetails.Message | ConvertFrom-Json | ConvertTo-Json -Depth 5
        }
    }
    Write-Host ""
}

# Test 1: Get supported schemas
Invoke-VCTest -TestName "TEST 1: Get VC Schemas" -Method "GET" -Endpoint "/api/vc/schemas"

# Test 2: Verify the sample solar generation-profile VC
$sampleSolarVC = @{
    credential = Get-Content (Join-Path $PSScriptRoot "sample-vcs/generation-profile-solar.json") -Raw | ConvertFrom-Json
}
Invoke-VCTest -TestName "TEST 2: Verify sample VC (Solar)" -Method "POST" -Endpoint "/api/vc/verify" -Body $sampleSolarVC

# Test 3: Verify same VC with Generation Profile endpoint
Invoke-VCTest -TestName "TEST 3: Verify Generation Profile (sample Solar)" -Method "POST" -Endpoint "/api/vc/verify-generation-profile" -Body $sampleSolarVC

# Test 4: Verify with Provider ID match
$vcWithConsumerMatch = @{
    credential = $sampleSolarVC.credential
    expectedProviderId = "provider-priya-001"  # Match the providerId
}
Invoke-VCTest -TestName "TEST 4: Verify with Consumer Number Match" -Method "POST" -Endpoint "/api/vc/verify-generation-profile" -Body $vcWithConsumerMatch

# Test 4: Invalid VC Structure (should fail)
$invalidVC = @{
    credential = @{
        type = @("SomeCredential")
        subject = "missing required fields"
    }
}
Invoke-VCTest -TestName "TEST 4: Invalid VC Structure (should fail)" -Method "POST" -Endpoint "/api/vc/verify" -Body $invalidVC

# Test 5: Verify from JSON string
$jsonVC = @{
    json = '{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"urn:uuid:test-json","type":["VerifiableCredential","UtilityCustomerCredential"],"issuer":"did:example:utility-issuer","issuanceDate":"2024-01-01T00:00:00Z","credentialSubject":{"id":"did:example:customer-neha","fullName":"Neha Sample","fullAddress":"Green avenue, 10th cross road, Odisha","serviceConnectionDate":"2020-12-22"}}'
}
Invoke-VCTest -TestName "TEST 5: Verify from JSON String" -Method "POST" -Endpoint "/api/vc/verify-json" -Body $jsonVC

# Test 6: Expired credential (should show expiration failure)
$expiredVC = @{
    credential = @{
        "@context" = @("https://www.w3.org/2018/credentials/v1")
        id = "urn:uuid:expired-test"
        type = @("VerifiableCredential", "TestCredential")
        issuer = "did:example:test-issuer"
        issuanceDate = "2020-01-01T00:00:00Z"
        expirationDate = "2021-01-01T00:00:00Z"
        credentialSubject = @{
            id = "did:example:test-subject"
            name = "Test Subject"
        }
    }
}
Invoke-VCTest -TestName "TEST 6: Expired Credential (should fail)" -Method "POST" -Endpoint "/api/vc/verify" -Body $expiredVC

# Test 7: Provider ID mismatch (should fail)
$mismatchVC = @{
    credential = @{
        "@context" = @("https://www.w3.org/2018/credentials/v1")
        id = "urn:uuid:mismatch-test"
        type = @("VerifiableCredential", "GenerationProfileCredential")
        issuer = "did:example:ies-issuer"
        issuanceDate = "2024-01-01T00:00:00Z"
        credentialSubject = @{
            providerId = "provider-actual-001"
            providerName = "Actual Provider"
            installedCapacityKW = 15
            sourceType = "SOLAR"
            gridConnectionStatus = "CONNECTED"
        }
        proof = @{
            type = "Ed25519Signature2020"
            created = "2024-01-01T00:00:00Z"
            verificationMethod = "did:example:ies-issuer#key-1"
            proofPurpose = "assertionMethod"
            proofValue = "zProofValue..."
        }
    }
    expectedProviderId = "provider-expected-999"
}
Invoke-VCTest -TestName "TEST 7: Provider ID Mismatch (should fail)" -Method "POST" -Endpoint "/api/vc/verify-generation-profile" -Body $mismatchVC

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  All tests completed!" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
