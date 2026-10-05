import type { Child } from 'hono/jsx';
import { PostForm } from '../auth/form';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { LOOK_GRID } from '../layout/columns';
import { HangerIcon } from '../layout/parts';
import { categoryLabel } from '../wardrobe/garment';
import { CHIPS, LookSaveAction, lookMeta } from './look-tile';
import type { LookGroups, LookSlotView, PlanLookView } from './looks';
import { lookUrl } from './urls';

/**
 * The plan page's Outfits panel (#314, owner feedback on #312's strip: one
 * small collage at a time, lost on a wide page): every look a large card,
 * every piece its own big labelled photo, in a grid (`LOOK_GRID`). Order and
 * sections are `groupLooks()`'s: loved then proposed in the grid, looks sent
 * back and turned down in collapsed `<details>` below. No strip, so no
 * script and no `data-strip-action`: each move is a plain native post.
 * Rows stretch to the tallest card and each card's moves sit at its foot, so
 * a row's cards line up. The Outfits tab's "From your plan" row keeps the
 * strip (outfits/list-page.tsx).
 */
export function PlanLookCards({ looks }: { looks: LookGroups }) {
  const total =
    looks.strip.length + looks.revise.length + looks.declined.length;
  if (total === 0) {
    return (
      <p class="text-sm text-muted text-center pt-8" id="plan-no-looks">
        {t('plans.looks.NONE')}
      </p>
    );
  }
  return (
    <>
      {looks.strip.length > 0 && (
        <section class="flex flex-col gap-3" aria-labelledby="plan-looks-title">
          <div class="flex flex-col gap-0.5">
            <h2 id="plan-looks-title" class="font-semibold">
              {t('plans.looks.PANEL_TITLE')}{' '}
              <span class="font-normal text-muted">· {looks.strip.length}</span>
            </h2>
            <p class="text-xs text-muted">{t('plans.looks.PLAN_HINT')}</p>
          </div>
          <LookGrid id="plan-looks" looks={looks.strip} eagerCount={2} />
        </section>
      )}
      <LooksFold
        id="plan-looks-revise"
        title={t('plans.looks.PANEL_WAITING')}
        hint={t('plans.REVISE_HINT')}
        looks={looks.revise}
      />
      <LooksFold
        id="plan-looks-declined"
        title={t('plans.looks.PANEL_TURNED_DOWN')}
        hint={t('plans.DECLINED_HINT')}
        looks={looks.declined}
      />
    </>
  );
}

// Pieces in one row of small tiles on a phone (a look is ~3.5 pieces, and
// eight looks of two big rows each are 4,000 px); the big two-column grid
// from `sm`. The viewer is the detail on a phone.
const PIECE_GRID = 'grid grid-cols-4 gap-1.5 sm:grid-cols-2 sm:gap-3';

function LookGrid(props: {
  id?: string;
  looks: PlanLookView[];
  eagerCount: number;
}) {
  return (
    <ul id={props.id} class={LOOK_GRID}>
      {props.looks.map((look, index) => (
        <LookCard look={look} eager={index < props.eagerCount} />
      ))}
    </ul>
  );
}

/** Looks apart by reaction, collapsed: nothing when there are none. */
function LooksFold(props: {
  id: string;
  title: string;
  hint: string;
  looks: PlanLookView[];
}) {
  if (props.looks.length === 0) return null;
  return (
    <details id={props.id} class="flex flex-col">
      <summary class="cursor-pointer font-semibold py-2">
        {props.title}{' '}
        <span class="font-normal text-muted">· {props.looks.length}</span>
      </summary>
      <div class="flex flex-col gap-3 pt-1">
        <p class="text-xs text-muted">{props.hint}</p>
        <LookGrid looks={props.looks} eagerCount={0} />
      </div>
    </details>
  );
}

