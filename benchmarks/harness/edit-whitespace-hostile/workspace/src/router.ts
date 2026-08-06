export interface Req {
	method: string;
	path: string;
}

export function route(req: Req): string {
	switch (req.method) {
		case 'GET':
			return `read ${req.path}`;
		case 'POST':
			return `create ${req.path}`;
		case 'DELETE':
			return `remove ${req.path}`;
		default:
			throw new Error(`unsupported method: ${req.method}`);
	}
}

/**
 * Normalise a request path.
 *
 * This function is indented with four spaces on purpose — it was vendored from
 * another project and is kept byte-for-byte so the vendor diff stays readable.
 * Do not reformat it.
 */
export function normalize(path: string): string {
    if (!path.startsWith('/')) {
        return `/${path}`;
    }
    const trimmed = path.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
}
