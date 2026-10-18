/**
 * VC PDF Analyzer
 * Extracts Verifiable Credential JSON from a PDF document.
 *
 * Dual approach:
 * 1. Primary: Find JSON in extracted text via regex and parse it
 * 2. Fallback: Use OpenRouter LLM to extract VC fields from text
 */

import axios from 'axios';
import { createLogger } from '@p2p/shared';

const logger = createLogger('VCPdfAnalyzer');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-3b-instruct:free';

export interface VCExtractionResult {
  success: boolean;
  credential: Record<string, any> | null;
  extractionMethod: 'json' | 'llm';
  error?: string;
}

/**
 * Extract text from PDF buffer using pdfjs-dist library
 */
async function extractPdfText(pdfBuffer: Buffer): Promise<{ text: string; error?: string }> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const uint8Array = new Uint8Array(pdfBuffer);

    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
      stopAtErrors: false,
    });

    const pdfDoc = await loadingTask.promise;
    let fullText = '';

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str || '')
          .join(' ');
        fullText += pageText + '\n';
      } catch (pageError: any) {
        logger.warn(`Could not extract text from page ${i}: ${pageError.message}`);
      }
    }

    logger.debug(`Extracted PDF text, length: ${fullText.length}`);

    if (!fullText || fullText.trim().length < 10) {
      return {
        text: '',
        error: 'PDF appears to be empty or contains only images. Please upload a text-based PDF.',
      };
    }

    return { text: fullText };
  } catch (error: any) {
    logger.error(`PDF text extraction failed: ${error.message}`);

    let userError = 'Could not read PDF file. Please try a different PDF.';
    if (error.message.includes('password') || error.message.includes('Password')) {
      userError = 'PDF is password protected. Please upload an unprotected PDF.';
    } else if (error.message.includes('Invalid') || error.message.includes('invalid')) {
      userError = 'PDF file format is invalid. Please try a different file.';
    }

    return { text: '', error: userError };
  }
}

/**
 * Primary method: Try to find and parse a VC JSON object directly from PDF text.
 * Looks for JSON containing "credentialSubject" which is the hallmark of a VC.
 */
function tryExtractJsonVC(text: string): Record<string, any> | null {
  // Try to find a JSON object containing credentialSubject
  // This handles PDFs that embed the raw VC JSON
  const patterns = [
    // Full VC JSON with credentialSubject
    /\{[\s\S]*?"credentialSubject"[\s\S]*?\}(?:\s*\})+/g,
    // Try finding JSON starting with @context
    /\{[\s\S]*?"@context"[\s\S]*?"credentialSubject"[\s\S]*?\}(?:\s*\})+/g,
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        try {
          const parsed = JSON.parse(match);
          // Verify it looks like a VC
          if (parsed.credentialSubject) {
            logger.info('Found valid VC JSON in PDF text');
            return parsed;
          }
        } catch {
          // Try to fix common JSON issues (truncated text, extra chars)
          try {
            // Remove trailing garbage after last }
            const cleaned = match.replace(/\}[^}]*$/, '}');
            const parsed = JSON.parse(cleaned);
            if (parsed.credentialSubject) {
              logger.info('Found valid VC JSON in PDF text (after cleanup)');
              return parsed;
            }
          } catch {
            // Continue to next match
          }
        }
      }
    }
  }

  // Also try: the entire text might be JSON
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed.credentialSubject) {
      return parsed;
    }
  } catch {
    // Not raw JSON
  }

  return null;
}

/**
 * Fallback method: Use OpenRouter LLM to extract VC fields from PDF text
 * and construct a minimal VC-like object.
 */
async function extractVCFieldsWithLLM(text: string): Promise<Record<string, any> | null> {
  if (!OPENROUTER_API_KEY) {
    logger.warn('No OpenRouter API key configured for LLM fallback');
    return null;
  }

  const prompt = `You are analyzing a document that contains a Verifiable Credential (VC) for an energy generation profile.

Extract the following fields from the document text. If a field is not found, use null.

Fields to extract:
- fullName: The name of the person/entity
- capacityKW: The generation/production capacity in kW (number)
- generationType: Type of energy generation (Solar, Wind, Hydro, etc.)
- meterNumber: The meter number/ID
- consumerNumber: The consumer number/ID
- commissioningDate: When the system was commissioned (YYYY-MM-DD format)

Respond ONLY with valid JSON (no markdown, no other text):
{"fullName": "...", "capacityKW": <number or null>, "generationType": "...", "meterNumber": "...", "consumerNumber": "...", "commissioningDate": "..."}

Document text:
---
${text.substring(0, 4000)}
---`;

  try {
    logger.info(`Calling OpenRouter LLM for VC field extraction (model: ${OPENROUTER_MODEL})`);

    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at extracting structured data from energy generation credential documents. Always respond with valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://p2p-energy-trading.local',
          'X-Title': 'P2P Energy Trading - VC PDF Analyzer',
        },
        timeout: 60000,
      },
    );

    const content = response.data.choices[0]?.message?.content || '';
    logger.debug(`LLM response: ${content}`);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const fields = JSON.parse(jsonMatch[0]);

    // Construct a minimal VC-like object from extracted fields
    const credential: Record<string, any> = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'GenerationProfileCredential'],
      issuer: 'extracted-from-pdf',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        type: 'GenerationProfileCredential',
        fullName: fields.fullName || null,
        capacityKW: fields.capacityKW != null ? String(fields.capacityKW) : null,
        generationType: fields.generationType || null,
        meterNumber: fields.meterNumber || null,
        consumerNumber: fields.consumerNumber || null,
        commissioningDate: fields.commissioningDate || null,
      },
    };

    // Only consider it successful if we got at least capacityKW
    if (fields.capacityKW != null && Number(fields.capacityKW) > 0) {
      logger.info(`LLM extraction succeeded: capacityKW=${fields.capacityKW}`);
      return credential;
    }

    logger.warn('LLM extraction did not find capacityKW');
    return null;
  } catch (error: any) {
    logger.error(`LLM extraction failed: ${error.message}`);
    return null;
  }
}

/**
 * Main function: Extract a Verifiable Credential from a PDF buffer.
 *
 * 1. Extract text from PDF
 * 2. Try to find JSON VC in text (primary)
 * 3. If no JSON found, use LLM to extract fields (fallback)
 */
export async function extractVCFromPdf(pdfBuffer: Buffer): Promise<VCExtractionResult> {
  // Step 1: Extract text from PDF
  const extractResult = await extractPdfText(pdfBuffer);

  if (extractResult.error) {
    return {
      success: false,
      credential: null,
      extractionMethod: 'json',
      error: extractResult.error,
    };
  }

  const text = extractResult.text;

  // Step 2: Try direct JSON extraction
  const jsonVC = tryExtractJsonVC(text);
  if (jsonVC) {
    return {
      success: true,
      credential: jsonVC,
      extractionMethod: 'json',
    };
  }

  logger.info('No JSON VC found in PDF text, trying LLM fallback...');

  // Step 3: LLM fallback
  const llmVC = await extractVCFieldsWithLLM(text);
  if (llmVC) {
    return {
      success: true,
      credential: llmVC,
      extractionMethod: 'llm',
    };
  }

  return {
    success: false,
    credential: null,
    extractionMethod: 'json',
    error: 'Could not extract a Verifiable Credential from this PDF. Please ensure the PDF contains a valid generation profile credential.',
  };
}
