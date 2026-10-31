import { describe, expect, it } from 'vitest';
import { carriesUserinfo } from '../../src/primitives/url-userinfo.js';

describe('carriesUserinfo', () => {
  it('finds a user name or password in every spelling the config and docs loaders refuse', () => {
    for (const url of [
      'https://user:SECRETPOISON@host.local/x',
      'https://user@host.local/x',
      'https:\\\\user:SECRETPOISON@host.local',
      'https://us\ter:SECRETPOISON@host.local',
      'admin:SECRETPOISON@localhost:3000/x',
      '//user:SECRETPOISON@host.local/x',
    ]) {
      expect(carriesUserinfo(url), url).toBe(true);
    }
  });

  it('accepts an @ in the path, the query, or the fragment', () => {
    for (const url of [
      'https://host.local/users/@alice',
      'https://host.local/x?mail=a@b',
      'https://host.local/x#a@b',
      'http://127.0.0.1:5173/',
    ]) {
      expect(carriesUserinfo(url), url).toBe(false);
    }
  });
});
