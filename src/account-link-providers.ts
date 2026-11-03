import type { ApiClient } from './api-client.js';
import type { AccountConnectHandoff, FileProvider } from './types.js';

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
  /**
   * Set when the stored connection exists but is not usable, with the one next
   * step that applies. Replaces the plain "not connected" line.
   */
  note?: string;
}

export interface AccountLinkProvider {
  /** Tool-name stem: `connect_<key>`, `<key>_link_status`, `disconnect_<key>`. */
  key: 'microsoft' | 'google' | 'smartsheet';
  /** The noun a user reads: "your Microsoft account". */
  label: 'Microsoft' | 'Google' | 'Smartsheet';
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

/**
 * What a stored Smartsheet connection that is not `connected` means to the
 * user. Matched exactly: a status this build does not know reads as plainly
 * connected-but-unclear, never as a guess.
 */
function smartsheetNote(status: string): string | undefined {
  switch (status) {
    case 'needs_reconnect':
      return (
        'A Smartsheet account is on file but Rockhopper can no longer use it. ' +
        'Run `connect_smartsheet` to connect it again.'
      );
    case 'scopes_insufficient':
      return (
        'A Smartsheet account is on file but it did not grant the access ' +
        'Rockhopper needs. Run `connect_smartsheet` and approve every item ' +
        'on the consent screen.'
      );
    case 'plan_lacks_api_access':
      return (
        'The connected Smartsheet account is on a plan without API access, ' +
        'so Rockhopper cannot read its sheets. Connecting again will not ' +
        'change that; the account needs a plan that includes the API.'
      );
    default:
      return undefined;
  }
}

export const SMARTSHEET_LINK: AccountLinkProvider = {
  key: 'smartsheet',
  label: 'Smartsheet',
  purpose: 'search and read their Smartsheet sheets',
  statusDescription:
    'Check whether the user has connected a Smartsheet account, which ' +
    'account it is, and whether the connection is usable. Never returns any ' +
    'token.',
  readOnlyConsent: false,
  begin: (api) => api.beginSmartsheetConnect(),
  status: async (api) => {
    const s = await api.getSmartsheetLink();
    const link = s.links.find((l) => l.status === 'connected') ?? s.links[0];
    if (!link) {
      return {
        linked: false,
        account: null,
        grantedScopes: [],
        linkedAt: null,
      };
    }
    const note = smartsheetNote(link.status);
    return {
      linked: note === undefined,
      account: link.accountLabel,
      grantedScopes: [],
      linkedAt: link.linkedAt,
      ...(note === undefined ? {} : { note }),
    };
  },
  unlink: (api) => api.unlinkSmartsheet(),
};

export const ACCOUNT_LINK_PROVIDERS: readonly AccountLinkProvider[] = [
  MICROSOFT_LINK,
  GOOGLE_LINK,
  SMARTSHEET_LINK,
];

/**
 * The link row for a file provider. Total over the union: a provider added
 * without a row fails to compile here instead of taking another's remedy.
 */
export function accountLinkFor(provider: FileProvider): AccountLinkProvider {
  switch (provider) {
    case 'microsoft':
      return MICROSOFT_LINK;
    case 'google':
      return GOOGLE_LINK;
    case 'smartsheet':
      return SMARTSHEET_LINK;
    default: {
      const unhandled: never = provider;
      throw new Error(`Unknown file provider: ${String(unhandled)}`);
    }
  }
}

export const statusToolName = (p: AccountLinkProvider): string =>
  `${p.key}_link_status`;
export const connectToolName = (p: AccountLinkProvider): string =>
  `connect_${p.key}`;
