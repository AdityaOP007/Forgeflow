import { describe, it, expect } from 'vitest';
import { repositoryUrlSchema } from './index.js';

describe('repositoryUrlSchema', () => {
  it('accepts valid https URL', () => {
    const res = repositoryUrlSchema.safeParse('https://github.com/forgeflow/inventory-service');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toBe('https://github.com/forgeflow/inventory-service');
    }
  });

  it('accepts valid http URL', () => {
    const res = repositoryUrlSchema.safeParse('http://example.com/repo');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toBe('http://example.com/repo');
    }
  });

  it('rejects javascript: scheme with specific message', () => {
    const res = repositoryUrlSchema.safeParse('javascript:alert(1)');
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe(
        'Repository URL must start with http:// or https://'
      );
    }
  });

  it('rejects data: scheme with specific message', () => {
    const res = repositoryUrlSchema.safeParse('data:text/html,<script>alert(1)</script>');
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe(
        'Repository URL must start with http:// or https://'
      );
    }
  });

  it('rejects file: scheme with specific message', () => {
    const res = repositoryUrlSchema.safeParse('file:///etc/passwd');
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe(
        'Repository URL must start with http:// or https://'
      );
    }
  });

  it('rejects ftp: scheme with specific message', () => {
    const res = repositoryUrlSchema.safeParse('ftp://example.com/repo');
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe(
        'Repository URL must start with http:// or https://'
      );
    }
  });

  it('rejects arbitrary non-URL text with specific message', () => {
    const res = repositoryUrlSchema.safeParse('not a url');
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe(
        'Repository URL must start with http:// or https://'
      );
    }
  });

  it('accepts empty string and transforms to undefined (no value)', () => {
    const res = repositoryUrlSchema.safeParse('');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toBeUndefined();
    }
  });

  it('accepts omitted (undefined) value', () => {
    const res = repositoryUrlSchema.safeParse(undefined);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toBeUndefined();
    }
  });

  it('accepts whitespace-only string and transforms to undefined (no value)', () => {
    const res = repositoryUrlSchema.safeParse('   ');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toBeUndefined();
    }
  });

  it('trims leading and trailing whitespace from valid URLs', () => {
    const res = repositoryUrlSchema.safeParse('   https://github.com/forgeflow/trimmed   ');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toBe('https://github.com/forgeflow/trimmed');
    }
  });

  it('rejects URL exceeding 2048 characters', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2040);
    const res = repositoryUrlSchema.safeParse(longUrl);
    expect(res.success).toBe(false);
  });
});
