import { type RoleId, starterRole } from "@hobbots/domain";
import { Sigil } from "@hobbots/ui/components/sigil";

interface BadgeSize {
  /** The smallest avatar this size is for. */
  readonly from: number;
  /** The dark plate's side. */
  readonly plate: number;
  /** The sigil's side, drawn centered on the plate. */
  readonly art: number;
  /** How far the plate hangs past the avatar's bottom-left corner. */
  readonly hang: number;
}

// From the Roles design: a 30 px list avatar takes a 14 px plate, a 72 px profile avatar a 26 px one.
const BADGE_SIZES: ReadonlyArray<BadgeSize> = [
  { from: 64, plate: 26, art: 20, hang: 7 },
  { from: 48, plate: 20, art: 14, hang: 5 },
  { from: 34, plate: 16, art: 12, hang: 4 },
  { from: 0, plate: 14, art: 10, hang: 4 },
];

/** The sigil badge's size for an avatar this many pixels wide. */
export const badgeSize = (avatar: number): BadgeSize =>
  BADGE_SIZES.find((size) => avatar >= size.from) ?? (BADGE_SIZES.at(-1) as BadgeSize);

/**
 * A role's sigil, drawn on its own dark plate. Decorative: the role's title is always in words
 * beside it, so screen readers read the title once.
 */
export function RoleSigil({ sigil, size, className }: { sigil: RoleId; size: number; className?: string }) {
  return <Sigil rows={starterRole(sigil).sigil} size={size} className={className} />;
}

/** A role's sigil on the bottom-left corner of an avatar, sized to the avatar. */
export function SigilBadge({ sigil, avatar }: { sigil: RoleId; avatar: number }) {
  const { plate, art, hang } = badgeSize(avatar);
  return (
    <span
      data-slot="sigil-badge"
      aria-hidden
      className="absolute grid place-items-center bg-deep"
      style={{ width: plate, height: plate, left: -hang, bottom: -hang }}
    >
      <RoleSigil sigil={sigil} size={art} />
    </span>
  );
}
