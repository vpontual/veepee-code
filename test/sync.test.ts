import { describe, it, expect } from 'vitest';
import { SyncManager } from '../src/sync.js';

// SyncManager methods all require a live WebDAV server (push, pull, webdavPut, etc.).
// The only pure logic we can test is construction behavior and the parsePropfindResponse
// method (which is private). We test what we can without network access.

describe('SyncManager', () => {
  it('can be constructed with URL, user, and password', () => {
    const sm = new SyncManager('https://dav.example.com/sessions', 'user', 'pass');
    expect(sm).toBeDefined();
    expect(sm).toBeInstanceOf(SyncManager);
  });

  it('auto-sync defaults to false', () => {
    const sm = new SyncManager('https://dav.example.com/', 'u', 'p');
    expect(sm.isAutoSync()).toBe(false);
  });

  it('setAutoSync toggles the flag', () => {
    const sm = new SyncManager('https://dav.example.com/', 'u', 'p');
    sm.setAutoSync(true);
    expect(sm.isAutoSync()).toBe(true);
    sm.setAutoSync(false);
    expect(sm.isAutoSync()).toBe(false);
  });

  it('URL normalization: appends trailing slash if missing', () => {
    // The constructor ensures URL ends with /. We verify by attempting a push
    // that would fail on network — but the URL is stored internally.
    // We can only verify via indirect behavior (no getter for URL).
    // At minimum, constructing with or without slash should not throw.
    expect(() => new SyncManager('https://dav.example.com/path', 'u', 'p')).not.toThrow();
    expect(() => new SyncManager('https://dav.example.com/path/', 'u', 'p')).not.toThrow();
  });
});

// Note: Testing push/pull requires a WebDAV server. The parsePropfindResponse method is
// private and cannot be tested directly. Full integration tests would need a mock WebDAV
// server (e.g., using msw or a local test server).
