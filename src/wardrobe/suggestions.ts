/**
 * A suggestion and its option group (Muse phase 1, #333; the design is
 * docs/plans/2026-10-05-muse-suggestions.md, section 3). A suggestion is a
 * wishlist garment with provenance (garment.suggested_at and the columns
 * beside it); an option group is one need holding its sibling suggestions
 * (option_group). Deciding between them is feedback to the agent, so
 * nothing here deletes: a turned-down pick or need is dismissed, with a
 * reason, and can be undone. Pure: decideSuggestion answers which rows
 * change, and the one writer (decide, src/web/wishlist/decisions.ts) holds
 * the owner lock, reads the group and its picks, asks it and writes that.
 *
 *   group      open ──choose / bought──▶ resolved
 *                │ ◀──── undo (chosen, not bought) / returned / dismiss chosen
 *                └──dismiss──▶ dismissed ──undo──▶ open
 *
 *   decision      what it takes                      what it writes
 *   choose        an open pick of an open group      group resolved by it; the
 *                                                    other open picks chose_another
 *   dismiss-pick  an open or chosen pick             the pick dismissed (the
 *                                                    owner's reason); a chosen one
 *                                                    reopens its group
 *   undo-pick     a pick dismissed by the owner or   the pick open again
 *                 chose_another, its group open
 *   dismiss-group an open group                      group dismissed (reason, note)
 *   undo-group    a dismissed group, or one resolved group open; a choice's
 *                 by a pick still on the wishlist    chose_another siblings restored
 *   bought        a garment bought for the group     group resolved by it; every
 *                 (a pick, or "a different one")     other open pick chose_another
 *   returned      the group's bought garment         it dismissed `returned`; the
 *                                                    group open again
 *
 * Refused on purpose: a purchase is never undone (Returned is its undo),
 * and a pick is restored only into an open group (undo the group's
 * decision first), so no group is resolved while it shows open picks.
 */

export const OPTION_GROUP_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type OptionGroupStatus = (typeof OPTION_GROUP_STATUSES)[number];

/**
 * Why something was set aside: the owner's one tap (the first six), and
 * the app's own (chose_another: a sibling was chosen or bought; returned:
 * bought, then returned). A check constraint lists them on garment and
 * option_group.
 */
