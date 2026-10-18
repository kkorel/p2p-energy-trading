/**
 * Authentication Routes
 * Handles phone + OTP authentication
 */

import { Router, Request, Response } from 'express';
import {
  prisma,
  sendOtp,
  verifyOtpAndAuthenticate,
  createSession,
  deleteSession,
  deleteAllUserSessions,
  createLogger,
  analyzeInstallation,
  getHeatmapImageUrl,
  SolarAnalysis,
} from '@p2p/shared';
import { authMiddleware, devModeOnly } from './middleware';
import { sendFirstLoginWelcome } from './chat/notifications';

const logger = createLogger('Auth');

/**
 * Parse date from various formats (DD-MM-YYYY, YYYY-MM-DD, ISO, etc.)
 */
function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  // Try DD-MM-YYYY format first (common in Indian VCs)
  const ddmmyyyy = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (!isNaN(date.getTime())) return date;
  }

  // Try standard Date parsing (ISO, YYYY-MM-DD, etc.)
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) return date;

  return null;
}

/**
 * Run solar analysis on a user's installation address.
 * Updates UserSolarAnalysis and sets allowedTradeLimit (7-15%).
 * Called during onboarding when UtilityCustomerCredential is verified.
 */
async function runSolarAnalysisForUser(
  userId: string,
  installationAddress: string
): Promise<SolarAnalysis | null> {
  try {
    logger.info(`Running solar analysis for user ${userId}`, { address: installationAddress });

    // Call Google Solar API
    const analysis = await analyzeInstallation(installationAddress);

    // Get heatmap image URL if we have coordinates
    let satelliteImageUrl: string | null = null;
    if (analysis.location?.lat && analysis.location?.lon) {
      satelliteImageUrl = await getHeatmapImageUrl(analysis.location.lat, analysis.location.lon);
    }

    // Upsert UserSolarAnalysis record
    await prisma.userSolarAnalysis.upsert({
      where: { userId },
      create: {
        userId,
        available: analysis.available,
        latitude: analysis.location?.lat || null,
        longitude: analysis.location?.lon || null,
        formattedAddress: analysis.location?.formattedAddress || null,
        maxSunshineHours: analysis.maxSunshineHours || null,
        maxPanelCount: analysis.maxPanelCount || null,
        yearlyEnergyKwh: analysis.yearlyEnergyKwh || null,
        roofAreaM2: analysis.roofAreaM2 || null,
        imageryQuality: analysis.imageryQuality || null,
        carbonOffsetKg: analysis.carbonOffsetKg || null,
        installationScore: analysis.installationScore,
        tradingLimitPercent: analysis.tradingLimitPercent,
        verificationMethod: analysis.verificationMethod,
        errorReason: analysis.errorReason || null,
        satelliteImageUrl,
        analyzedAt: analysis.analyzedAt,
      },
      update: {
        available: analysis.available,
        latitude: analysis.location?.lat || null,
        longitude: analysis.location?.lon || null,
        formattedAddress: analysis.location?.formattedAddress || null,
        maxSunshineHours: analysis.maxSunshineHours || null,
        maxPanelCount: analysis.maxPanelCount || null,
        yearlyEnergyKwh: analysis.yearlyEnergyKwh || null,
        roofAreaM2: analysis.roofAreaM2 || null,
        imageryQuality: analysis.imageryQuality || null,
        carbonOffsetKg: analysis.carbonOffsetKg || null,
        installationScore: analysis.installationScore,
        tradingLimitPercent: analysis.tradingLimitPercent,
        verificationMethod: analysis.verificationMethod,
        errorReason: analysis.errorReason || null,
        satelliteImageUrl,
        analyzedAt: analysis.analyzedAt,
      },
    });

    // Update user's allowedTradeLimit based on solar analysis (7-15%)
    await prisma.user.update({
      where: { id: userId },
      data: { allowedTradeLimit: analysis.tradingLimitPercent },
    });

    logger.info(`Solar analysis complete for user ${userId}`, {
      available: analysis.available,
      tradingLimit: analysis.tradingLimitPercent,
      score: analysis.installationScore,
      verificationMethod: analysis.verificationMethod,
    });

    return analysis;
  } catch (error: any) {
    logger.error(`Solar analysis failed for user ${userId}: ${error.message}`);
    // Don't fail the onboarding - just use default limit
    return null;
  }
}

const router = Router();

/**
 * POST /auth/send-otp
 * Send OTP to phone number
 */
router.post('/send-otp', async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required',
      });
    }

    const result = await sendOtp(phone);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.message,
      });
    }

    res.json({ success: true, message: result.message });
  } catch (error: any) {
    logger.error(`Send OTP error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to send OTP. Please try again.',
    });
  }
});

/**
 * GET /auth/check-phone/:phone
 * Check if a phone number is already registered (for returning user UX)
 */
router.get('/check-phone/:phone', async (req: Request, res: Response) => {
  try {
    const { phone } = req.params;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required',
      });
    }

    // Normalize phone number (strip spaces/dashes)
    const normalized = phone.replace(/[\s-]/g, '');

    // Check if user exists
    const user = await prisma.user.findFirst({
      where: { phone: normalized },
      select: { id: true, name: true, profileComplete: true },
    });

    res.json({
      success: true,
      exists: !!user,
      name: user?.name || null,
      profileComplete: user?.profileComplete || false,
    });
  } catch (error: any) {
    logger.error(`Check phone error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to check phone number',
    });
  }
});

