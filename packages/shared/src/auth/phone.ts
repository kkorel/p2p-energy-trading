/**
 * Phone + OTP Authentication Service
 * Handles phone number verification and user management
 */

import { prisma } from '../db/prisma';

// Hardcoded OTP for development (replace with SMS service later)
const HARDCODED_OTP = '123456';

// In-memory OTP store: Map<phone, { otp: string, expiresAt: Date }>
const otpStore = new Map<string, { otp: string; expiresAt: Date }>();

export interface PhoneAuthResult {
  success: boolean;
  message: string;
  userId?: string;
  isNewUser?: boolean;
  user?: {
    id: string;
    phone: string;
    name: string | null;
    profileComplete: boolean;
  };
}

/**
 * Validate phone number format.
 * Accepts 10-digit Indian numbers (with or without +91 prefix).
 */
export function validatePhoneNumber(phone: string): boolean {
  const cleaned = phone.replace(/[\s-]/g, '');
  // Accept: 9876543210, +919876543210, 919876543210
  return /^(\+?91)?[6-9]\d{9}$/.test(cleaned);
}

/**
 * Normalize phone number to +91 format (India only).
 * Handles: "9876543210", "91 9876543210", "+91 9876543210", "09876543210"
 */
export function normalizePhone(phone: string): string {
  // Remove all non-digits except leading +
  let cleaned = phone.replace(/[\s-]/g, '');

  // Remove leading + for processing
  const hasPlus = cleaned.startsWith('+');
  if (hasPlus) cleaned = cleaned.slice(1);

  // Remove all non-digits
  cleaned = cleaned.replace(/\D/g, '');

  // Remove leading 0 if present
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }

  // Remove 91 prefix if present (to avoid +9191...)
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    cleaned = cleaned.slice(2);
  }

  // Take last 10 digits if still longer
  if (cleaned.length > 10) {
    cleaned = cleaned.slice(-10);
  }

  // Return with +91 prefix
  return '+91' + cleaned;
}

/**
 * Send OTP to a phone number (hardcoded for now).
 */
export async function sendOtp(phone: string): Promise<{ success: boolean; message: string }> {
  const normalized = normalizePhone(phone);

  if (!validatePhoneNumber(normalized)) {
    return { success: false, message: 'Invalid phone number format' };
  }

  // Store OTP with 5-minute expiry
  otpStore.set(normalized, {
    otp: HARDCODED_OTP,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  // In production: call SMS API here (e.g., Twilio, MSG91)
  console.log(`[OTP] Sent OTP to ${normalized}`);

  return { success: true, message: 'OTP sent successfully' };
}

/**
 * Verify OTP and authenticate user (create or find by phone).
 */
export async function verifyOtpAndAuthenticate(
  phone: string,
  otp: string,
  name?: string
): Promise<PhoneAuthResult> {
  const normalized = normalizePhone(phone);

  // Verify OTP
  const stored = otpStore.get(normalized);

  if (!stored) {
    return { success: false, message: 'No OTP requested for this number. Please request a new OTP.' };
  }

  if (stored.expiresAt < new Date()) {
    otpStore.delete(normalized);
    return { success: false, message: 'OTP has expired. Please request a new one.' };
  }

  if (stored.otp !== otp) {
    return { success: false, message: 'Invalid OTP. Please try again.' };
  }

  // OTP verified — remove from store
  otpStore.delete(normalized);

  // Find or create user
  let user = await prisma.user.findUnique({
    where: { phone: normalized },
  });

  const isNewUser = !user;

  if (!user) {
    // Create user (name can be set later via chat agent or profile)
    user = await prisma.user.create({
      data: {
        phone: normalized,
        name: name?.trim() || null,
        profileComplete: false,
      },
    });
  } else {
    // Existing user — update last login and optionally name
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(name && name.trim().length >= 2 ? { name: name.trim() } : {}),
      },
    });
  }

  return {
    success: true,
    message: isNewUser ? 'Account created successfully' : 'Login successful',
    userId: user.id,
    isNewUser,
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      profileComplete: user.profileComplete,
    },
  };
}
