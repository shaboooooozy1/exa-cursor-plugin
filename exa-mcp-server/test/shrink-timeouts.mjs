// Preloaded into the server process (NODE_OPTIONS=--import ...) ONLY for the timeout cases.
// Scales AbortSignal.timeout(ms) down by E2E_TIMEOUT_SCALE so the server's 60s / 120s request
// timeouts fire in a few hundred milliseconds. The server code itself is untouched; its error
// messages still report the nominal timeout it asked for.
const scale = Number(process.env.E2E_TIMEOUT_SCALE || "1");
if (scale > 1) {
  const original = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (ms) => original(Math.max(1, Math.round(ms / scale)));
}
