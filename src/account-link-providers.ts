import type { ApiClient } from './api-client.js';
import type { AccountConnectHandoff } from './types.js';

/**
 * ENG-6414 — the ONLY per-provider part of the account-link tools.
 *
 * `tools/account-link.ts` registers connect / status / disconnect once, from
 * this table. The link text, the never-compose-a-link rule, the expiry
 * wording and the disconnect wording are shared; what varies is the API call
 * at the end and a few nouns. The Microsoft row reproduces the wording the
 * three Microsoft tools carried before this table existed, byte for byte.
 */
export interface AccountLinkSummary {
  linked: boolean;
  account: string | null;
  grantedScopes: string[];
  linkedAt: string | null;
}

export interface AccountLinkProvider {
  /** Tool-name stem: `connect_<key>`, `<key>_link_status`, `disconnect_<key>`. */
  key: 'microsoft' | 'google';
  /** The noun a user reads: "your Microsoft account". */
  label: 'Microsoft' | 'Google';
  /** What connecting lets Rockhopper do, for the connect tool's description. */
  purpose: string;
  statusDescription: string;
  /**
   * True only where the consent really asks for read access alone. Google's
   * consent also requests `drive.file`, so the sentence would be false there.
   */
  readOnlyConsent: boolean;
  begin(api: ApiClient): Promise<AccountConnectHandoff>;
  status(api: ApiClient): Promise<AccountLinkSummary>;
  unlink(api: ApiClient): Promise<{ removed: boolean }>;
}

export const MICROSOFT_LINK: AccountLinkProvider = {
  key: 'microsoft',
  label: 'Microsoft',
  purpose: 'search their OneDrive and SharePoint files',
  statusDescription:
    'Check whether the user has connected a Microsoft account, which account ' +
    'it is, and what access was granted. Never returns any token.',
  readOnlyConsent: true,
  begin: (api) => api.beginMicrosoftConnect(),
  status: async (api) => {
    const s = await api.getMicrosoftLink();
    return {
      linked: s.linked,
      account: s.msAccountLabel,
      grantedScopes: s.grantedScopes,
      linkedAt: s.linkedAt,
    };
  },
  unlink: (api) => api.unlinkMicrosoft(),
};

export const GOOGLE_LINK: AccountLinkProvider = {
  key: 'google',
  label: 'Google',
  purpose: 'search and read their Google Drive files',
  statusDescription:
    'Check whether the user has connected a Google account for Google Drive, ' +
    'and which account it is. Never returns any token.',
  readOnlyConsent: false,
  begin: (api) => api.beginGoogleConnect(),
  status: async (api) => {
    const s = await api.getGoogleLink();
    // The backend reports no scope list or date for a Google grant, so none
    // is invented here.
    return {
      linked: s.linked,
      account: s.googleAccountLabel,
      grantedScopes: [],
      linkedAt: null,
    };
  },
  unlink: (api) => api.unlinkGoogle(),
};

export const ACCOUNT_LINK_PROVIDERS: readonly AccountLinkProvider[] = [
  MICROSOFT_LINK,
  GOOGLE_LINK,
];

export const statusToolName = (p: AccountLinkProvider): string =>
  `${p.key}_link_status`;
export const connectToolName = (p: AccountLinkProvider): string =>
  `connect_${p.key}`;
