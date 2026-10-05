# Muse's suggestions and option groups

Linked from `CLAUDE.md` in this directory (Wishlist). Phase 1 of epic #332 (#333); the design is `docs/plans/2026-10-05-muse-suggestions.md`, which replaces the plans feature's UI. PR A is the model and its migration, with no visible change; the inbox, the decision screen and the suggestion's page follow (PR B).

## The model

- **A suggestion is a wishlist garment with provenance**, not a new status: `garment.suggested_at` marks one (it is what "a suggestion" means; the token can be null), with `suggested_by_token_id` (the agent's personal access token, `ON DELETE SET NULL`), `suggestion_group_id`, `suggestion_note` (the agent's reasoning) and `suggestion_rank` (1 to `MAX_OPTIONS_PER_GROUP`, 5). The check `garment_suggestion_check` allows none of them without `suggested_at`. Every "owned" check already leaves the wishlist out, so a suggestion is out of every closet read with no change there.
- **An option group** (`option_group`) is one need: its name, budget, the agent's note and token, `status` (`open`, `resolved`, `dismissed`), `resolved_garment_id` (what settled it: a pick chosen or bought, or "a different one" the owner bought, linked only from here), `dismissed_reason`, the owner's note and `decided_at` (null exactly while open, by a check). It may hold no picks: a need the agent is still looking for. `plan_item_id` is the plan item `drizzle/0040` made it from, for the plan tools' shims until plans go (#337).
- **Dismissal, never deletion**: `garment.dismissed_at`, `dismissed_reason` (`DISMISS_REASONS`: the owner's six, `too_pricey`, `colour`, `style`, `already_have`, `fit_size`, `not_now`, and the app's `chose_another` and `returned`) and `dismissed_note`; a group's own reason and note when the need is turned down. A set-aside suggestion stays on the wishlist: it is the agent's feedback ("never propose this again").
- **Provenance is kept once bought.** That is why "provenance only on a wishlist garment" cannot be a check constraint: it is the writer's rule (`markSuggestion`, below).

## One writer each

- **`decide(db, ownerId, subject, decision)`** (`decisions.ts`) is every decision: This one (`choose`), Not for me on a pick (`dismiss-pick`) or a need (`dismiss-group`), their Undo (`undo-pick`, `undo-group`), a purchase settling the group (`bought`), and `returned` (which also archives the garment through `setGarmentStatus`). It holds the owner lock (every writer of these columns does, so no row lock is taken), reads the group and its garments in one statement, asks the pure machine (`decideSuggestion`, `src/wardrobe/suggestions.ts`, whose header has the table of every decision) and writes the answer in one statement (data-modifying CTEs, through Drizzle's `getSQL()`). A refusal is `not-found` (another owner's, a 404) or `not-allowed` (a stale page or a double tap, a 409).
- **A choice and the siblings it sets aside share one instant**: the group's `decided_at` and their `dismissed_at` are both the transaction's `now()`, which is how Undo restores exactly those siblings and not ones the owner set aside before.
- **A purchase is never undone**; `returned` is its undo (the garment archived, dismissed `returned`, its group open again). A pick is restored only into an open group, so no resolved group shows open picks.
- **"Bought it"** (`buyCandidate`, `src/web/plans/purchase.ts`) calls `decide(bought)` in its own transaction: a bought suggestion resolves its group and sets the other open picks aside, the chosen one included. A garment that is no suggestion finds no group and writes nothing.
- **`markSuggestion`** (`decisions.ts`) is provenance's writer: only the owner's wishlist garment, only once, only into their own group (one statement; a refusal writes nothing). The agent's tools call it from #337; the garment form never writes these columns and a clone never copies them (`insertGarment` takes form fields).

## What reads what

- **Closet reads keep `inCloset`**: no suggestion, in any state, is in the grid, Styling, capsules, laundry, tagging, Ideas, Today, insights or MCP's closet tools, and none can be worn, washed, lent or put in an outfit.
- **Lists of things to buy read `wanted`** (`src/web/wardrobe/status.ts`: on the wishlist and not set aside): the Wishlist tab, `list_wishlist`, plans' candidate readers (the shopping list, Today's next purchase, covers, Styling's To-buy row). A garment's own page, "Bought it" and goes-with keep `onWishlist`, as does the plans' candidate cap.

## The migration (`drizzle/0040_muse-suggestions.sql`)

Copies from the plan tables and never changes them, so the plans pages and tools keep working until #337. Each plan item becomes a group (its name, else its type or category; budget, note, owner's note; the drafted plan's token); a declined item is a dismissed need (`not_now`), every other review state open (matching targets, quantity, priority and proposed vs accepted are retired by the design). Each candidate's garment becomes its group's suggestion (the link's note, rank and time); a garment linked to several items (a duplicated plan) belongs to the lowest item id's, and an item whose every candidate went elsewhere (the copy) is left out. A group with a candidate already bought is resolved by it, its other open picks set aside at the same instant. A rejection (its garment deleted at the time) comes back as a photo-less dismissed suggestion, its free-text reason as the note and no reason of the fixed set. It aborts the boot on a candidate of another owner or a rejection URL that is not http(s).

Production on 2026-10-05: the owner's draft plan 14 (24 proposed items: 10 with no candidate, 4 with 1, 8 with 2, 2 with 3; 26 candidates; no rejections) becomes 24 open groups, 10 of them still looking. Its 8 looks are phase 2's. **Rollback**: the change is additive, so the previous image boots on it (drizzle applies nothing it does not know); only migrated rejections would show on its wishlist, removed by deleting the garments with `suggested_at` and `dismissed_at` set and no photo (an owner-approved write, in a transaction).

## Specs

`src/wardrobe/suggestions.spec.ts` (every decision and refusal of the machine), `test/integration/suggestions-migration.spec.ts` (0040 on production's shape and every other case, then the plans pages on the migrated data), `test/integration/suggestions.spec.ts` (the provenance rule, each decision's rows through `decide`, "Bought it" and Returned, nothing deleted, and the exclusions for an open, chosen, set-aside and lone suggestion).