/**
 * POST /auth/verify-otp
 * Verify OTP and authenticate user
 */
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { phone, otp, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and OTP are required',
      });
    }

    const result = await verifyOtpAndAuthenticate(phone, otp, name);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.message,
      });
    }

    // Check for required VCs (minimum 2: Utility + one role VC)
    const userVCs = await prisma.userCredential.findMany({
      where: { userId: result.userId!, verified: true }
    });

    const hasUtilityVC = userVCs.some(vc => vc.credentialType === 'UTILITY_CUSTOMER');
    const hasRoleVC = userVCs.some(vc =>
      ['GENERATION_PROFILE', 'STORAGE_PROFILE', 'CONSUMPTION_PROFILE'].includes(vc.credentialType)
    );

    const missingVCs: string[] = [];
    if (!hasUtilityVC) missingVCs.push('UTILITY_CUSTOMER');
    if (!hasRoleVC) missingVCs.push('GENERATION_PROFILE or STORAGE_PROFILE or CONSUMPTION_PROFILE');

    if (missingVCs.length > 0) {
      logger.info(`User ${result.userId} missing required VCs: ${missingVCs.join(', ')}`);
      return res.status(403).json({
        success: false,
        error: 'Credentials required for signup',
        requiresVC: missingVCs,
        userId: result.userId,
        isNewUser: result.isNewUser,
        message: 'Upload Utility VC and at least one role credential (Generation/Storage for selling, Consumption for buying)',
      });
    }

    // Create session
    const session = await createSession({
      userId: result.userId!,
      deviceInfo: req.headers['user-agent'],
      ipAddress: req.ip || req.socket.remoteAddress,
    });

    // Get full user details
    const user = await prisma.user.findUnique({
      where: { id: result.userId },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            trustScore: true,
          },
        },
      },
    });

    // Send proactive WhatsApp welcome on first login (fire-and-forget)
    // This triggers once per user - the function checks whatsappWelcomeSent flag
    if (result.isNewUser || !user!.profileComplete) {
      // Don't await - let it run in background
      sendFirstLoginWelcome(user!.id).catch(err => {
        logger.warn(`Background WhatsApp welcome failed: ${err.message}`);
      });
    }

    res.json({
      success: true,
      message: result.message,
      token: session.token,
      expiresAt: session.expiresAt,
      isNewUser: result.isNewUser,
      user: {
        id: user!.id,
        phone: user!.phone,
        name: user!.name,
        profileComplete: user!.profileComplete,
        balance: user!.balance,
        providerId: user!.providerId,
        provider: user!.provider,
        trustScore: user!.trustScore,
        allowedTradeLimit: user!.allowedTradeLimit,
        meterDataAnalyzed: user!.meterDataAnalyzed,
        productionCapacity: user!.productionCapacity,
        meterVerifiedCapacity: user!.meterVerifiedCapacity,
      },
    });
  } catch (error: any) {
    logger.error(`Verify OTP error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Authentication failed. Please try again.',
    });
  }
});

/**
 * POST /auth/complete-signup
 * Complete signup after VCs have been uploaded (no OTP needed)
 * Called after user uploads required VCs during onboarding
 */
router.post('/complete-signup', async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            trustScore: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found. Please restart signup.',
      });
    }

    // Check for required VCs
    const userVCs = await prisma.userCredential.findMany({
      where: { userId, verified: true }
    });

    const hasUtilityVC = userVCs.some(vc => vc.credentialType === 'UTILITY_CUSTOMER');
    const hasRoleVC = userVCs.some(vc =>
      ['GENERATION_PROFILE', 'STORAGE_PROFILE', 'CONSUMPTION_PROFILE'].includes(vc.credentialType)
    );

    if (!hasUtilityVC || !hasRoleVC) {
      const missingVCs: string[] = [];
      if (!hasUtilityVC) missingVCs.push('UTILITY_CUSTOMER');
      if (!hasRoleVC) missingVCs.push('GENERATION_PROFILE or STORAGE_PROFILE or CONSUMPTION_PROFILE');

      return res.status(403).json({
        success: false,
        error: 'Required credentials still missing',
        requiresVC: missingVCs,
        userId,
      });
    }

    // Mark profile as complete since VCs are verified
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { profileComplete: true },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            trustScore: true,
          },
        },
      },
    });

    // Create session
    const session = await createSession({
      userId,
      deviceInfo: req.headers['user-agent'],
      ipAddress: req.ip || req.socket.remoteAddress,
    });

    // Send proactive WhatsApp welcome (fire-and-forget)
    sendFirstLoginWelcome(userId).catch(err => {
      logger.warn(`Background WhatsApp welcome failed: ${err.message}`);
    });

    logger.info(`User ${userId} completed signup with VCs, profileComplete=true`);

    res.json({
      success: true,
      message: 'Signup completed successfully',
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        id: updatedUser.id,
        phone: updatedUser.phone,
        name: updatedUser.name,
        profileComplete: updatedUser.profileComplete,
        balance: updatedUser.balance,
        providerId: updatedUser.providerId,
        provider: updatedUser.provider,
        trustScore: updatedUser.trustScore,
        allowedTradeLimit: updatedUser.allowedTradeLimit,
        meterDataAnalyzed: updatedUser.meterDataAnalyzed,
        productionCapacity: updatedUser.productionCapacity,
        meterVerifiedCapacity: updatedUser.meterVerifiedCapacity,
      },
    });
  } catch (error: any) {
    logger.error(`Complete signup error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to complete signup.',
    });
  }
});

/**
 * POST /auth/verify-credential-preauth
 * Upload VC before having a session (during signup flow when 2 VCs are required)
 * Uses userId from verify-otp 403 response instead of auth token
 */
