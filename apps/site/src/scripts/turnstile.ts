/** The part of Cloudflare's Turnstile API the wait-list uses. */
interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  execute(widget: string): void;
  reset(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<Turnstile> | undefined;

const load = () => {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.addEventListener("load", () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start")),
    );
    script.addEventListener("error", () => {
      loading = undefined;
      script.remove();
      reject(new Error("Turnstile did not load"));
    });
    document.head.append(script);
  });
  return loading;
};

interface Widget {
  id: string;
  settle?: ((token: string | undefined) => void) | undefined;
}

const widgets = new Map<HTMLElement, Widget>();

/**
 * Runs the Turnstile check in a form's container and resolves with a single-use token. The check
 * stays invisible unless Cloudflare needs the visitor to click.
 */
export const humanToken = async (container: HTMLElement): Promise<string> => {
  const turnstile = await load();
  let widget = widgets.get(container);
  if (!widget) {
    const created: Widget = { id: "" };
    const finish = (token: string | undefined) => {
      created.settle?.(token);
      created.settle = undefined;
    };
    created.id = turnstile.render(container, {
      sitekey: container.dataset.sitekey,
      appearance: "interaction-only",
      execution: "execute",
      callback: (token: string) => finish(token),
      "error-callback": () => finish(undefined),
      "expired-callback": () => finish(undefined),
      "timeout-callback": () => finish(undefined),
      "unsupported-callback": () => finish(undefined),
    });
    widgets.set(container, created);
    widget = created;
  }
  const current = widget;
  const token = await new Promise<string | undefined>((resolve) => {
    current.settle = resolve;
    turnstile.execute(current.id);
  });
  // A token works once, so the next submit runs a fresh check.
  turnstile.reset(current.id);
  if (!token) throw new Error("Turnstile check failed");
  return token;
};
