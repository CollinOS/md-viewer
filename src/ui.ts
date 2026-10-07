// Small UI helpers: toasts and a promise-based confirm dialog.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const toastHost = document.querySelector<HTMLElement>(".toasts")!;

export function toast(message: string, kind: "info" | "error" = "info", ms = 4000) {
  const t = el("div", { className: `toast ${kind}`, textContent: message });
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

export interface Choice<T> {
  label: string;
  value: T;
  primary?: boolean;
}

/** Shows a modal with a title, message and buttons. Escape resolves to `cancel`. */
export function ask<T>(title: string, message: string, choices: Choice<T>[], cancel: T): Promise<T> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { className: "confirm" });
    const actions = el("div", { className: "actions" });
    let result = cancel;
    for (const c of choices) {
      const b = el("button", { className: c.primary ? "primary-btn" : "secondary-btn", textContent: c.label });
      b.addEventListener("click", () => {
        result = c.value;
        dialog.close();
      });
      actions.append(b);
    }
    dialog.append(el("div", { className: "body" }, el("h2", { textContent: title }), el("p", { textContent: message })), actions);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    (actions.querySelector(".primary-btn") as HTMLElement | null)?.focus();
  });
}

export const icons = {
  close:
    '<svg class="x" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
};