router.post('/verify-credential-preauth', async (req: Request, res: Response) => {
  try {
    const { userId, pdfBase64, credential: jsonCredential } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required (from verify-otp response)',
      });
    }

    if (!pdfBase64 && !jsonCredential) {
      return res.status(400).json({
        success: false,
        error: 'Either a PDF file (base64) or a JSON credential is required',
      });
    }

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, consumerNumber: true, installationAddress: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found. Please restart the signup process.',
      });
    }

    let credential: Record<string, any>;
    let extractionMethod: 'json' | 'llm' | 'direct' = 'direct';

    if (jsonCredential && typeof jsonCredential === 'object') {
      credential = jsonCredential;
    } else if (pdfBase64 && typeof pdfBase64 === 'string') {
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const { extractVCFromPdf } = await import('./vc-pdf-analyzer');
      const extraction = await extractVCFromPdf(pdfBuffer);
      if (!extraction.success || !extraction.credential) {
        return res.status(400).json({
          success: false,
          error: extraction.error || 'Could not extract a VC from this PDF.',
        });
      }
      credential = extraction.credential;
      extractionMethod = extraction.extractionMethod;
    } else {
      return res.status(400).json({ success: false, error: 'Invalid input.' });
    }

    const {
      verifyCredential: vcVerify,
      detectCredentialType,
      extractNormalizedGenerationClaims,
      extractNormalizedUtilityCustomerClaims,
      extractNormalizedConsumptionProfileClaims,
      extractNormalizedStorageProfileClaims,
      extractNormalizedProgramEnrollmentClaims,
      extractCapacity,
      getIssuerId,
      getIssuanceDate,
    } = await import('@p2p/shared');

    // Auto-detect credential type
    const credType = detectCredentialType(credential as any);
    if (!credType) {
      return res.status(400).json({
        success: false,
        error: 'Could not detect credential type. Supported: UtilityCustomerCredential, ConsumptionProfileCredential, GenerationProfileCredential, StorageProfileCredential, UtilityProgramEnrollmentCredential',
      });
    }

    // Run verification
    const verificationResult = await vcVerify(credential);

    // Map DEG type to Prisma enum
    const PRISMA_TYPE_MAP: Record<string, string> = {
      'UtilityCustomerCredential': 'UTILITY_CUSTOMER',
      'ConsumptionProfileCredential': 'CONSUMPTION_PROFILE',
      'GenerationProfileCredential': 'GENERATION_PROFILE',
      'StorageProfileCredential': 'STORAGE_PROFILE',
      'UtilityProgramEnrollmentCredential': 'PROGRAM_ENROLLMENT',
    };
    const prismaCredType = PRISMA_TYPE_MAP[credType];

    // Extract claims and build User update
    let claims: Record<string, any> = {};
    const userUpdate: Record<string, any> = {};

    switch (credType) {
      case 'UtilityCustomerCredential': {
        claims = extractNormalizedUtilityCustomerClaims(credential as any);
        if (claims.fullName && !user.name) userUpdate.name = claims.fullName;
        if (claims.consumerNumber) userUpdate.consumerNumber = claims.consumerNumber;
        if (claims.meterNumber) userUpdate.meterNumber = claims.meterNumber;
        if (claims.installationAddress) userUpdate.installationAddress = claims.installationAddress;
        if (claims.serviceConnectionDate) {
          const parsedDate = parseDate(claims.serviceConnectionDate);
          if (parsedDate) userUpdate.serviceConnectionDate = parsedDate;
        }
        break;
      }
      case 'ConsumptionProfileCredential': {
        claims = extractNormalizedConsumptionProfileClaims(credential as any);
        if (claims.premisesType) userUpdate.premisesType = claims.premisesType;
        if (claims.connectionType) userUpdate.connectionType = claims.connectionType;
        if (claims.sanctionedLoadKW) userUpdate.sanctionedLoadKW = claims.sanctionedLoadKW;
        if (claims.tariffCategoryCode) userUpdate.tariffCategoryCode = claims.tariffCategoryCode;
        break;
      }
      case 'GenerationProfileCredential': {
        claims = extractNormalizedGenerationClaims(credential as any);
        const capacityKW = extractCapacity(credential as any);
        if (capacityKW && capacityKW > 0) {
          const AVG_PEAK_SUN_HOURS = 4.5;
          const DAYS_PER_MONTH = 30;
          userUpdate.productionCapacity = capacityKW * AVG_PEAK_SUN_HOURS * DAYS_PER_MONTH;
        }
        break;
      }
      case 'StorageProfileCredential': {
        claims = extractNormalizedStorageProfileClaims(credential as any);
        if (claims.storageCapacityKWh) userUpdate.storageCapacityKWh = claims.storageCapacityKWh;
        if (claims.powerRatingKW) userUpdate.storagePowerRatingKW = claims.powerRatingKW;
        if (claims.storageType) userUpdate.storageType = claims.storageType;
        break;
      }
      case 'UtilityProgramEnrollmentCredential': {
        claims = extractNormalizedProgramEnrollmentClaims(credential as any);
        if (claims.programName) userUpdate.programName = claims.programName;
        if (claims.programCode) userUpdate.programCode = claims.programCode;
        if (claims.enrollmentDate) {
          userUpdate.programEnrollmentDate = new Date(claims.enrollmentDate);
        }
        if (claims.validUntil) {
          userUpdate.programValidUntil = new Date(claims.validUntil);
        }
        break;
      }
    }

    // Upsert UserCredential record
    const issuerId = getIssuerId(credential.issuer || '');
    const issuanceDateStr = getIssuanceDate(credential as any);

    await prisma.userCredential.upsert({
      where: {
        userId_credentialType: {
          userId: userId,
          credentialType: prismaCredType as any,
        },
      },
      create: {
        userId: userId,
        credentialType: prismaCredType as any,
        rawJson: JSON.stringify(credential),
        verified: verificationResult.verified,
        verifiedAt: verificationResult.verified ? new Date() : null,
        extractedClaims: JSON.stringify(claims),
        issuerId: issuerId || null,
        issuanceDate: issuanceDateStr ? new Date(issuanceDateStr) : null,
      },
      update: {
        rawJson: JSON.stringify(credential),
        verified: verificationResult.verified,
        verifiedAt: verificationResult.verified ? new Date() : null,
        extractedClaims: JSON.stringify(claims),
        issuerId: issuerId || null,
        issuanceDate: issuanceDateStr ? new Date(issuanceDateStr) : null,
      },
    });

    // Update User fields
    if (Object.keys(userUpdate).length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: userUpdate,
      });
    }

    // Auto-create Provider for Generation/Storage VCs
    if ((credType === 'GenerationProfileCredential' || credType === 'StorageProfileCredential') && verificationResult.verified) {
      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { providerId: true, name: true, consumerNumber: true, installationAddress: true },
      });

      if (!currentUser?.providerId) {
        const providerId = `provider-${userId}`;
        await prisma.provider.create({
          data: {
            id: providerId,
            name: currentUser?.name || 'Energy Provider',
            // From Generation VC
            generationType: claims.generationType || claims.sourceType || null,
            capacityKW: claims.capacityKW || null,
            generationMeterNumber: claims.meterNumber || null,
            commissioningDate: claims.commissioningDate ? parseDate(claims.commissioningDate) : null,
            // From Storage VC
            storageCapacityKWh: claims.storageCapacityKWh || null,
            storagePowerRatingKW: claims.powerRatingKW || null,
            storageType: claims.storageType || null,
            // From Utility VC (via User)
            consumerNumber: currentUser?.consumerNumber || null,
            installationAddress: currentUser?.installationAddress || null,
          },
        });

        await prisma.user.update({
          where: { id: userId },
          data: { providerId },
        });

        logger.info(`Auto-created Provider ${providerId} for user ${userId} from ${credType}`);
      }
    }

    // Run solar analysis when UtilityCustomerCredential is verified (has address)
    // This sets the initial trading limit (7-15%) based on solar potential
    if (credType === 'UtilityCustomerCredential' && verificationResult.verified && claims.installationAddress) {
      logger.info(`Triggering solar analysis for user ${userId} (UtilityCustomerCredential with address)`);
      // Run solar analysis in background (fire-and-forget for fast response)
      // The trading limit will be updated asynchronously
      runSolarAnalysisForUser(userId, claims.installationAddress).then(result => {
        if (result) {
          logger.info(`✓ Solar analysis completed for user ${userId}: limit=${result.tradingLimitPercent}%, score=${result.installationScore.toFixed(2)}`);
        }
      }).catch(err => {
        logger.warn(`Background solar analysis failed for user ${userId}: ${err.message}`);
      });
    }

    // Also trigger solar analysis when Generation/Storage VC is verified if:
    // 1. User already has an installation address (from previous Utility VC)
    // 2. No solar analysis has been done yet
    if ((credType === 'GenerationProfileCredential' || credType === 'StorageProfileCredential') && verificationResult.verified) {
      const userWithAddress = await prisma.user.findUnique({
        where: { id: userId },
        select: { installationAddress: true, solarAnalysis: true },
      });

      if (userWithAddress?.installationAddress && !userWithAddress.solarAnalysis) {
        logger.info(`Triggering solar analysis for user ${userId} (${credType} with existing address, no prior analysis)`);
        runSolarAnalysisForUser(userId, userWithAddress.installationAddress).then(result => {
          if (result) {
            logger.info(`✓ Solar analysis completed for user ${userId}: limit=${result.tradingLimitPercent}%, score=${result.installationScore.toFixed(2)}`);
          }
        }).catch(err => {
          logger.warn(`Background solar analysis failed for user ${userId}: ${err.message}`);
        });
      }
    }

    // Fetch all credentials to return status
    const allCredentials = await prisma.userCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    const hasUtilityVC = allCredentials.some(c => c.credentialType === 'UTILITY_CUSTOMER' && c.verified);
    const hasRoleVC = allCredentials.some(c =>
      ['GENERATION_PROFILE', 'STORAGE_PROFILE', 'CONSUMPTION_PROFILE'].includes(c.credentialType) && c.verified
    );

    logger.info(`Pre-auth: User ${userId} verified ${credType}: method=${extractionMethod}, verified=${verificationResult.verified}`);

    res.json({
      success: true,
      credentialType: prismaCredType, // Return Prisma enum name for frontend
      verification: {
        verified: verificationResult.verified,
        checks: verificationResult.checks,
        extractionMethod,
      },
      extractedClaims: claims,
      credentials: allCredentials.map(c => ({
        type: c.credentialType,
        verified: c.verified,
        verifiedAt: c.verifiedAt,
      })),
      signupReady: hasUtilityVC && hasRoleVC,
      missing: {
        utilityVC: !hasUtilityVC,
        roleVC: !hasRoleVC,
      },
    });
  } catch (error: any) {
    logger.error(`Pre-auth verify credential error: ${error}`);
    res.status(500).json({ success: false, error: 'Failed to verify credential.' });
  }
});

