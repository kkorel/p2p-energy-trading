/**
 * Meter PDF Analyzer using OpenRouter LLM
 * Extracts production capacity from utility meter reading PDFs
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@p2p/shared';

const logger = createLogger('MeterAnalyzer');

// OpenRouter configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
// Using a small, cheap model - can be changed to any OpenRouter model
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-3b-instruct:free';

export interface MeterAnalysisResult {
    success: boolean;
    extractedCapacity: number | null;  // kWh per month
    quality: 'HIGH' | 'MEDIUM' | 'LOW';
    matchesDeclaration: boolean;
    insights: string;
    error?: string;
}

/**
 * Extract text from PDF buffer using pdfjs-dist library
 */
async function extractPdfText(pdfBuffer: Buffer): Promise<{ text: string; error?: string }> {
    try {
        // Dynamic import of pdfjs-dist legacy build (more compatible with various PDFs)
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        
        // Convert Buffer to Uint8Array
        const uint8Array = new Uint8Array(pdfBuffer);
        
        // Load the PDF document with server-friendly options
        const loadingTask = pdfjsLib.getDocument({
            data: uint8Array,
            useSystemFonts: true,
            disableFontFace: true,  // Required for server-side (no DOM)
            verbosity: 0,           // Suppress warnings
            stopAtErrors: false,    // Continue even if there are minor errors
        });
        
        const pdfDoc = await loadingTask.promise;
        let fullText = '';
        
        // Extract text from each page
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
                // Continue with other pages
            }
        }
        
        logger.debug(`Extracted PDF text, length: ${fullText.length}`);
        logger.debug(`Text preview: ${fullText.substring(0, 300)}`);
        
        if (!fullText || fullText.trim().length < 20) {
            return { 
                text: '', 
                error: 'PDF appears to be empty or contains only images. Please upload a text-based PDF (not a scanned document).' 
            };
        }
        
        return { text: fullText };
    } catch (error: any) {
        logger.error(`PDF text extraction failed: ${error.message}`);
        
        // Provide user-friendly error messages
        let userError = 'Could not read PDF file. Please try a different PDF.';
        if (error.message.includes('password') || error.message.includes('Password')) {
            userError = 'PDF is password protected. Please upload an unprotected PDF.';
        } else if (error.message.includes('encrypt') || error.message.includes('Encrypt')) {
            userError = 'PDF is encrypted. Please upload an unencrypted PDF.';
        } else if (error.message.includes('Invalid') || error.message.includes('invalid')) {
            userError = 'PDF file format is invalid. Please try a different file.';
        } else if (error.message.includes('XRef') || error.message.includes('xref')) {
            userError = 'PDF structure is damaged. Please try opening the PDF in Adobe Reader, then use "Save As" to create a new copy.';
        }
        
        return { text: '', error: userError };
    }
}

/**
 * Analyze meter PDF using DeepSeek LLM
 */
