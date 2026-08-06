import { describe, it, expect } from 'vitest';
import { route, normalize } from './router.js';

describe('route', () => {
	it('routes the known methods', () => {
		expect(route({ method: 'GET', path: '/a' })).toBe('read /a');
		expect(route({ method: 'POST', path: '/a' })).toBe('create /a');
		expect(route({ method: 'DELETE', path: '/a' })).toBe('remove /a');
	});

	it('rejects unknown methods', () => {
		expect(() => route({ method: 'HEAD', path: '/a' })).toThrow(/unsupported method/);
	});
});

describe('normalize', () => {
	it('adds a leading slash', () => {
		expect(normalize('a/b')).toBe('/a/b');
	});

	it('strips trailing slashes', () => {
		expect(normalize('/a/b//')).toBe('/a/b');
		expect(normalize('/')).toBe('/');
	});
});
