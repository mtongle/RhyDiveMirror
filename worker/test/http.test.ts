import { describe, expect, it } from 'vitest';
import { applyCors, parseRange, splitSetCookie, stripHopByHop } from '../src/http';
import { scopeCookie } from '../src/proxy';

describe('parseRange', () => {
  it('handles the forms the client actually sends', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('bytes=0-99', 1000)).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ offset: 500, length: 500 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ offset: 900, length: 100 });
    expect(parseRange('bytes=0-100000', 1000)).toEqual({ offset: 0, length: 1000 });
    expect(parseRange('bytes=-100000', 1000)).toEqual({ offset: 0, length: 1000 });
  });

  it('rejects malformed and unsatisfiable ranges, and ignores unknown range units per RFC 7233', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=500-100', 1000)).toBe('unsatisfiable');
    // Unknown unit MUST return null (ignore range, serve 200 OK) per RFC 7233 §3.1
    expect(parseRange('items=0-10', 1000)).toBeNull();
    // Multi-ranges return null per RFC 7233 §4.4
    expect(parseRange('bytes=0-10, 20-30', 1000)).toBeNull();
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=abc-def', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
  });
});

describe('splitSetCookie', () => {
  it('keeps an Expires date intact while splitting cookies', () => {
    const merged =
      'sid=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly, theme=dark; Path=/';
    expect(splitSetCookie(merged)).toEqual([
      'sid=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly',
      'theme=dark; Path=/',
    ]);
  });
});

describe('scopeCookie', () => {
  it('drops the upstream Domain so the mirror host can store it', () => {
    expect(scopeCookie('sid=abc; Domain=sta.lunprin.com; Path=/; HttpOnly; SameSite=Lax')).toBe(
      'sid=abc; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('drops Secure for plain-HTTP development hosts only', () => {
    expect(scopeCookie('sid=abc; Path=/; Secure', 'localhost:8787')).toBe('sid=abc; Path=/');
    expect(scopeCookie('sid=abc; Path=/; Secure', 'mirror.example.com')).toBe('sid=abc; Path=/; Secure');
  });
});

describe('stripHopByHop', () => {
  it('removes connection-scoped headers but keeps end-to-end ones', () => {
    const headers = new Headers({
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      host: 'mirror.example.com',
      'content-length': '12',
      cookie: 'sid=1',
    });
    const out = stripHopByHop(headers);
    expect(out.get('connection')).toBeNull();
    expect(out.get('transfer-encoding')).toBeNull();
    expect(out.get('host')).toBeNull();
    expect(out.get('content-length')).toBe('12');
    expect(out.get('cookie')).toBe('sid=1');
  });
});

describe('applyCors', () => {
  it('reflects trusted origins and allows credentials', () => {
    const trusted = applyCors(new Response('ok'), new Request('https://mirror.test/x', {
      headers: { origin: 'rhydive://app' },
    }));
    expect(trusted.headers.get('access-control-allow-origin')).toBe('rhydive://app');
    expect(trusted.headers.get('access-control-allow-credentials')).toBe('true');
    expect(trusted.headers.get('vary')).toContain('Origin');
  });

  it('restricts untrusted origins to wildcard without credentials', () => {
    const untrusted = applyCors(new Response('ok'), new Request('https://mirror.test/x', {
      headers: { origin: 'https://evil.attacker.com' },
    }));
    expect(untrusted.headers.get('access-control-allow-origin')).toBe('*');
    expect(untrusted.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
