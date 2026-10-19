// Read-only CDP diagnostic: evaluates one JSON expression in the Codex main
// page renderer and prints the result. Drives no UI.
const [, , wsUrl, expression] = process.argv;
if (!wsUrl || !expression)
  throw new Error("usage: node cdp-readonly-state.mjs <ws-url> <expr>");

const ws = new WebSocket(wsUrl);
const timeout = setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 10000);

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  );
});

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  clearTimeout(timeout);
  console.log(JSON.stringify(message.result ?? message, null, 2));
  ws.close();
  process.exit(message.error || message.result?.exceptionDetails ? 1 : 0);
});

ws.addEventListener("error", (error) => {
  clearTimeout(timeout);
  console.error(String(error));
  process.exit(1);
});