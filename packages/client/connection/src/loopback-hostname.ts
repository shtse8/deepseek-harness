/**
 * Browser-safe, zero-dependency loopback classification shared by the `/api`
 * Host fence and the package's `ctx.connection` state. The predicate stays
 * package-internal; client plugins consume the derived state through Cordis.
 */

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Page hostnames whose browsers should use the Host settings document.
 * Pair with `dsh web --trusted-host <hostname>` and an authenticating
 * reverse proxy (this deployment: Cloudflare Access on dsh.kylet.se
 * and lib.kylet.se).
 */
export const TRUSTED_REMOTE_PAGE_HOSTS = new Set(['dsh.kylet.se', 'lib.kylet.se'])

/** True when the browser should call Host settings/credentials RPCs. */
export function pageUsesHostSettings(hostname: string): boolean {
  return isLoopbackHostname(hostname) || TRUSTED_REMOTE_PAGE_HOSTS.has(hostname)
}
