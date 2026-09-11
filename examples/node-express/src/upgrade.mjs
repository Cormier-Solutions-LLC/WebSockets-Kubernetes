export function createUpgradeHandler({ publicOrigin, gatewayUrl, proxy, upgradedSockets }) {
  return (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", publicOrigin).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== "/realtime/ws") {
      socket.destroy();
      return;
    }
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    proxy.ws(request, socket, head, { target: gatewayUrl, changeOrigin: false });
  };
}