export const DISMISS_REASONS = [
  'too_pricey',
  'colour',
  'style',
  'already_have',
  'fit_size',
  'not_now',
  'chose_another',
  'returned',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** The reasons the owner may give ("Not for me"). */
export const OWNER_DISMISS_REASONS = [
  'too_pricey',
  'colour',
  'style',
  'already_have',
  'fit_size',
  'not_now',
] as const satisfies readonly DismissReason[];
export type OwnerDismissReason = (typeof OWNER_DISMISS_REASONS)[number];

/** Muse's options for one need: the most a group holds, ranked 1 to this. */
export const MAX_OPTIONS_PER_GROUP = 5;

/** A group as the writer read it. */
export interface GroupState {
  status: OptionGroupStatus;
  resolvedGarmentId: number | null;
  /** When it left `open` (the transaction's time); null while open. */
  decidedAt: Date | null;
}

/** A garment of the group (its picks, and the one that resolved it) as read. */
export interface PickState {
  id: number;
  /** Still on the wishlist; false once bought (closet or archived). */
  wanted: boolean;
  dismissedAt: Date | null;
  dismissedReason: DismissReason | null;
}

export type SuggestionDecision =
  | { kind: 'choose'; garmentId: number }
  | {
      kind: 'dismiss-pick';
      garmentId: number;
      reason: OwnerDismissReason;
      note: string | null;
    }
  | { kind: 'undo-pick'; garmentId: number }
  | { kind: 'dismiss-group'; reason: OwnerDismissReason; note: string | null }
  | { kind: 'undo-group' }
  | { kind: 'bought'; garmentId: number }
  | { kind: 'returned'; garmentId: number };

/** The group's new state; `decided` stamps decided_at with the transaction's time, else clears it. */
export interface GroupChange {
  status: OptionGroupStatus;
  resolvedGarmentId: number | null;
  decided: boolean;
  dismissedReason: OwnerDismissReason | null;
  /** Written only by dismiss-group; undefined leaves the stored note. */
  ownerNote?: string | null;
}

export interface Dismissal {
  garmentId: number;
  reason: DismissReason;
  note: string | null;
}

export type DecisionRefusal =
  /** The garment is not one of the group's (or has no group to decide). */
  | 'not-in-group'
  /** The group or pick is not where the decision applies (a stale page, a double tap): a 409. */
  | 'not-allowed';

export type DecisionOutcome =
  | {
      ok: true;
      /** Undefined: the group stays as it is. */
      group: GroupChange | undefined;
      dismiss: Dismissal[];
      /** Picks open again (their dismissal cleared). */
      restore: number[];
    }
  | { ok: false; refusal: DecisionRefusal };

const refused = (refusal: DecisionRefusal): DecisionOutcome => ({
  ok: false,
  refusal,
});

const REOPENED: GroupChange = {
  status: 'open',
  resolvedGarmentId: null,
  decided: false,
  dismissedReason: null,
};

/** A pick that can still be chosen or set aside: on the wishlist, not dismissed. */
function isOpen(pick: PickState): boolean {
  return pick.wanted && pick.dismissedAt === null;
}

/** The other open picks, set aside because another was chosen or bought. */
function othersAside(picks: readonly PickState[], kept: number): Dismissal[] {
  return picks
    .filter((pick) => pick.id !== kept && isOpen(pick))
    .map((pick) => ({
      garmentId: pick.id,
      reason: 'chose_another',
      note: null,
    }));
}

/**
 * What `decision` changes, or why it is refused. `group` is undefined for
 * a suggestion outside any group (only its own dismissal applies);
 * `picks` are the group's garments (its picks and its resolving garment),
 * or the lone suggestion.
 */
export function decideSuggestion(
  group: GroupState | undefined,
  picks: readonly PickState[],
  decision: SuggestionDecision,
): DecisionOutcome {
  switch (decision.kind) {
    case 'undo-group':
      return undoGroup(group, picks);
    case 'dismiss-group':
      if (!group) return refused('not-in-group');
      if (group.status !== 'open') return refused('not-allowed');
      return {
        ok: true,
        group: {
          status: 'dismissed',
          resolvedGarmentId: null,
          decided: true,
          dismissedReason: decision.reason,
          ownerNote: decision.note,
        },
        dismiss: [],
        restore: [],
      };
    case 'bought':
      // The garment need not be a pick: "Bought a different one" resolves
      // the group with a garment of the owner's own.
      return group
        ? resolvedBy(picks, decision.garmentId)
        : refused('not-in-group');
    default: {
      const pick = picks.find((p) => p.id === decision.garmentId);
      return pick
        ? decideOnPick(group, picks, pick, decision)
        : refused('not-in-group');
    }
  }
}

/** The group resolved by `garmentId`, every other open pick set aside. */
function resolvedBy(
  picks: readonly PickState[],
  garmentId: number,
): DecisionOutcome {
  return {
    ok: true,
    group: {
      status: 'resolved',
      resolvedGarmentId: garmentId,
      decided: true,
      dismissedReason: null,
    },
    dismiss: othersAside(picks, garmentId),
    restore: [],
  };
}

/** The decisions about one of the group's garments. */
function decideOnPick(
  group: GroupState | undefined,
  picks: readonly PickState[],
  pick: PickState,
  decision: Extract<
    SuggestionDecision,
    { kind: 'choose' | 'dismiss-pick' | 'undo-pick' | 'returned' }
  >,
): DecisionOutcome {
  // A chosen pick set aside, or a bought one returned, reopens its need.
  const reopens = group?.resolvedGarmentId === pick.id ? REOPENED : undefined;
  switch (decision.kind) {
    case 'choose':
      if (!group) return refused('not-in-group');
      return group.status === 'open' && isOpen(pick)
        ? resolvedBy(picks, pick.id)
        : refused('not-allowed');
    case 'dismiss-pick':
      if (!isOpen(pick)) return refused('not-allowed');
      return {
        ok: true,
        group: reopens,
        dismiss: [
          { garmentId: pick.id, reason: decision.reason, note: decision.note },
        ],
        restore: [],
      };
    case 'undo-pick':
      return canRestore(group, pick)
        ? { ok: true, group: undefined, dismiss: [], restore: [pick.id] }
        : refused('not-allowed');
    case 'returned':
      if (pick.wanted || pick.dismissedReason === 'returned') {
        return refused('not-allowed');
      }
      return {
        ok: true,
        group: reopens,
        dismiss: [{ garmentId: pick.id, reason: 'returned', note: null }],
        restore: [],
      };
  }
}

/** A pick set aside (not returned) and still wanted, whose group is open. */
function canRestore(group: GroupState | undefined, pick: PickState): boolean {
  return (
    pick.wanted &&
    pick.dismissedAt !== null &&
    pick.dismissedReason !== 'returned' &&
    (group === undefined || group.status === 'open')
  );
}

function undoGroup(
  group: GroupState | undefined,
  picks: readonly PickState[],
): DecisionOutcome {
  if (!group) return refused('not-in-group');
  if (group.status === 'dismissed') {
    return { ok: true, group: REOPENED, dismiss: [], restore: [] };
  }
  if (group.status !== 'resolved') return refused('not-allowed');
  const chosen = picks.find((p) => p.id === group.resolvedGarmentId);
  // Resolved by a purchase (or by a garment deleted since): Returned is its undo.
  if (!chosen?.wanted) return refused('not-allowed');
  const decidedAt = group.decidedAt?.getTime();
  return {
    ok: true,
    group: REOPENED,
    dismiss: [],
    // The siblings this choice set aside: dismissed in its own transaction,
    // so at the very time it stamped on the group.
    restore: picks
      .filter(
        (p) =>
          p.wanted &&
          p.dismissedReason === 'chose_another' &&
          p.dismissedAt?.getTime() === decidedAt,
      )
      .map((p) => p.id),
  };
}
