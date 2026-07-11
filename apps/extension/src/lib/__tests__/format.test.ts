import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeAgo, resolveRelativePath } from '../format';

afterEach(() => { vi.useRealTimers(); });

describe('timeAgo', () => {
  it('renders coarse buckets', () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-11T12:00:00Z').getTime();
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now - 30 * 1000).toISOString())).toBe('Just now');
    expect(timeAgo(new Date(now - 5 * 60000).toISOString())).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * 3600000).toISOString())).toBe('3h ago');
    expect(timeAgo(new Date(now - 2 * 86400000).toISOString())).toBe('2d ago');
  });
});

describe('resolveRelativePath', () => {
  it('resolves ./ and ../ against a base dir', () => {
    expect(resolveRelativePath('notes/sub', './img.png')).toBe('notes/sub/img.png');
    expect(resolveRelativePath('notes/sub', '../img.png')).toBe('notes/img.png');
    expect(resolveRelativePath('notes/sub', '../../assets/x.png')).toBe('assets/x.png');
  });
  it('handles no base dir and URL-decoding', () => {
    expect(resolveRelativePath('', 'a/b.png')).toBe('a/b.png');
    expect(resolveRelativePath('d', 'my%20file.png')).toBe('d/my file.png');
  });
});
