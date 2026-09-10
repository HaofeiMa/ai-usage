import { describe, expect, it } from 'vitest';
import { pickerLabel, pickerMarkup, withAllOption } from './picker.js';

const options = withAllOption(['cursor', 'codex'], (value) =>
  value === 'codex' ? 'ChatGPT (Codex)' : value,
);

describe('withAllOption', () => {
  it('puts 全部 first and keeps source labels', () => {
    expect(options[0]).toEqual({ value: '', label: '全部' });
    expect(options[2]).toEqual({ value: 'codex', label: 'ChatGPT (Codex)' });
  });
});

describe('pickerLabel', () => {
  it('returns the matching option label', () => {
    expect(pickerLabel(options, '')).toBe('全部');
    expect(pickerLabel(options, 'codex')).toBe('ChatGPT (Codex)');
  });
});

describe('pickerMarkup', () => {
  it('marks the selected option and shows its label on the toggle', () => {
    const html = pickerMarkup('filter-source', options, 'codex');
    expect(html).toContain('id="filter-source"');
    expect(html).toContain('>ChatGPT (Codex)</span>');
    expect(html).toContain('data-value="codex"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-value=""');
    expect(html).not.toMatch(/data-value=""[^>]*aria-selected="true"/);
  });
});
