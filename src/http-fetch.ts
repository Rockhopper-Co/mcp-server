import { Agent, type Dispatcher } from 'undici';

let insecureTlsDispatcher: Dispatcher | undefined;

function getInsecureTlsDispatcher(): Dispatcher {
  insecureTlsDispatcher ??= new Agent({
    connect: { rejectUnauthorized: false },
  });
  return insecureTlsDispatcher;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/** Skip TLS verification for local/dev API (self-signed HTTPS). */
export function shouldSkipTlsVerify(baseUrl: string): boolean {
  if (isTruthyEnv(process.env.ROCKHOPPER_TLS_INSECURE)) {
    return true;
  }
  if (process.env.NODE_ENV === 'development') {
    return true;
  }
  try {
    const { protocol, hostname } = new URL(baseUrl);
    if (protocol !== 'https:') return false;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

export function rockhopperFetch(
  url: string,
  init?: RequestInit,
  baseUrl?: string,
): ReturnType<typeof fetch> {
  const origin = baseUrl ?? new URL(url).origin;
  const options: RequestInit & { dispatcher?: Dispatcher } = { ...init };
  if (shouldSkipTlsVerify(origin)) {
    options.dispatcher = getInsecureTlsDispatcher();
  }
  return fetch(url, options);
}
