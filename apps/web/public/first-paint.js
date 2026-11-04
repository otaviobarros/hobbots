// Runs before the page's first paint, ahead of the app's own code, so the window frame in
// index.html shows in this device's theme and with its sidebar width while the app loads. It reads
// what lib/theme.ts, the sidebar and the desktop preload keep, and changes nothing else. A plain
// script in public/, because the page's CSP allows no inline script.
((page, root) => {
  const themes = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"];
  const read = (key) => {
    try {
      const raw = page.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  };
  // The saved theme, or a look that follows the system's light or dark. With neither, first run's
  // theme from index.html stays.
  const choice = read("hobbots.theme");
  if (themes.includes(choice)) root.dataset.theme = choice;
  else if (choice === "lamplight-auto" || choice === "workshop-auto") {
    const mode = page.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const themeOf = { lamplight: { dark: "lamplight-dusk", light: "lamplight-paper" } };
    themeOf.workshop = { dark: "workshop-night", light: "workshop-daylight" };
    root.dataset.theme = themeOf[choice.slice(0, choice.indexOf("-"))][mode];
  }
  if (read("sidebar.open") === true) root.dataset.sidebar = "open";
  // The desktop app's preload has run by now; only its window draws the title strip.
  if (page.hobbots !== undefined) root.dataset.window = "desktop";
  // Setup, Welcome and pairing fill the window without the sidebar.
  if (/^#\/(welcome|setup|pair)(\/|\?|$)/.test(page.location.hash)) root.dataset.frame = "plain";
})(window, document.documentElement);
