import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { ChiefMark } from "./chief-mark.tsx";
import { Stars } from "./scene.tsx";

const HOUSE = [
  "....##....",
  "...####...",
  "..######..",
  ".########.",
  "##########",
  ".#oo##oo#.",
  ".#oo##oo#.",
  ".########.",
  ".###..###.",
  ".###..###.",
];
const HOUSE_PALETTE = { "#": "#f3e9b5", o: "#f2a541" };

const LINK = [
  "..........",
  ".####.....",
  ".#..#.....",
  ".#..####..",
  ".####..#..",
  "....#..#..",
  "..####.#..",
  "..#..####.",
  "..#..#....",
  "..####....",
];
const LINK_PALETTE = { "#": "#a9a2e0" };

const choiceClass = "cut flex flex-col gap-3 border-2 bg-card p-[22px] text-left text-text no-underline";

function ChoiceIcon({ rows, palette }: { rows: ReadonlyArray<string>; palette: Record<string, string> }) {
  return (
    <span className="cut flex size-14 items-center justify-center bg-line">
      <PixelArt rows={rows} palette={palette} size={40} />
    </span>
  );
}

/**
 * Where Hobbots runs, the first step of setup. Only running on this computer is live: connecting to
 * a hub on another computer and the optional remote access question arrive in later slices.
 */
export function WhereHobbotsRuns() {
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="relative w-[420px] flex-none overflow-hidden border-line border-r-4 bg-panel max-md:hidden">
        <Stars count={22} height={260} />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[150px] bg-[#221d44]" />
        <div aria-hidden className="absolute inset-x-0 bottom-[150px] h-2 bg-line" />
        <div className="absolute top-7 left-7 flex items-center gap-2.5">
          <span className="font-pixel text-[22px] font-bold text-moonlight">Hobbots</span>
          <span className="text-[13px] text-label">Getting started</span>
        </div>
        <div className="cut absolute inset-x-7 top-[84px] min-h-[150px] bg-text px-5 py-[18px] text-[17px] text-ground leading-normal">
          <span className="lbl mb-1.5 block text-[#5b4f9a] text-[13px]">Elder Hob</span>
          <span>
            Hello again! First, where should your hobs live? They need one home computer. Your other devices can visit
            it.
          </span>
        </div>
        <div
          aria-hidden
          className="absolute top-[232px] left-[150px] border-x-[14px] border-x-transparent border-t-[16px] border-t-text"
        />
        <div aria-hidden className="absolute bottom-[150px] left-[100px] animate-hb-bob">
          <ChiefMark size={140} />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-12 pt-10 pb-6">
        <div className="flex animate-hb-in flex-col gap-2">
          <h1 className="m-0 font-pixel text-[32px] font-bold text-moonlight">Where should Hobbots run?</h1>
          <p className="m-0 mb-[22px] max-w-[640px] text-secondary-text">
            Your hobs live on one computer, the hub. It keeps working in the background, even with the window closed.
            Hobs always work on the hub, with its folders and apps.
          </p>
          <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">
            {/* Hash history: the link works under Electron's file:// as well as in the browser. */}
            <a
              href="#/setup/providers"
              className={`${choiceClass} border-line-2 transition-transform duration-100 ease-[steps(2)] hover:-translate-y-[3px] hover:border-moonlight focus-visible:outline-3 focus-visible:outline-moonlight focus-visible:outline-offset-2`}
            >
              <ChoiceIcon rows={HOUSE} palette={HOUSE_PALETTE} />
              <span className="font-pixel text-2xl font-bold text-moonlight">Run Hobbots on this computer</span>
              <span className="text-secondary-text leading-normal">
                This computer becomes the hub. Hobs, chats and files live here, and hobs work with this computer's
                folders and apps.
              </span>
              <span className="self-start bg-moonlight px-2 py-0.5 text-[13px] font-bold text-ground">
                Most people start here
              </span>
            </a>
            <button
              type="button"
              disabled
              aria-describedby="connect-coming-soon"
              className={`${choiceClass} cursor-not-allowed border-line opacity-70`}
            >
              <ChoiceIcon rows={LINK} palette={LINK_PALETTE} />
              <span className="font-pixel text-2xl font-bold text-label">Connect to Hobbots on another computer</span>
              <span className="text-secondary-text leading-normal">
                Already have a hub? Use it from here with chat, Quests, approvals and the Workbench.
              </span>
              <span id="connect-coming-soon" className="self-start border-2 border-control px-2 py-0.5 text-[13px]">
                Coming soon: Hobbots can't join another computer's hub yet.
              </span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