/**
 * POST /auth/logout
 * Logout current session
 */
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (req.sessionToken) {
      await deleteSession(req.sessionToken);
    }

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error: any) {
    logger.error(`Logout error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Logout failed',
    });
  }
});

/**
 * POST /auth/logout-all
 * Logout all sessions for current user
 */
router.post('/logout-all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const count = await deleteAllUserSessions(req.user!.id);

    res.json({
      success: true,
      message: `Logged out from ${count} session(s)`,
      sessionsTerminated: count,
    });
  } catch (error: any) {
    logger.error(`Logout all error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Logout failed',
    });
  }
});

/**
 * GET /auth/me
 * Get current user info
 */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            trustScore: true,
            totalOrders: true,
            successfulOrders: true,
          },
        },
        solarAnalysis: true, // Include solar analysis data
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        profileComplete: user.profileComplete,
        balance: user.balance,
        providerId: user.providerId,
        provider: user.provider,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        trustScore: user.trustScore,
        allowedTradeLimit: user.allowedTradeLimit,
        meterDataAnalyzed: user.meterDataAnalyzed,
        productionCapacity: user.productionCapacity,
        meterVerifiedCapacity: user.meterVerifiedCapacity,
        // Solar analysis data (for profile display)
        solarAnalysis: user.solarAnalysis ? {
          available: user.solarAnalysis.available,
          location: user.solarAnalysis.latitude && user.solarAnalysis.longitude ? {
            lat: user.solarAnalysis.latitude,
            lon: user.solarAnalysis.longitude,
            formattedAddress: user.solarAnalysis.formattedAddress,
          } : null,
          maxSunshineHours: user.solarAnalysis.maxSunshineHours,
          yearlyEnergyKwh: user.solarAnalysis.yearlyEnergyKwh,
          roofAreaM2: user.solarAnalysis.roofAreaM2,
          imageryQuality: user.solarAnalysis.imageryQuality,
          carbonOffsetKg: user.solarAnalysis.carbonOffsetKg,
          installationScore: user.solarAnalysis.installationScore,
          tradingLimitPercent: user.solarAnalysis.tradingLimitPercent,
          verificationMethod: user.solarAnalysis.verificationMethod,
          satelliteImageUrl: user.solarAnalysis.satelliteImageUrl,
          analyzedAt: user.solarAnalysis.analyzedAt,
        } : null,
      },
    });
  } catch (error: any) {
    logger.error(`Get me error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get user info',
    });
  }
});

/**
 * PUT /auth/profile
 * Update user profile
 */
router.put('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, productionCapacity } = req.body;

    // Validate input
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2)) {
      return res.status(400).json({
        success: false,
        error: 'Name must be at least 2 characters',
      });
    }

    if (productionCapacity !== undefined && (typeof productionCapacity !== 'number' || productionCapacity < 0)) {
      return res.status(400).json({
        success: false,
        error: 'Production capacity must be a non-negative number (kWh per month)',
      });
    }

    // Update user
    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (productionCapacity !== undefined) updateData.productionCapacity = productionCapacity;

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: updateData,
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            trustScore: true,
          },
        },
      },
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        profileComplete: user.profileComplete,
        balance: user.balance,
        providerId: user.providerId,
        provider: user.provider,
        trustScore: user.trustScore,
        allowedTradeLimit: user.allowedTradeLimit,
        productionCapacity: user.productionCapacity,
        meterVerifiedCapacity: user.meterVerifiedCapacity,
        meterDataAnalyzed: user.meterDataAnalyzed,
      },
    });
  } catch (error: any) {
    logger.error(`Update profile error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile',
    });
  }
});

/**
 * POST /auth/setup-provider
 * Create or link provider profile for the user
 */
router.post('/setup-provider', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Provider name is required (at least 2 characters)',
      });
    }

    // Check if user already has a provider
    if (req.user!.providerId) {
      return res.status(400).json({
        success: false,
        error: 'You already have a seller profile',
      });
    }

    // Create provider and link to user
    const providerId = `provider-${req.user!.id}`;

    const provider = await prisma.provider.create({
      data: {
        id: providerId,
        name: name.trim(),
        trustScore: 0.5, // Starting trust score
      },
    });

    // Link provider to user
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { providerId: provider.id },
    });

    res.json({
      success: true,
      message: 'Seller profile created successfully',
      provider: {
        id: provider.id,
        name: provider.name,
        trustScore: provider.trustScore,
      },
    });
  } catch (error: any) {
    logger.error(`Setup provider error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to create seller profile',
    });
  }
});

/**
 * GET /auth/balance
 * Get current user's balance
 */
router.get('/balance', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { balance: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      balance: user.balance,
    });
  } catch (error: any) {
    logger.error(`Get balance error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get balance',
    });
  }
});

/**
 * PUT /auth/balance
 * Set user balance (for demo purposes)
 */
router.put('/balance', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { balance } = req.body;

    if (typeof balance !== 'number' || balance < 0) {
      return res.status(400).json({
        success: false,
        error: 'Balance must be a non-negative number',
      });
    }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { balance: Math.round(balance * 100) / 100 },
      select: { balance: true },
    });

    res.json({
      success: true,
      balance: user.balance,
    });
  } catch (error: any) {
    logger.error(`Update balance error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to update balance',
    });
  }
});

/**
 * POST /auth/payment
 * Verify payment was escrowed for an order
 * NOTE: Actual payment deduction happens in /confirm (escrow)
 *       Seller payment happens after DISCOM verification
 * FIXED: Now waits for paymentStatus=ESCROWED before returning balance
 */
router.post('/payment', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { orderId, amount, sellerId } = req.body;
    const buyerId = req.user!.id;

    if (!orderId || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment parameters',
      });
    }

    // Wait for order payment status to be ESCROWED (up to 5 seconds)
    // This handles the race condition where confirm uses setTimeout
    const maxWaitMs = 5000;
    const pollIntervalMs = 200;
    const startTime = Date.now();
    
    let order = null;
    while (Date.now() - startTime < maxWaitMs) {
      order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          paymentStatus: true,
          buyerId: true,
          totalPrice: true,
        },
      });

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found',
        });
      }

      // If payment is already escrowed, break out of loop
      if (order.paymentStatus === 'ESCROWED') {
        break;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    // Get buyer's CURRENT balance (after potential escrow deduction)
    const buyer = await prisma.user.findUnique({
      where: { id: buyerId },
      select: { balance: true },
    });

    if (!buyer) {
      return res.status(404).json({
        success: false,
        error: 'Buyer not found',
      });
    }

    // Payment is handled via escrow in /confirm
    // Seller will be paid after DISCOM verification
    // This endpoint confirms the escrow status and returns CURRENT balance

    res.json({
      success: true,
      message: 'Payment escrowed successfully. Seller will be paid after delivery verification.',
      payment: {
        orderId,
        amount,
        status: order?.paymentStatus || 'PENDING',
        // Seller is NOT paid yet - paid after DISCOM verification
        sellerReceived: 0,
        note: 'Seller payment pending delivery verification',
      },
      newBalance: buyer.balance,
    });
  } catch (error: any) {
    logger.error(`Payment verification error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Payment verification failed',
    });
  }
});


/**
 * POST /auth/analyze-meter
 * Analyze meter PDF to extract production capacity and auto-set it
 * Successful analysis gives +10% trust score bonus
 */