export async function analyzeMeterPdf(
    pdfBuffer: Buffer,
    declaredCapacity: number
): Promise<MeterAnalysisResult> {
    if (!OPENROUTER_API_KEY) {
        logger.warn('No OpenRouter API key configured');
        return {
            success: false,
            extractedCapacity: null,
            quality: 'LOW',
            matchesDeclaration: false,
            insights: 'Meter analysis unavailable - API key not configured',
            error: 'OPENROUTER_API_KEY not set'
        };
    }

    try {
        // Extract text from PDF first
        const extractResult = await extractPdfText(pdfBuffer);
        
        // If PDF extraction failed with an error, return early with user-friendly message
        if (extractResult.error) {
            logger.warn(`PDF extraction error: ${extractResult.error}`);
            return {
                success: false,
                extractedCapacity: null,
                quality: 'LOW',
                matchesDeclaration: false,
                insights: extractResult.error,
                error: extractResult.error
            };
        }
        
        const pdfText = extractResult.text;
        
        if (!pdfText || pdfText.length < 50) {
            logger.warn('PDF text extraction returned minimal content');
        }

        const prompt = `You are analyzing an electricity meter reading document. 

${declaredCapacity > 0 ? `The user has declared a monthly production capacity of ${declaredCapacity} kWh.` : 'The user has not declared their capacity yet.'}

Please analyze this document and:
1. Extract the monthly electricity production/generation/consumption amount (in kWh)
2. Look for numbers followed by "kWh", "units", "kwh", or similar
3. Rate the data quality (HIGH/MEDIUM/LOW based on document clarity)

Respond ONLY in valid JSON format (no other text, no markdown):
{"extractedCapacity": <number or null if not found>, "matchesDeclaration": ${declaredCapacity > 0 ? '<true if within 20% of declared, false otherwise>' : 'false'}, "quality": "<HIGH|MEDIUM|LOW>", "insights": "<brief summary of findings>"}

Document text extracted from meter reading PDF:
---
${pdfText.substring(0, 4000)}
---`;

        logger.info(`Calling OpenRouter API with model: ${OPENROUTER_MODEL}`);
        logger.debug(`PDF text preview: ${pdfText.substring(0, 500)}`);

        let apiExtractedCapacity: number | null = null;
        let apiQuality: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
        let apiInsights = '';

        try {
            const response = await axios.post(
                `${OPENROUTER_BASE_URL}/chat/completions`,
                {
                    model: OPENROUTER_MODEL,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are an expert at analyzing utility meter documents and extracting electricity production data. Always respond with valid JSON only.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.2,
                    max_tokens: 500
                },
                {
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://p2p-energy-trading.local',
                        'X-Title': 'P2P Energy Trading - Meter Analyzer'
                    },
                    timeout: 60000
                }
            );

            const content = response.data.choices[0]?.message?.content || '';
            logger.debug(`API response content: ${content}`);

            // Parse JSON from response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                apiExtractedCapacity = parsed.extractedCapacity || null;
                apiQuality = parsed.quality || 'MEDIUM';
                apiInsights = parsed.insights || '';
            }
        } catch (apiError: any) {
            logger.warn(`API call failed: ${apiError?.response?.data ? JSON.stringify(apiError.response.data) : apiError?.message}`);
        }

        // If API extracted a value, use it
        if (apiExtractedCapacity && apiExtractedCapacity > 0) {
            logger.info(`API extraction succeeded: ${apiExtractedCapacity} kWh`);
            return {
                success: true,
                extractedCapacity: apiExtractedCapacity,
                quality: apiQuality,
                matchesDeclaration: declaredCapacity > 0 && Math.abs(apiExtractedCapacity - declaredCapacity) / declaredCapacity < 0.2,
                insights: apiInsights || `Extracted ${apiExtractedCapacity} kWh from meter reading`
            };
        }

        // FALLBACK: Use regex extraction from PDF text
        logger.info('API did not extract value, trying regex fallback...');
        const regexResult = extractCapacityWithRegex(pdfText);
        
        if (regexResult) {
            logger.info(`Regex fallback succeeded: ${regexResult} kWh`);
            return {
                success: true,
                extractedCapacity: regexResult,
                quality: 'MEDIUM',
                matchesDeclaration: declaredCapacity > 0 && Math.abs(regexResult - declaredCapacity) / declaredCapacity < 0.2,
                insights: `Extracted ${regexResult} kWh from document`
            };
        }

        // Both methods failed
        logger.warn('Both API and regex extraction failed');
        return {
            success: false,
            extractedCapacity: null,
            quality: 'LOW',
            matchesDeclaration: false,
            insights: 'Could not extract capacity from document'
        };

    } catch (error: any) {
        logger.error(`Critical error: ${error?.message || error}`);
        return {
            success: false,
            extractedCapacity: null,
            quality: 'LOW',
            matchesDeclaration: false,
            insights: 'Error analyzing document',
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Fallback: Extract capacity using regex patterns when API fails
 */
function extractCapacityWithRegex(text: string): number | null {
    // Common patterns for energy values in meter documents
    const patterns = [
        /Total\s+Energy\s+Supplied\s+to\s+Grid\s*[:=]?\s*([\d,]+)\s*(?:kWh)?/i,
        /Energy\s+Supplied\s*[:=]?\s*([\d,]+)\s*(?:kWh)?/i,
        /Total\s+Generation\s*[:=]?\s*([\d,]+)\s*(?:kWh)?/i,
        /Electricity\s+Produced\s*[:=]?\s*([\d,]+)\s*(?:kWh)?/i,
        /Production\s+Capacity\s*[:=]?\s*([\d,]+)\s*(?:kWh)?/i,
        /Monthly\s+Production\s*[:=]?\s*([\d,]+)\s*(?:kWh)?/i,
        /Net\s+Energy\s+Exported\s*[:=]?\s*([\d,]+)\s*(?:kWh)?/i,
        /([\d,]+)\s*kWh/i, // Generic kWh pattern
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            const value = parseInt(match[1].replace(/,/g, ''), 10);
            if (value > 0 && value < 1000000) { // Reasonable range
                logger.debug(`Regex matched pattern: ${pattern}, value: ${value}`);
                return value;
            }
        }
    }
    
    return null;
}

/**
 * Determine quality score based on how well extracted data matches declaration
 */
export function determineMeterQuality(
    declaredCapacity: number,
    extractedCapacity: number | null
): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (!extractedCapacity) return 'LOW';

    const ratio = extractedCapacity / declaredCapacity;

    // Within 10% = HIGH quality match
    if (ratio >= 0.9 && ratio <= 1.1) return 'HIGH';

    // Within 20% = MEDIUM quality match
    if (ratio >= 0.8 && ratio <= 1.2) return 'MEDIUM';

    // Outside 20% = LOW quality (mismatch)
    return 'LOW';
}

/**
 * Save uploaded PDF to storage
 */
export async function saveMeterPdf(
    userId: string,
    pdfBuffer: Buffer
): Promise<string> {
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(process.cwd(), 'uploads', 'meter-pdfs');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filename = `${userId}_${Date.now()}.pdf`;
    const filepath = path.join(uploadsDir, filename);

    fs.writeFileSync(filepath, pdfBuffer);

    return `/uploads/meter-pdfs/${filename}`;
}
