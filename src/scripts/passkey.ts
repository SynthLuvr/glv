import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { type } from "arktype";

const Action = type("'register' | 'login'");

const VerifyResult = type({
  verified: "boolean",
  "error?": "string",
});

const showError = (msg: string): void => {
  const el = document.getElementById("auth-error");
  if (el instanceof HTMLElement) {
    el.textContent = msg;
    el.hidden = false;
  }
};

const setBusy = (busy: boolean): void => {
  const btn = document.getElementById("passkey-button");
  if (btn instanceof HTMLButtonElement) btn.disabled = busy;
};

const runCeremony = async (action: "register" | "login"): Promise<void> => {
  const optionsRes = await fetch(`/auth/${action}/options`);
  if (!optionsRes.ok) {
    showError("Could not start the request. Please reload and try again.");
    return;
  }
  const optionsJSON = await optionsRes.json();
  const responseJSON =
    action === "register"
      ? await startRegistration({ optionsJSON })
      : await startAuthentication({ optionsJSON });

  const verifyRes = await fetch(`/auth/${action}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(responseJSON),
  });
  // Validate the server's verify response instead of trusting its shape.
  const result = VerifyResult(await verifyRes.json());
  if (result instanceof type.errors) {
    showError("Could not verify authentication. Please try again.");
    return;
  }
  if (result.verified) {
    window.location.href = "/";
    return;
  }
  showError(result.error ?? "Authentication failed. Please try again.");
};

const init = (): void => {
  const button = document.getElementById("passkey-button");
  if (button === null) return;
  button.addEventListener("click", async () => {
    setBusy(true);
    try {
      const action = Action(button.dataset.action ?? "login");
      if (action instanceof type.errors) {
        showError("Unknown authentication action.");
        return;
      }
      await runCeremony(action);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      showError(detail);
    } finally {
      setBusy(false);
    }
  });
};

init();
