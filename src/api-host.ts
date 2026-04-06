/**
 * Resolve API bind host with RC compatibility.
 *
 * Security default is localhost-only. When RC is enabled, we widen loopback
 * binds so phones/LAN clients can reach /rc unless the user explicitly passed
 * a CLI host override.
 */
export function resolveApiHost(
  cliHost: string | undefined,
  configHost: string,
  rcEnabled: boolean,
): string {
  let apiHost = cliHost || configHost;
  if (rcEnabled && !cliHost && isLoopbackHost(apiHost)) {
    apiHost = '0.0.0.0';
  }
  return apiHost;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