router.post('/analyze-meter', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pdfBase64 } = req.body;

    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'PDF file is required (base64 encoded)',
      });
    }

    // Get current user data for reference
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { meterDataAnalyzed: true, trustScore: true, productionCapacity: true },
    });

    // Check if user has EVER received the meter verification trust bonus
    // This is the definitive check - even if meterDataAnalyzed gets reset, we don't give bonus twice
    const existingMeterBonus = await prisma.trustScoreHistory.findFirst({
      where: {
        userId: req.user!.id,
        reason: 'METER_VERIFIED',
      },
    });
    const hasAlreadyReceivedMeterBonus = existingMeterBonus !== null;

    // Import the analyzer
    const { analyzeMeterPdf, saveMeterPdf } = await import('./meter-analyzer');

    // Decode the base64 PDF
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');

    // Save the PDF for record-keeping
    const pdfPath = await saveMeterPdf(req.user!.id, pdfBuffer);

    // Use existing capacity as reference, or 0 if not set (will extract from PDF)
    const declaredCapacity = currentUser?.productionCapacity || 0;

    // Analyze the PDF using OpenRouter
    const analysisResult = await analyzeMeterPdf(pdfBuffer, declaredCapacity);

    // Only give trust bonus if user has NEVER received it before (check history, not just flag)
    const isFirstVerification = !hasAlreadyReceivedMeterBonus;

    // Update user based on analysis result
    const updateData: any = {
      meterPdfUrl: pdfPath, // Store the PDF path
    };

    let trustBonus = 0;
    let message = '';
    let extractedCapacity: number | null = null;

    if (analysisResult.success && analysisResult.extractedCapacity) {
      extractedCapacity = analysisResult.extractedCapacity;

      // Always mark as analyzed on successful verification
      updateData.meterDataAnalyzed = true;

      // Store the extracted capacity as verified
      updateData.meterVerifiedCapacity = extractedCapacity;

      // AUTO-SET production capacity from the meter reading!
      updateData.productionCapacity = extractedCapacity;

      // Only give trust bonus on FIRST successful verification
      if (isFirstVerification) {
        if (declaredCapacity > 0 && analysisResult.matchesDeclaration) {
          // Had existing capacity and it matches - give full 10% trust bonus
          trustBonus = 0.10;
          message = `Great! Your meter reading (${extractedCapacity} kWh) matches your declaration. Production capacity confirmed. +10% trust bonus!`;
        } else if (declaredCapacity > 0 && analysisResult.quality === 'MEDIUM') {
          // Had existing capacity, partial match - give 7% bonus
          trustBonus = 0.07;
          message = `Meter shows ${extractedCapacity} kWh/month. Production capacity updated. +7% trust bonus!`;
        } else {
          // No prior declaration OR new extraction - give full 10% for verified meter data
          trustBonus = 0.10;
          message = `Production capacity auto-set to ${extractedCapacity} kWh/month from your meter reading. +10% trust bonus!`;
        }
      } else {
        // Subsequent uploads - just update capacity, no trust bonus
        trustBonus = 0;
        message = `Production capacity updated to ${extractedCapacity} kWh/month from your meter reading.`;
      }
    } else {
      // Analysis failed - NO trust bonus, and do NOT change meterDataAnalyzed flag
      trustBonus = 0;

      // Log the actual error for debugging
      logger.debug(`[MeterAnalyzer] API analysis failed: ${analysisResult.error}`);

      message = `Could not extract production capacity from the document. Please try with a clearer meter reading PDF.`;
    }

    // Only apply trust bonus if extraction succeeded (cap at 100%)
    if (trustBonus > 0) {
      const newTrustScore = Math.min(1.0, (currentUser?.trustScore || 0.3) + trustBonus);
      updateData.trustScore = newTrustScore;

      // Recalculate allowed trade limit based on new trust score
      const { calculateAllowedLimit } = await import('@p2p/shared');
      updateData.allowedTradeLimit = calculateAllowedLimit(newTrustScore);
    }

    // Update user record
    const updatedUser = await prisma.user.update({
      where: { id: req.user!.id },
      data: updateData,
      include: {
        provider: {
          select: { id: true, name: true, trustScore: true },
        },
      },
    });

    // Record trust score change in history if bonus was applied
    if (trustBonus > 0 && extractedCapacity) {
      await prisma.trustScoreHistory.create({
        data: {
          userId: req.user!.id,
          previousScore: currentUser?.trustScore || 0.3,
          newScore: updatedUser.trustScore,
          previousLimit: updatedUser.allowedTradeLimit - (trustBonus * 100), // Approximate
          newLimit: updatedUser.allowedTradeLimit,
          reason: 'METER_VERIFIED',
          metadata: JSON.stringify({
            extractedCapacity: analysisResult.extractedCapacity,
            declaredCapacity,
            quality: analysisResult.quality,
            matchesDeclaration: analysisResult.matchesDeclaration,
            trustBonus: `+${(trustBonus * 100).toFixed(0)}%`,
          }),
        },
      });
    }

    // If extraction failed, return error response
    if (!extractedCapacity) {
      return res.status(400).json({
        success: false,
        error: message,
        analysis: {
          extractedCapacity: null,
          quality: analysisResult.quality,
          insights: analysisResult.insights || 'Could not extract capacity from document',
        },
      });
    }

    res.json({
      success: true,
      message,
      analysis: {
        extractedCapacity: analysisResult.extractedCapacity,
        declaredCapacity,
        quality: analysisResult.quality,
        matchesDeclaration: analysisResult.matchesDeclaration,
        insights: analysisResult.insights,
      },
      trustBonus: trustBonus > 0 ? `+${(trustBonus * 100).toFixed(0)}%` : null,
      user: {
        id: updatedUser.id,
        phone: updatedUser.phone,
        name: updatedUser.name,
        profileComplete: updatedUser.profileComplete,
        balance: updatedUser.balance,
        providerId: updatedUser.providerId,
        provider: updatedUser.provider,
        trustScore: updatedUser.trustScore,
        allowedTradeLimit: updatedUser.allowedTradeLimit,
        productionCapacity: updatedUser.productionCapacity,
        meterVerifiedCapacity: updatedUser.meterVerifiedCapacity,
        meterDataAnalyzed: updatedUser.meterDataAnalyzed,
      },
    });
  } catch (error: any) {
    logger.error(`Meter analysis error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze meter PDF. Please try again.',
    });
  }
});

/**
 * POST /auth/reset-meter - Reset meter analysis (for testing)
 * Allows user to re-upload and re-analyze their meter data
 * Protected: DEV_MODE only
 */
router.post('/reset-meter', devModeOnly, authMiddleware, async (req: Request, res: Response) => {
  try {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        meterDataAnalyzed: false,
        meterVerifiedCapacity: null,
        meterPdfUrl: null,
      },
    });

    res.json({
      success: true,
      message: 'Meter data reset. You can now upload a new meter reading.',
    });
  } catch (error: any) {
    logger.error(`Reset meter error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to reset meter data.',
    });
  }
});

// =============================================================================
// Verifiable Credentials API
// =============================================================================

/**
 * POST /auth/verify-vc-pdf
 * Upload a PDF containing a Verifiable Credential, extract and verify it,
 * then set the user's production capacity and trade limit from the VC.
 * This is the mandatory onboarding step after login.
 */
