/** Pi's stored provider credentials for the CLI, resolved per request from an agent directory. */
import path from 'node:path';
import type { CredentialResolver } from './speech.ts';

/** Same resolution as Pi itself: stored key, configured command/variable, or the provider's environment. */
export function piCredentials(agentDir: string): CredentialResolver {
  return async (provider, signal) => {
    // The Pi SDK is an optional peer that takes about two seconds to import. Loading it only when a
    // backend asks for credentials keeps dictation and credential-free speech fast and SDK-free.
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false, signal });
    let key: string | undefined;
    try { key = (await runtime.getAuth(provider, { signal }))?.auth.apiKey; }
    finally { await runtime.settleCredentialWrites(); }
    if (!key) throw new Error(`No API key for Pi provider "${provider}". Configure it with Pi's /login or its environment variable.`);
    return key;
  };
}
