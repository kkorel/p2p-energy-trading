/**
 * Time Window Utilities
 */

import { TimeWindow } from '../types/beckn';

/**
 * Check if a time window has valid start and end times
 */
export function isValidTimeWindow(tw?: TimeWindow): boolean {
  if (!tw) return false;
  if (!tw.startTime || !tw.endTime) return false;
  const start = new Date(tw.startTime).getTime();
  const end = new Date(tw.endTime).getTime();
  return !isNaN(start) && !isNaN(end) && start < end;
}

/**
 * Check if two time windows overlap
 * Returns true if either window is undefined/invalid (no filtering)
 */
export function timeWindowsOverlap(a?: TimeWindow, b?: TimeWindow): boolean {
  // If either window is undefined or invalid, treat as "always matches"
  if (!isValidTimeWindow(a) || !isValidTimeWindow(b)) {
    return true;
  }
  
  const aStart = new Date(a!.startTime).getTime();
  const aEnd = new Date(a!.endTime).getTime();
  const bStart = new Date(b!.startTime).getTime();
  const bEnd = new Date(b!.endTime).getTime();
  
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Calculate the overlap duration in milliseconds
 * Returns the actual overlap, or -1 if windows are incompatible
 */
export function calculateOverlapDuration(a?: TimeWindow, b?: TimeWindow): number {
  // If either window is invalid, return -1 to indicate "no comparison possible"
  if (!isValidTimeWindow(a) || !isValidTimeWindow(b)) return -1;
  
  const aStart = new Date(a!.startTime).getTime();
  const aEnd = new Date(a!.endTime).getTime();
  const bStart = new Date(b!.startTime).getTime();
  const bEnd = new Date(b!.endTime).getTime();
  
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  
  return Math.max(0, overlapEnd - overlapStart);
}

/**
 * Calculate time window duration in milliseconds
 */
export function getTimeWindowDuration(tw?: TimeWindow): number {
  if (!isValidTimeWindow(tw)) return 0;
  return new Date(tw!.endTime).getTime() - new Date(tw!.startTime).getTime();
}

/**
 * Calculate time window fit ratio (0.0 to 1.0)
 * 
 * Scoring logic:
 * - If no requested time window: 1.0 (no constraint)
 * - If offer has no time window: 0.5 (flexible timing, middle score)
 * - If both have time windows: ratio of overlap to requested duration
 */
export function calculateTimeWindowFit(offer?: TimeWindow, requested?: TimeWindow): number {
  // No requested time window = no constraint, perfect fit
  if (!isValidTimeWindow(requested)) return 1;
  
  // Offer has no time window = flexible timing, give 50% score
  // This differentiates from offers that actually match the requested time
  if (!isValidTimeWindow(offer)) return 0.5;
  
  const overlapDuration = calculateOverlapDuration(offer, requested);
  const requestedDuration = getTimeWindowDuration(requested);
  
  // Shouldn't happen given the checks above, but safety check
  if (requestedDuration === 0 || overlapDuration < 0) return 0.5;
  
  // Return ratio: how much of the requested window is covered
  return Math.min(1, overlapDuration / requestedDuration);
}