router.post('/verify-vc-pdf', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pdfBase64, credential: jsonCredential } = req.body;

    if (!pdfBase64 && !jsonCredential) {
      return res.status(400).json({
        success: false,
        error: 'Either a PDF file (base64) or a JSON credential is required',
      });
    }

    let credential: Record<string, any>;
    let extractionMethod: 'json' | 'llm' | 'direct' = 'direct';

    if (jsonCredential && typeof jsonCredential === 'object') {
      // Direct JSON credential provided
      credential = jsonCredential;
    } else if (pdfBase64 && typeof pdfBase64 === 'string') {
      // PDF provided - extract VC from it
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const { extractVCFromPdf } = await import('./vc-pdf-analyzer');
      const extraction = await extractVCFromPdf(pdfBuffer);

      if (!extraction.success || !extraction.credential) {
        return res.status(400).json({
          success: false,
          error: extraction.error || 'Could not extract a Verifiable Credential from this PDF.',
        });
      }

      credential = extraction.credential;
      extractionMethod = extraction.extractionMethod;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid input. Provide pdfBase64 (string) or credential (object).',
      });
    }

    // Verify the VC using shared verifier
    const {
      verifyGenerationProfile,
      extractCapacity,
      extractNormalizedGenerationClaims,
      calculateAllowedLimit,
    } = await import('@p2p/shared');

    const verificationResult = await verifyGenerationProfile(credential);

    // Extract capacity and normalized claims regardless of strict verification
    // (LLM-extracted VCs won't have valid proofs but the data is still useful)
    const capacityKW = extractCapacity(credential as any);
    const claims = extractNormalizedGenerationClaims(credential as any);

    if (!capacityKW || capacityKW <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Could not extract a valid production capacity (capacityKW) from the credential.',
        verification: {
          verified: verificationResult.verified,
          checks: verificationResult.checks,
        },
      });
    }

    // Convert installed capacity (kW peak) to estimated monthly production (kWh/month)
    // Formula: kWh/month = capacityKW × avg_peak_sun_hours/day × 30 days
    // Using 4.5 peak sun hours/day (average for India)
    const AVG_PEAK_SUN_HOURS = 4.5;
    const DAYS_PER_MONTH = 30;
    const estimatedMonthlyKWh = capacityKW * AVG_PEAK_SUN_HOURS * DAYS_PER_MONTH;

    // Get current user for trust score and solar limit
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { trustScore: true, solarAnalysis: { select: { tradingLimitPercent: true } } },
    });

    const trustScore = currentUser?.trustScore || 0.3;
    const solarLimit = currentUser?.solarAnalysis?.tradingLimitPercent;
    const allowedLimit = calculateAllowedLimit(trustScore, undefined, solarLimit);

    // Update user: set capacity (kWh/month), mark profile complete
    const updatedUser = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        productionCapacity: estimatedMonthlyKWh,
        allowedTradeLimit: allowedLimit,
        profileComplete: true,
      },
      include: {
        provider: {
          select: { id: true, name: true, trustScore: true },
        },
      },
    });

    logger.info(`User ${req.user!.id} completed onboarding via VC: capacityKW=${capacityKW}, estimatedMonthlyKWh=${estimatedMonthlyKWh}, method=${extractionMethod}`);

    // Send proactive WhatsApp welcome now that profile is complete (fire-and-forget)
    sendFirstLoginWelcome(req.user!.id).catch(err => {
      logger.warn(`Background WhatsApp welcome on VC verification failed: ${err.message}`);
    });

    res.json({
      success: true,
      verification: {
        verified: verificationResult.verified,
        checks: verificationResult.checks,
        extractionMethod,
      },
      generationProfile: {
        fullName: claims.fullName,
        capacityKW: claims.capacityKW,
        sourceType: claims.sourceType,
        meterNumber: claims.meterNumber,
        consumerNumber: claims.consumerNumber,
      },
      user: {
        id: updatedUser.id,
        phone: updatedUser.phone,
        name: updatedUser.name,
        profileComplete: updatedUser.profileComplete,
        balance: updatedUser.balance,
        providerId: updatedUser.providerId,
        provider: updatedUser.provider,
        trustScore: updatedUser.trustScore,
        allowedTradeLimit: updatedUser.allowedTradeLimit,
        productionCapacity: updatedUser.productionCapacity,
        meterVerifiedCapacity: updatedUser.meterVerifiedCapacity,
        meterDataAnalyzed: updatedUser.meterDataAnalyzed,
      },
    });
  } catch (error: any) {
    logger.error(`VC PDF verification error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to process VC PDF. Please try again.',
    });
  }
});

// =============================================================================
// Multi-Credential Onboarding Endpoints (Beckn DEG)
// =============================================================================

/**
 * POST /auth/verify-credential
 * Generic endpoint: accepts any of the 5 DEG credential types,
 * auto-detects the type, verifies, extracts claims, and stores.
 */
router.post('/verify-credential', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pdfBase64, credential: jsonCredential } = req.body;

    if (!pdfBase64 && !jsonCredential) {
      return res.status(400).json({
        success: false,
        error: 'Either a PDF file (base64) or a JSON credential is required',
      });
    }

    let credential: Record<string, any>;
    let extractionMethod: 'json' | 'llm' | 'direct' = 'direct';

    if (jsonCredential && typeof jsonCredential === 'object') {
      credential = jsonCredential;
    } else if (pdfBase64 && typeof pdfBase64 === 'string') {
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const { extractVCFromPdf } = await import('./vc-pdf-analyzer');
      const extraction = await extractVCFromPdf(pdfBuffer);
      if (!extraction.success || !extraction.credential) {
        return res.status(400).json({
          success: false,
          error: extraction.error || 'Could not extract a VC from this PDF.',
        });
      }
      credential = extraction.credential;
      extractionMethod = extraction.extractionMethod;
    } else {
      return res.status(400).json({ success: false, error: 'Invalid input.' });
    }

    const {
      verifyCredential: vcVerify,
      detectCredentialType,
      extractNormalizedGenerationClaims,
      extractNormalizedUtilityCustomerClaims,
      extractNormalizedConsumptionProfileClaims,
      extractNormalizedStorageProfileClaims,
      extractNormalizedProgramEnrollmentClaims,
      extractCapacity,
      getIssuerId,
      getIssuanceDate,
      calculateAllowedLimit,
    } = await import('@p2p/shared');

    // Auto-detect credential type
    const credType = detectCredentialType(credential as any);
    if (!credType) {
      return res.status(400).json({
        success: false,
        error: 'Could not detect credential type. Supported: UtilityCustomerCredential, ConsumptionProfileCredential, GenerationProfileCredential, StorageProfileCredential, UtilityProgramEnrollmentCredential',
      });
    }

    // Run generic verification pipeline
    const verificationResult = await vcVerify(credential);

    // Map DEG type to Prisma enum
    const PRISMA_TYPE_MAP: Record<string, string> = {
      'UtilityCustomerCredential': 'UTILITY_CUSTOMER',
      'ConsumptionProfileCredential': 'CONSUMPTION_PROFILE',
      'GenerationProfileCredential': 'GENERATION_PROFILE',
      'StorageProfileCredential': 'STORAGE_PROFILE',
      'UtilityProgramEnrollmentCredential': 'PROGRAM_ENROLLMENT',
    };
    const prismaCredType = PRISMA_TYPE_MAP[credType];

    // Extract claims and build User update based on credential type
    let claims: Record<string, any> = {};
    const userUpdate: Record<string, any> = {};

    // Get current user to check existing values before overwriting
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { name: true, providerId: true, consumerNumber: true, installationAddress: true },
    });

    switch (credType) {
      case 'UtilityCustomerCredential': {
        claims = extractNormalizedUtilityCustomerClaims(credential as any);
        // Only use VC name if user hasn't already set their own name
        if (claims.fullName && !currentUser?.name) {
          userUpdate.name = claims.fullName;
        }
        if (claims.consumerNumber) userUpdate.consumerNumber = claims.consumerNumber;
        if (claims.meterNumber) userUpdate.meterNumber = claims.meterNumber;
        if (claims.installationAddress) userUpdate.installationAddress = claims.installationAddress;
        if (claims.serviceConnectionDate) {
          const parsedDate = parseDate(claims.serviceConnectionDate);
          if (parsedDate) userUpdate.serviceConnectionDate = parsedDate;
        }
        break;
      }
      case 'ConsumptionProfileCredential': {
        claims = extractNormalizedConsumptionProfileClaims(credential as any);
        if (claims.premisesType) userUpdate.premisesType = claims.premisesType;
        if (claims.connectionType) userUpdate.connectionType = claims.connectionType;
        if (claims.sanctionedLoadKW) userUpdate.sanctionedLoadKW = claims.sanctionedLoadKW;
        if (claims.tariffCategoryCode) userUpdate.tariffCategoryCode = claims.tariffCategoryCode;
        break;
      }
      case 'GenerationProfileCredential': {
        claims = extractNormalizedGenerationClaims(credential as any);
        const capacityKW = extractCapacity(credential as any);
        if (capacityKW && capacityKW > 0) {
          const AVG_PEAK_SUN_HOURS = 4.5;
          const DAYS_PER_MONTH = 30;
          userUpdate.productionCapacity = capacityKW * AVG_PEAK_SUN_HOURS * DAYS_PER_MONTH;
        }
        break;
      }
      case 'StorageProfileCredential': {
        claims = extractNormalizedStorageProfileClaims(credential as any);
        if (claims.storageCapacityKWh) userUpdate.storageCapacityKWh = claims.storageCapacityKWh;
        if (claims.powerRatingKW) userUpdate.storagePowerRatingKW = claims.powerRatingKW;
        if (claims.storageType) userUpdate.storageType = claims.storageType;
        break;
      }
      case 'UtilityProgramEnrollmentCredential': {
        claims = extractNormalizedProgramEnrollmentClaims(credential as any);
        if (claims.programName) userUpdate.programName = claims.programName;
        if (claims.programCode) userUpdate.programCode = claims.programCode;
        if (claims.enrollmentDate) {
          userUpdate.programEnrollmentDate = new Date(claims.enrollmentDate);
        }
        if (claims.validUntil) {
          userUpdate.programValidUntil = new Date(claims.validUntil);
        }
        break;
      }
    }

    // Upsert UserCredential record
    const issuerId = getIssuerId(credential.issuer || '');
    const issuanceDateStr = getIssuanceDate(credential as any);

    await prisma.userCredential.upsert({
      where: {
        userId_credentialType: {
          userId: req.user!.id,
          credentialType: prismaCredType as any,
        },
      },
      create: {
        userId: req.user!.id,
        credentialType: prismaCredType as any,
        rawJson: JSON.stringify(credential),
        verified: verificationResult.verified,
        verifiedAt: verificationResult.verified ? new Date() : null,
        extractedClaims: JSON.stringify(claims),
        issuerId: issuerId || null,
        issuanceDate: issuanceDateStr ? new Date(issuanceDateStr) : null,
      },
      update: {
        rawJson: JSON.stringify(credential),
        verified: verificationResult.verified,
        verifiedAt: verificationResult.verified ? new Date() : null,
        extractedClaims: JSON.stringify(claims),
        issuerId: issuerId || null,
        issuanceDate: issuanceDateStr ? new Date(issuanceDateStr) : null,
      },
    });

    // Update User fields
    if (Object.keys(userUpdate).length > 0) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: userUpdate,
      });
    }

    // Auto-create Provider for Generation/Storage VCs
    if ((credType === 'GenerationProfileCredential' || credType === 'StorageProfileCredential') && verificationResult.verified) {
      if (!currentUser?.providerId) {
        const providerId = `provider-${req.user!.id}`;

        // Fetch latest user data for Provider creation
        const latestUser = await prisma.user.findUnique({
          where: { id: req.user!.id },
          select: { name: true, consumerNumber: true, installationAddress: true },
        });

        await prisma.provider.create({
          data: {
            id: providerId,
            name: latestUser?.name || 'Energy Provider',
            // From Generation VC
            generationType: claims.generationType || claims.sourceType || null,
            capacityKW: claims.capacityKW || null,
            generationMeterNumber: claims.meterNumber || null,
            commissioningDate: claims.commissioningDate ? parseDate(claims.commissioningDate) : null,
            // From Storage VC
            storageCapacityKWh: claims.storageCapacityKWh || null,
            storagePowerRatingKW: claims.powerRatingKW || null,
            storageType: claims.storageType || null,
            // From Utility VC (via User)
            consumerNumber: latestUser?.consumerNumber || null,
            installationAddress: latestUser?.installationAddress || null,
          },
        });

        await prisma.user.update({
          where: { id: req.user!.id },
          data: { providerId },
        });

        logger.info(`Auto-created Provider ${providerId} for user ${req.user!.id} from ${credType}`);
      }
    }

    // Run solar analysis when UtilityCustomerCredential is verified (has address)
    // This sets the initial trading limit (7-15%) based on solar potential
    if (credType === 'UtilityCustomerCredential' && verificationResult.verified && claims.installationAddress) {
      logger.info(`Triggering solar analysis for user ${req.user!.id} (UtilityCustomerCredential with address)`);
      // Run solar analysis in background (fire-and-forget for fast response)
      runSolarAnalysisForUser(req.user!.id, claims.installationAddress).then(result => {
        if (result) {
          logger.info(`✓ Solar analysis completed for user ${req.user!.id}: limit=${result.tradingLimitPercent}%, score=${result.installationScore.toFixed(2)}`);
        }
      }).catch(err => {
        logger.warn(`Background solar analysis failed for user ${req.user!.id}: ${err.message}`);
      });
    }

    // Also trigger solar analysis when Generation/Storage VC is verified if:
    // 1. User already has an installation address (from previous Utility VC)
    // 2. No solar analysis has been done yet
    if ((credType === 'GenerationProfileCredential' || credType === 'StorageProfileCredential') && verificationResult.verified) {
      const userWithAddress = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { installationAddress: true, solarAnalysis: true },
      });

      if (userWithAddress?.installationAddress && !userWithAddress.solarAnalysis) {
        logger.info(`Triggering solar analysis for user ${req.user!.id} (${credType} with existing address, no prior analysis)`);
        runSolarAnalysisForUser(req.user!.id, userWithAddress.installationAddress).then(result => {
          if (result) {
            logger.info(`✓ Solar analysis completed for user ${req.user!.id}: limit=${result.tradingLimitPercent}%, score=${result.installationScore.toFixed(2)}`);
          }
        }).catch(err => {
          logger.warn(`Background solar analysis failed for user ${req.user!.id}: ${err.message}`);
        });
      }
    }

    // Fetch updated user + all credentials
    const updatedUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        provider: { select: { id: true, name: true, trustScore: true } },
        credentials: { orderBy: { createdAt: 'asc' } },
      },
    });

    logger.info(`User ${req.user!.id} verified ${credType}: method=${extractionMethod}, verified=${verificationResult.verified}`);

    res.json({
      success: true,
      credentialType: credType,
      verification: {
        verified: verificationResult.verified,
        checks: verificationResult.checks,
        extractionMethod,
      },
      extractedClaims: claims,
      user: {
        id: updatedUser!.id,
        phone: updatedUser!.phone,
        name: updatedUser!.name,
        profileComplete: updatedUser!.profileComplete,
        balance: updatedUser!.balance,
        providerId: updatedUser!.providerId,
        provider: updatedUser!.provider,
        trustScore: updatedUser!.trustScore,
        allowedTradeLimit: updatedUser!.allowedTradeLimit,
        productionCapacity: updatedUser!.productionCapacity,
      },
      credentials: updatedUser!.credentials.map((c: any) => ({
        type: c.credentialType,
        verified: c.verified,
        verifiedAt: c.verifiedAt,
      })),
    });
  } catch (error: any) {
    logger.error(`Verify credential error: ${error}`);
    res.status(500).json({ success: false, error: 'Failed to verify credential.' });
  }
});

/**
 * POST /auth/complete-onboarding
 * Mark profile as complete after credential uploads.
 * Requires a verified UTILITY_CUSTOMER credential.
 */
router.post('/complete-onboarding', authMiddleware, async (req: Request, res: Response) => {
  try {
    // Check for mandatory Utility Customer credential
    const utilityCustomer = await prisma.userCredential.findUnique({
      where: {
        userId_credentialType: {
          userId: req.user!.id,
          credentialType: 'UTILITY_CUSTOMER',
        },
      },
    });

    if (!utilityCustomer) {
      return res.status(400).json({
        success: false,
        error: 'A Utility Customer credential is required to complete onboarding.',
      });
    }

    // Recalculate trade limit (respecting solar-based limit if available)
    const { calculateAllowedLimit } = await import('@p2p/shared');
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { trustScore: true, solarAnalysis: { select: { tradingLimitPercent: true } } },
    });
    const trustScore = currentUser?.trustScore || 0.3;
    const solarLimit = currentUser?.solarAnalysis?.tradingLimitPercent;
    const allowedLimit = calculateAllowedLimit(trustScore, undefined, solarLimit);

    const updatedUser = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        profileComplete: true,
        allowedTradeLimit: allowedLimit,
      },
      include: {
        provider: { select: { id: true, name: true, trustScore: true } },
        credentials: { orderBy: { createdAt: 'asc' } },
      },
    });

    const credCount = updatedUser.credentials.length;
    logger.info(`User ${req.user!.id} completed onboarding with ${credCount} credential(s)`);
    logger.info(`User phone: ${updatedUser.phone}, profileComplete: ${updatedUser.profileComplete}`);

    // Send proactive WhatsApp welcome now that profile is complete (fire-and-forget)
    logger.info(`Triggering WhatsApp welcome for user ${req.user!.id}...`);
    sendFirstLoginWelcome(req.user!.id).then(sent => {
      if (sent) {
        logger.info(`WhatsApp welcome SENT successfully to user ${req.user!.id}`);
      } else {
        logger.warn(`WhatsApp welcome NOT sent to user ${req.user!.id} - check function logs for details`);
      }
    }).catch(err => {
      logger.error(`WhatsApp welcome FAILED for user ${req.user!.id}: ${err.message}`);
    });

    res.json({
      success: true,
      user: {
        id: updatedUser.id,
        phone: updatedUser.phone,
        name: updatedUser.name,
        profileComplete: updatedUser.profileComplete,
        balance: updatedUser.balance,
        providerId: updatedUser.providerId,
        provider: updatedUser.provider,
        trustScore: updatedUser.trustScore,
        allowedTradeLimit: updatedUser.allowedTradeLimit,
        productionCapacity: updatedUser.productionCapacity,
      },
      credentials: updatedUser.credentials.map((c: any) => ({
        type: c.credentialType,
        verified: c.verified,
        verifiedAt: c.verifiedAt,
      })),
    });
  } catch (error: any) {
    logger.error(`Complete onboarding error: ${error}`);
    res.status(500).json({ success: false, error: 'Failed to complete onboarding.' });
  }
});

/**
 * POST /auth/vc/verify
 * Verify a Verifiable Credential (VC)
 * Accepts both JSON object or VC ID string
 */
router.post('/vc/verify', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { credential, vcId, options } = req.body;

    if (!credential && !vcId) {
      return res.status(400).json({
        success: false,
        error: 'Either credential (JSON) or vcId (string) is required',
      });
    }

    // Import VC verification utilities
    const { verifyCredential, VCPortalClient } = await import('@p2p/shared');

    let vcToVerify = credential;
    let fetchedFromPortal = false;

    // If vcId provided, try to fetch from portal
    if (vcId && !credential) {
      try {
        const portalClient = new VCPortalClient();
        vcToVerify = await portalClient.fetchCredential(vcId);
        fetchedFromPortal = true;

        if (!vcToVerify) {
          return res.status(404).json({
            success: false,
            error: `Credential not found: ${vcId}`,
          });
        }
      } catch (fetchError: any) {
        return res.status(400).json({
          success: false,
          error: `Failed to fetch credential: ${fetchError.message}`,
        });
      }
    }

    // Validate credential structure
    if (!vcToVerify || typeof vcToVerify !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Invalid credential format',
      });
    }

    // Perform verification
    const verificationResult = await verifyCredential(vcToVerify, options || {});

    // Store or update the credential record for this user
    // (In a full implementation, you'd have a UserCredential table)

    res.json({
      success: true,
      verified: verificationResult.verified,
      credentialId: vcToVerify.id || vcId,
      credentialType: vcToVerify.type,
      issuer: typeof vcToVerify.issuer === 'string' ? vcToVerify.issuer : vcToVerify.issuer?.id,
      subject: vcToVerify.credentialSubject?.id,
      fetchedFromPortal,
      checks: verificationResult.checks,
      error: verificationResult.error,
    });
  } catch (error: any) {
    logger.error(`VC verification error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Credential verification failed',
    });
  }
});

