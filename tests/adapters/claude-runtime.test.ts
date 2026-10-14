import { describe, expect, it, vi } from 'vitest';
import { claudeEnvironment } from '../../src/adapters/providers/claude-runtime.js';

describe('Claude process environment', () => {
  it('preserves operating-system identity while isolating subscription/API credentials', () => {
    vi.stubEnv('USER', 'design-user');
    vi.stubEnv('LOGNAME', 'design-login');
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-api-sentinel');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token-sentinel');
    vi.stubEnv('CLAUDE_CODE_ENABLE_TELEMETRY', 'custom-config-sentinel');
    try {
      const subscription = claudeEnvironment('claude-subscription');
      expect(subscription).toMatchObject({ USER: 'design-user', LOGNAME: 'design-login' });
      expect(subscription).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(subscription).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      expect(subscription).not.toHaveProperty('CLAUDE_CODE_ENABLE_TELEMETRY');

      const apiKey = claudeEnvironment('anthropic-api-key', 'selected-key-sentinel');
      expect(apiKey).toMatchObject({ USER: 'design-user', LOGNAME: 'design-login', ANTHROPIC_API_KEY: 'selected-key-sentinel' });
      expect(apiKey).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    } finally { vi.unstubAllEnvs(); }
  });
});
