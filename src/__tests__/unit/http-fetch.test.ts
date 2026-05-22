import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldSkipTlsVerify } from '../../http-fetch.js';

describe('shouldSkipTlsVerify', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should skip when NODE_ENV is development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ROCKHOPPER_TLS_INSECURE', '');
    expect(shouldSkipTlsVerify('https://api.rockhopper.co')).toBe(true);
  });

  it('should skip when ROCKHOPPER_TLS_INSECURE is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ROCKHOPPER_TLS_INSECURE', '1');
    expect(shouldSkipTlsVerify('https://api.rockhopper.co')).toBe(true);
  });

  it('should skip for https localhost without dev flags', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ROCKHOPPER_TLS_INSECURE', '');
    expect(shouldSkipTlsVerify('https://localhost:3100')).toBe(true);
  });

  it('should not skip for production API in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ROCKHOPPER_TLS_INSECURE', '');
    expect(shouldSkipTlsVerify('https://api.rockhopper.co')).toBe(false);
  });
});