/**
 * GET /auth/me/credentials
 * List the user's verified credentials
 * Note: This is a simplified version - in production you'd have a UserCredential table
 */
router.get('/me/credentials', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        phone: true,
        meterDataAnalyzed: true,
        meterVerifiedCapacity: true,
        meterPdfUrl: true,
        providerId: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Build list of credentials based on user's verification status
    // Fetch actual credentials from database
    const userCredentials = await prisma.userCredential.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'asc' },
    });

    // Map DB credential types to display names
    const CRED_TYPE_MAP: Record<string, string> = {
      'UTILITY_CUSTOMER': 'UtilityCustomerCredential',
      'GENERATION_PROFILE': 'GenerationProfileCredential',
      'CONSUMPTION_PROFILE': 'ConsumptionProfileCredential',
      'STORAGE_PROFILE': 'StorageProfileCredential',
      'PROGRAM_ENROLLMENT': 'UtilityProgramEnrollmentCredential',
    };

    const credentials = userCredentials.map(cred => ({
      type: CRED_TYPE_MAP[cred.credentialType] || cred.credentialType,
      verified: cred.verified,
      verifiedAt: cred.verifiedAt?.toISOString() || null,
    }));

    res.json({
      success: true,
      credentials,
      totalVerified: credentials.filter(c => c.verified).length,
      totalPending: credentials.filter(c => !c.verified).length,
    });
  } catch (error: any) {
    logger.error(`Get credentials error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credentials',
    });
  }
});

export default router;
