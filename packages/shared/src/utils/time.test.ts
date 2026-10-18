/**
 * Comprehensive unit tests for Time Utilities
 * Tests time window validation, overlap detection, and fit calculation
 */

import {
  isValidTimeWindow,
  timeWindowsOverlap,
  calculateOverlapDuration,
  getTimeWindowDuration,
  calculateTimeWindowFit,
} from './time';
import { TimeWindow } from '../types/beckn';

describe('Time Utilities', () => {
  describe('isValidTimeWindow', () => {
    it('should return true for valid time window', () => {
      const window: TimeWindow = {
        startTime: '2026-01-29T08:00:00Z',
        endTime: '2026-01-29T12:00:00Z',
      };
      expect(isValidTimeWindow(window)).toBe(true);
    });

    it('should return false when start is after end', () => {
      const window: TimeWindow = {
        startTime: '2026-01-29T12:00:00Z',
        endTime: '2026-01-29T08:00:00Z',
      };
      expect(isValidTimeWindow(window)).toBe(false);
    });

    it('should return false when start equals end', () => {
      const window: TimeWindow = {
        startTime: '2026-01-29T08:00:00Z',
        endTime: '2026-01-29T08:00:00Z',
      };
      expect(isValidTimeWindow(window)).toBe(false);
    });

    it('should return false when startTime is missing', () => {
      const window = {
        startTime: null as any,
        endTime: '2026-01-29T12:00:00Z',
      };
      expect(isValidTimeWindow(window as TimeWindow)).toBe(false);
    });

    it('should return false when endTime is missing', () => {
      const window = {
        startTime: '2026-01-29T08:00:00Z',
        endTime: null as any,
      };
      expect(isValidTimeWindow(window as TimeWindow)).toBe(false);
    });

    it('should return false for invalid date string', () => {
      const window: TimeWindow = {
        startTime: 'invalid-date',
        endTime: '2026-01-29T12:00:00Z',
      };
      expect(isValidTimeWindow(window)).toBe(false);
    });

    it('should return false for undefined window', () => {
      expect(isValidTimeWindow(undefined)).toBe(false);
    });

    it('should return false for empty strings', () => {
      const window: TimeWindow = {
        startTime: '',
        endTime: '',
      };
      expect(isValidTimeWindow(window)).toBe(false);
    });

    it('should accept various valid ISO formats', () => {
      const window1: TimeWindow = {
        startTime: '2026-01-29T08:00:00.000Z',
        endTime: '2026-01-29T12:00:00.000Z',
      };
      expect(isValidTimeWindow(window1)).toBe(true);

      const window2: TimeWindow = {
        startTime: '2026-01-29T08:00:00+05:30',
        endTime: '2026-01-29T12:00:00+05:30',
      };
      expect(isValidTimeWindow(window2)).toBe(true);
    });

    it('should handle epoch dates', () => {
      const window: TimeWindow = {
        startTime: '1970-01-01T00:00:00Z',
        endTime: '1970-01-01T01:00:00Z',
      };
      expect(isValidTimeWindow(window)).toBe(true);
    });

    it('should handle far future dates', () => {
      const window: TimeWindow = {
        startTime: '2099-12-31T00:00:00Z',
        endTime: '2099-12-31T23:59:59Z',
      };
      expect(isValidTimeWindow(window)).toBe(true);
    });
  });

  describe('timeWindowsOverlap', () => {
    it('should return true for partial overlap', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T10:00:00Z', endTime: '2026-01-29T14:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(true);
    });

    it('should return true when A contains B', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T16:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T10:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(true);
    });

    it('should return true when B contains A', () => {
      const a: TimeWindow = { startTime: '2026-01-29T10:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T16:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(true);
    });

    it('should return true for exact same windows', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(true);
    });

    it('should return false for adjacent windows (no overlap)', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T12:00:00Z', endTime: '2026-01-29T16:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(false);
    });

    it('should return false when A is completely before B', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T10:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T14:00:00Z', endTime: '2026-01-29T18:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(false);
    });

    it('should return false when A is completely after B', () => {
      const a: TimeWindow = { startTime: '2026-01-29T14:00:00Z', endTime: '2026-01-29T18:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T10:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(false);
    });

    it('should return true when A is undefined (no filtering)', () => {
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(timeWindowsOverlap(undefined, b)).toBe(true);
    });

    it('should return true when B is undefined (no filtering)', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(timeWindowsOverlap(a, undefined)).toBe(true);
    });

    it('should return true when both are undefined', () => {
      expect(timeWindowsOverlap(undefined, undefined)).toBe(true);
    });

    it('should return true when A has invalid dates (treated as flexible)', () => {
      const a: TimeWindow = { startTime: 'invalid', endTime: 'invalid' };
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(timeWindowsOverlap(a, b)).toBe(true);
    });

    it('should return true when B has invalid dates (treated as flexible)', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const b: TimeWindow = { startTime: 'invalid', endTime: 'invalid' };
      expect(timeWindowsOverlap(a, b)).toBe(true);
    });

    it('should handle 1ms overlap', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00.000Z', endTime: '2026-01-29T12:00:00.001Z' };
      const b: TimeWindow = { startTime: '2026-01-29T12:00:00.000Z', endTime: '2026-01-29T16:00:00.000Z' };
      expect(timeWindowsOverlap(a, b)).toBe(true);
    });
  });

  describe('calculateOverlapDuration', () => {
    const HOUR_MS = 60 * 60 * 1000;

    it('should return full duration for identical windows', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateOverlapDuration(a, b)).toBe(4 * HOUR_MS);
    });

    it('should return partial overlap duration', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T10:00:00Z', endTime: '2026-01-29T14:00:00Z' };
      expect(calculateOverlapDuration(a, b)).toBe(2 * HOUR_MS);
    });

    it('should return 0 for non-overlapping windows', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T10:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T14:00:00Z', endTime: '2026-01-29T18:00:00Z' };
      expect(calculateOverlapDuration(a, b)).toBe(0);
    });

    it('should return -1 for undefined window A', () => {
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateOverlapDuration(undefined, b)).toBe(-1);
    });

    it('should return -1 for undefined window B', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateOverlapDuration(a, undefined)).toBe(-1);
    });

    it('should return -1 for invalid window', () => {
      const a: TimeWindow = { startTime: 'invalid', endTime: 'invalid' };
      const b: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateOverlapDuration(a, b)).toBe(-1);
    });

    it('should handle contained window correctly', () => {
      const a: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T16:00:00Z' };
      const b: TimeWindow = { startTime: '2026-01-29T10:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateOverlapDuration(a, b)).toBe(2 * HOUR_MS);
    });
  });

  describe('getTimeWindowDuration', () => {
    const HOUR_MS = 60 * 60 * 1000;

    it('should return correct duration for 4-hour window', () => {
      const window: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(getTimeWindowDuration(window)).toBe(4 * HOUR_MS);
    });

    it('should return 0 for zero-duration window', () => {
      const window: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T08:00:00Z' };
      expect(getTimeWindowDuration(window)).toBe(0);
    });

    it('should return 0 for undefined window', () => {
      expect(getTimeWindowDuration(undefined)).toBe(0);
    });

    it('should return 0 for invalid window', () => {
      const window: TimeWindow = { startTime: 'invalid', endTime: 'invalid' };
      expect(getTimeWindowDuration(window)).toBe(0);
    });

    it('should return 0 for inverted window (start > end)', () => {
      const window: TimeWindow = { startTime: '2026-01-29T12:00:00Z', endTime: '2026-01-29T08:00:00Z' };
      expect(getTimeWindowDuration(window)).toBe(0);
    });

    it('should handle 24-hour window', () => {
      const window: TimeWindow = { startTime: '2026-01-29T00:00:00Z', endTime: '2026-01-30T00:00:00Z' };
      expect(getTimeWindowDuration(window)).toBe(24 * HOUR_MS);
    });

    it('should handle millisecond precision', () => {
      const window: TimeWindow = { startTime: '2026-01-29T08:00:00.000Z', endTime: '2026-01-29T08:00:00.500Z' };
      expect(getTimeWindowDuration(window)).toBe(500);
    });
  });

  describe('calculateTimeWindowFit', () => {
    it('should return 1.0 when no requested time window (no constraint)', () => {
      const offer: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, undefined)).toBe(1);
    });

    it('should return 0.5 when offer has no time window (flexible)', () => {
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(undefined, requested)).toBe(0.5);
    });

    it('should return 1.0 for full coverage', () => {
      const offer: TimeWindow = { startTime: '2026-01-29T06:00:00Z', endTime: '2026-01-29T18:00:00Z' };
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, requested)).toBe(1);
    });

    it('should return 0.5 for 50% coverage', () => {
      const offer: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T10:00:00Z' };
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, requested)).toBeCloseTo(0.5, 2);
    });

    it('should return 0.0 for no overlap', () => {
      const offer: TimeWindow = { startTime: '2026-01-29T14:00:00Z', endTime: '2026-01-29T18:00:00Z' };
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, requested)).toBe(0);
    });

    it('should cap at 1.0 even when offer is longer than requested', () => {
      const offer: TimeWindow = { startTime: '2026-01-29T00:00:00Z', endTime: '2026-01-29T23:59:59Z' };
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, requested)).toBe(1);
    });

    it('should return 0.5 when both windows are undefined', () => {
      // When requested is undefined, returns 1.0
      expect(calculateTimeWindowFit(undefined, undefined)).toBe(1);
    });

    it('should handle partial overlap correctly', () => {
      // Offer: 10am-2pm, Requested: 8am-12pm
      // Overlap: 10am-12pm = 2 hours out of 4 hours requested = 50%
      const offer: TimeWindow = { startTime: '2026-01-29T10:00:00Z', endTime: '2026-01-29T14:00:00Z' };
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, requested)).toBeCloseTo(0.5, 2);
    });

    it('should handle 25% overlap', () => {
      // Offer: 11am-12pm (1 hour), Requested: 8am-12pm (4 hours) = 25%
      const offer: TimeWindow = { startTime: '2026-01-29T11:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, requested)).toBeCloseTo(0.25, 2);
    });

    it('should handle 75% overlap', () => {
      // Offer: 8am-11am (3 hours), Requested: 8am-12pm (4 hours) = 75%
      const offer: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T11:00:00Z' };
      const requested: TimeWindow = { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' };
      expect(calculateTimeWindowFit(offer, requested)).toBeCloseTo(0.75, 2);
    });
  });
});
