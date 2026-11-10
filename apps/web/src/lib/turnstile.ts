// Cloudflare Turnstile, loaded only when the gateway publishes a site key and a free session is requested.

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;
function load(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load.")));
    s.onerror = () => {
      loading = null;
      reject(new Error("The human check did not load. Disable blockers for this page and try again."));
    };
    document.head.append(s);
  });
  return loading;
}

/** Run one challenge inside `host` and resolve with its token. */
export async function turnstileToken(sitekey: string, host: HTMLElement): Promise<string> {
  const ts = await load();
  return new Promise<string>((resolve, reject) => {
    const id = ts.render(host, {
      sitekey,
      size: "flexible",
      theme: document.documentElement.getAttribute("data-theme") ?? "auto",
      callback: (token: string) => {
        resolve(token);
        setTimeout(() => ts.remove(id), 0);
      },
      "error-callback": () => reject(new Error("The human check failed. Try again.")),
    });
  });
}
