type Os = "mac" | "linux";

/** The Download section's Mac and Linux tabs. The hero's Linux button opens the Linux tab. */
export const initDownload = () => {
  const section = document.querySelector<HTMLElement>("[data-download]");
  if (!section) return;
  const tabs = [...section.querySelectorAll<HTMLButtonElement>("[data-os]")];
  const panels = [...section.querySelectorAll<HTMLElement>("[data-os-panel]")];

  const show = (os: Os) => {
    for (const tab of tabs) tab.setAttribute("aria-pressed", String(tab.dataset.os === os));
    for (const panel of panels) panel.hidden = panel.dataset.osPanel !== os;
  };

  for (const tab of tabs) tab.addEventListener("click", () => show(tab.dataset.os === "linux" ? "linux" : "mac"));
  for (const link of document.querySelectorAll<HTMLElement>("[data-pick-os]"))
    link.addEventListener("click", () => show(link.dataset.pickOs === "linux" ? "linux" : "mac"));
};
