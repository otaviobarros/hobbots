/** The phone menu: the Menu button opens the list of sections, and picking one closes it. */
export const initMenu = () => {
  const button = document.querySelector<HTMLButtonElement>("[data-menu]");
  const list = document.querySelector<HTMLElement>("[data-menu-list]");
  if (!button || !list) return;
  const show = (open: boolean) => {
    list.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", () => show(list.hidden === true));
  list.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) show(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || list.hidden) return;
    show(false);
    button.focus();
  });
};
