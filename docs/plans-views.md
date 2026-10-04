# The plan page's views (#312)

`GET /wardrobe/plans/:id[?view=items|outfits]` (`src/web/plans/plan-page.tsx`).

- **`?view=`** is URL state: `planView()` falls back to Items for anything else (never a 400). The tabs (`PlanViewTabs`) are boosted `<a href>`s, Items being the bare address (`planViewUrl`). Items shows the sections and the declined list; Outfits shows today's Looks strip and the revise/declined looks (#314 designs it).
- **Items by type**: sections by role, top to toe (`planSections`), each heading with its count, in a grid of 2 columns at base, 3 at `sm`, 4 at `lg`, 5 at `xl` (CSS only, one markup). A card is a button: the photo (the owned garment's, else the top candidate's, else the glyph), the name and **one status line** (`statusLine`: "Owned", "To buy · $90" from the top-ranked candidate, "2 of 3", "To review", "With your agent"). It opens the item's `<dialog>` sheet (`ItemSheet`, native `showModal`), which holds what the card used to: status chip, budget, priority, options and Add a product, In your closet, the reason, the owner's note, the review moves, Change this, Edit item; every action is the existing route.
- **Header**: one tally line (`PlanTally`); a draft with only proposals has no "0 owned" tally, the proposals banner (with Review) says what waits. Shopping list and Compare are in the plan's ⋯ menu.
- **The plans list card** counts a draft with nothing accepted as "N proposed · N looks", never "0 items".
- The page's statement count is pinned in `plan-look-reactions.spec.ts` (6); views add none. The page's `<main>` is wider than the layout default (`sm:max-w-2xl lg:max-w-5xl`) until the layout's width tokens (#309) replace it.
