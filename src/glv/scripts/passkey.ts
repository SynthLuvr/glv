import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { type } from "arktype";

const Action = type("'register' | 'login' | 'enroll'");

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

// Enrollment uses the same ceremony as registration (create a credential), but
// its options/verify calls are scoped to the enrollment token in the URL, so
// the server attaches the new passkey to the existing owner instead of a new
// one.
const runCeremony = async (
  action: "register" | "login" | "enroll",
): Promise<void> => {
  const button = document.getElementById("passkey-button");
  const token =
    button instanceof HTMLElement ? button.dataset.token : undefined;
  const base =
    action === "enroll" && token !== undefined
      ? `/auth/enroll/${token}`
      : `/auth/${action}`;
  const optionsRes = await fetch(`${base}/options`);
  if (!optionsRes.ok) {
    showError("Could not start the request. Please reload and try again.");
    return;
  }
  const optionsJSON = await optionsRes.json();
  const isRegistration = action === "register" || action === "enroll";
  const responseJSON = isRegistration
    ? await startRegistration({ optionsJSON })
    : await startAuthentication({ optionsJSON });

  const verifyRes = await fetch(`${base}/verify`, {
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