function LookCard(props: { look: PlanLookView; eager: boolean }) {
  const { look } = props;
  return (
    <li
      id={`look-${look.id}`}
      data-look={String(look.id)}
      data-reaction={look.reaction}
      class="flex flex-col gap-4 rounded-box border border-base-300 bg-base-100 p-4"
    >
      <div class="flex flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <h3 class="font-medium leading-snug break-words min-w-0">
            {look.name}
          </h3>
          <span
            class={`badge badge-sm shrink-0 ${CHIPS[look.reaction]}`}
            data-reaction-chip=""
          >
            {t(`plans.looks.status.${look.reaction}`)}
          </span>
        </div>
        <p class="text-xs text-muted">{lookMeta(look)}</p>
        {look.note && (
          <p class="text-sm italic" data-look-note="">
            {look.note}
          </p>
        )}
        {look.ownerNote && (
          <p class="text-sm" data-owner-note="">
            {t('plans.YOUR_NOTE', { note: look.ownerNote })}
          </p>
        )}
      </div>
      <ul class={PIECE_GRID}>
        {look.slots.map((slot) => (
          <PieceTile slot={slot} eager={props.eager} />
        ))}
      </ul>
      <div class="mt-auto border-t border-base-300 pt-3">
        <LookMoves look={look} />
      </div>
    </li>
  );
}

/** One piece, big: its photo on the plinth colour, its name under it, To buy over its foot. */
function PieceTile(props: { slot: LookSlotView; eager: boolean }) {
  const { slot } = props;
  const name = slot.name ?? categoryLabel(slot.category);
  return (
    <li class="flex flex-col gap-1.5" data-piece-state={slot.state}>
      {slot.state === 'missing' ? (
        <div
          class="aspect-square rounded-box border border-dashed border-warning flex items-center justify-center p-1 sm:p-2"
          data-missing-piece=""
        >
          <span class="text-[0.625rem] sm:text-xs text-warning text-center">
            {t('plans.looks.MISSING')}
          </span>
        </div>
      ) : (
        <div class="relative aspect-square overflow-hidden rounded-box bg-base-200 flex items-center justify-center p-1 sm:p-2">
          {slot.photo ? (
            <img
              src={imageUrl(slot.photo, 'thumb')}
              alt={name}
              class="size-full object-contain"
              width="200"
              height="200"
              loading={props.eager ? 'eager' : 'lazy'}
              decoding="async"
            />
          ) : (
            <HangerIcon class="size-8 text-muted" strokeWidth="1.5" />
          )}
          {slot.state === 'to-buy' && (
            <span
              class="badge badge-accent badge-xs sm:badge-sm absolute bottom-0.5 sm:bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap"
              data-to-buy=""
            >
              {t('plans.looks.TO_BUY')}
            </span>
          )}
        </div>
      )}
      <p class="text-xs sm:text-sm leading-snug truncate sm:whitespace-normal sm:line-clamp-2 sm:break-words">
        {name}
      </p>
    </li>
  );
}

function MoveButton(props: {
  look: PlanLookView;
  move: string;
  class: string;
  children: Child;
}) {
  return (
    <PostForm
      action={lookUrl(props.look.planId, props.look.id, props.move)}
      needsNetwork
    >
      <button type="submit" class={`btn btn-sm ${props.class}`}>
        {props.children}
      </button>
    </PostForm>
  );
}

/**
 * A look's reactions (#291), each its own small native post: Love it while
 * it is to review or sent back ("Love it as it is"), Change this… (its own
 * form: the note is required) while to review or loved, Not for me while
 * not turned down already, and Reconsider once it is. The machine
 * (look-reaction.ts) has the same edges. Save as outfit (or the link to the
 * outfit it became) leads, #292.
 */
function LookMoves({ look }: { look: PlanLookView }) {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <LookSaveAction
        look={look}
        plain
        buttonClass={`btn btn-sm ${look.reaction === 'loved' ? 'btn-primary' : 'btn-outline'}`}
      />
      {look.reaction === 'declined' ? (
        <MoveButton look={look} move="/reconsider" class="btn-outline">
          {t('plans.RECONSIDER')}
        </MoveButton>
      ) : (
        <>
          {(look.reaction === 'proposed' || look.reaction === 'revise') && (
            <MoveButton look={look} move="/love" class="btn-primary">
              {t(
                look.reaction === 'revise'
                  ? 'plans.looks.LOVE_AS_IS'
                  : 'plans.looks.LOVE',
              )}
            </MoveButton>
          )}
          <MoveButton look={look} move="/decline" class="btn-ghost">
            {t('plans.looks.DECLINE')}
          </MoveButton>
          {look.reaction !== 'revise' && (
            <a
              href={lookUrl(look.planId, look.id, '/change')}
              class="link link-hover text-sm"
            >
              {t('plans.looks.CHANGE')}
            </a>
          )}
        </>
      )}
    </div>
  );
}
