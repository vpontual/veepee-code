import { describe, it, expect } from 'vitest';
import { ModelManager } from '../src/models.js';
import type { Config } from '../src/config.js';

// Helper to create a minimal config
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    proxyUrl: 'http://localhost:11434',
    dashboardUrl: '',
    model: null,
    autoSwitch: true,
    maxTurns: 50,
    maxModelSize: 40,
    minModelSize: 6,
    ha: null,
    mastodon: null,
    spotify: null,
    google: null,
    newsfeedUrl: null,
    searxngUrl: null,
    sync: null,
    rc: null,
    ...overrides,
  };
}

describe('ModelManager', () => {
  describe('construction and config', () => {
    it('creates with default config', () => {
      const mm = new ModelManager(makeConfig());
      expect(mm.getAllModels()).toEqual([]);
    });

    it('respects preferred model from config', () => {
      const mm = new ModelManager(makeConfig({ model: 'qwen3:8b' }));
      // No models loaded yet, so selectDefault should throw
      expect(() => mm.selectDefault()).toThrow('No models available');
    });
  });

  describe('auto-switch evaluation', () => {
    it('returns null when auto-switch is disabled', () => {
      const mm = new ModelManager(makeConfig({ autoSwitch: false }));
      const result = mm.evaluate({
        fileOpsCount: 10,
        errorCount: 5,
        toolCallsLastTurn: 5,
        avgUserMessageLength: 1000,
        uniqueFilesTouched: 10,
      });
      expect(result).toBeNull();
    });

    it('returns null when no current model', () => {
      const mm = new ModelManager(makeConfig());
      // No models, no current model — should return null without throwing
      const result = mm.evaluate({
        fileOpsCount: 0,
        errorCount: 0,
        toolCallsLastTurn: 0,
        avgUserMessageLength: 100,
        uniqueFilesTouched: 0,
      });
      expect(result).toBeNull();
    });
  });

  describe('switchTo', () => {
    it('sets the current model', () => {
      const mm = new ModelManager(makeConfig());
      mm.switchTo('test-model:8b');
      expect(mm.getCurrentModel()).toBe('test-model:8b');
    });
  });

  describe('getModelsByTier', () => {
    it('returns empty array for empty model list', () => {
      const mm = new ModelManager(makeConfig());
      expect(mm.getModelsByTier('heavy')).toEqual([]);
      expect(mm.getModelsByTier('standard')).toEqual([]);
      expect(mm.getModelsByTier('light')).toEqual([]);
    });
  });

  describe('setAutoSwitch', () => {
    it('can toggle auto-switch', () => {
      const mm = new ModelManager(makeConfig({ autoSwitch: true }));
      mm.setAutoSwitch(false);
      mm.switchTo('some-model');

      // With auto-switch off, evaluate should return null
      const result = mm.evaluate({
        fileOpsCount: 100,
        errorCount: 100,
        toolCallsLastTurn: 100,
        avgUserMessageLength: 5000,
        uniqueFilesTouched: 50,
      });
      expect(result).toBeNull();
    });
  });

  describe('formatModelList', () => {
    it('returns string output for empty model list', () => {
      const mm = new ModelManager(makeConfig());
      const output = mm.formatModelList();
      expect(typeof output).toBe('string');
    });
  });
});
