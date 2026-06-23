/**
 * Resolves the network interface the HTTP server binds to.
 *
 * Defaults to loopback (127.0.0.1) so `./mc` is never exposed beyond the
 * host without an explicit opt-in.
 */
export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env["HARNESS_HOST"]?.trim();
  return host ? host : "127.0.0.1";
}
