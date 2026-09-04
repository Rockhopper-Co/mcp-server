/**
 * ENG-4384 — name a person from the name parts we actually hold.
 *
 * `UserSummary.firstName` and `lastName` are `string | null`, and both columns
 * are `nullable: true` on the backend user row
 * (`backend/src/resources/users/entities/user.entity.ts:146-150`). Two call
 * sites interpolated them straight into a template literal, so a requester
 * carrying neither rendered as the literal four-character word twice —
 * `requested by null null` — and one carrying only a surname rendered
 * `requested by null Whitfield`. A model reads that as the person's name and
 * relays it.
 *
 * WHY IT WAS UNREACHABLE UNTIL NOW. A Microsoft or Google sign-in supplies the
 * given and family name from the provider profile, so every legacy account has
 * a `firstName`. An identity-service account, and any user invited but not yet
 * through a profile step, has neither — the same reason ENG-4219, ENG-4220,
 * ENG-4222 and ENG-4279 became reachable in this package.
 *
 * ITS OWN MODULE so it is a pure function two surfaces share rather than a
 * shape copied into each — the twin at `prompts/index.ts` is exactly how the
 * defect came to exist in two places at once. Same reasoning as
 * `auth/remediation.ts`.
 *
 * DELIBERATELY NO EMAIL RUNG, and this is the one place to state it. The
 * backend's `getFullUserNameOrEmail` (`backend/src/helpers/strings.ts:120-131`)
 * falls through to `email` and then `username`, and both are the SAME value
 * here — `username` is written with the email address
 * (`backend/src/auth/auth.service.ts:405`,
 * `backend/src/resources/users/users.service.ts:437`). ENG-4349 shipped in this
 * package to stop a plain read handing the model a colleague's email address;
 * adding one back on this path would trade one wrong answer for another.
 * Whether a nameless person should be identified by email on a read is a
 * product decision, not this function's to make — so it returns `null` and
 * lets the caller say what it already says when it cannot name somebody.
 */

/** The name parts a person may carry, as any caller in this package holds them. */
export interface NameParts {
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * The person's display name, or `null` when we hold no name for them.
 *
 * `null` for a nullish user too, so a caller does not need its own presence
 * check before asking — `displayUserName(r.requester) ?? 'Unknown'` covers the
 * absent user and the nameless one with one expression, which is the point:
 * those two cases were answered differently, and only one of them was right.
 *
 * Whitespace-only is treated as absent. The backend trims on the same question
 * (`getFullUserNameOrEmail`), and a name of `' '` renders as a blank where a
 * reader sees nothing at all rather than "unknown".
 */
export function displayUserName(user: NameParts | null | undefined): string | null {
  if (user == null) return null;
  const parts = [user.firstName, user.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' ') : null;
}
