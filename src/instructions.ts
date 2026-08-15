import {
  PAT_CAPABILITIES,
  registeredToolsForCapabilities,
  type PatCapability,
} from './capabilities.js';

/**
 * ENG-2212 — the `instructions` string the model reads, built from the SAME
 * families that decide which registrars run.
 *
 * It used to say one of two things: "this token is read-only", or a list of
 * all nine write tools. A token holding `comments:write` alone got the second
 * sentence and was told `discard_changes` existed — so the model planned work
 * it could not perform, and the customer's narrowing surfaced as a
 * method-not-found error mid-task.
 */

const PREAMBLE =
  'Rockhopper MCP server for managing Excel file metadata. ' +
  'Use list_files first to discover available files, then drill into ' +
  'versions, comments, reviews, or cell history. ';

const FILE_IDS =
  'File IDs use the platformId field (e.g. from list_files output).';

/** What each family is called in a sentence a model reads. */
const FAMILY_PROSE: Readonly<Record<PatCapability, string>> = {
  'comments:write': 'comments',
  'reviews:write': 'reviews',
  'versions:write': 'versions',
  'files:write': 'files',
};

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function buildInstructions(
  capabilities: readonly PatCapability[],
): string {
  if (capabilities.length === 0) {
    return (
      'Rockhopper MCP server for reading Excel file metadata. ' +
      'Use list_files first to discover available files, then drill into ' +
      'versions, comments, reviews, or cell history. ' +
      'This token is read-only — write operations are not available. ' +
      FILE_IDS
    );
  }

  const granted = registeredToolsForCapabilities(capabilities);
  const withheld = PAT_CAPABILITIES.filter((c) => !capabilities.includes(c));
  const withheldSentence =
    withheld.length === 0
      ? ''
      : `No other write operations are available to this token — it was not granted ${list(
          withheld.map((c) => FAMILY_PROSE[c]),
        )}. `;

  return (
    PREAMBLE +
    `This token may write ${list(
      capabilities.map((c) => FAMILY_PROSE[c]),
    )}: ${granted.join(', ')}. ` +
    withheldSentence +
    FILE_IDS
  );
}
