import { describe, expect, it } from 'vitest';
import { formatCompactTokens, formatDuration } from './format.js';

describe('formatCompactTokens', () => {
  it('renders millions with one decimal (tray title style)', () => {
    expect(formatCompactTokens(1_200_000)).toBe('1.2M');
    expect(formatCompactTokens(1_000_000)).toBe('1.0M');
  });

  it('renders thousands as K', () => {
    expect(formatCompactTokens(1_000)).toBe('1K');
    expect(formatCompactTokens(12_400)).toBe('12K');
  });

  it('renders small counts as integers', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(999)).toBe('999');
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes in Chinese units', () => {
    expect(formatDuration(0)).toBe('0分钟');
    expect(formatDuration(90)).toBe('1分钟');
    expect(formatDuration(3600)).toBe('1小时');
    expect(formatDuration(5400)).toBe('1小时30分钟');
  });
});
