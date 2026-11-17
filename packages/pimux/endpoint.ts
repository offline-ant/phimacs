/** Remove HTTP endpoint credentials before publishing diagnostics or identities. */
export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (!url.username && !url.password) return endpoint;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return endpoint;
  }
}
