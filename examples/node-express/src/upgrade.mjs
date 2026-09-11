export function createUpgradeHandler({
  publicOrigin,
  publicScheme,
  gatewayUrl,
  proxy,
  upgradedSockets,
  handshakeTimeoutMs = 10_000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
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
    const connection = { browser: socket, gateway: undefined, browserClosed: false, gatewayClosed: true };
    upgradedSockets.add(connection);
    const forgetIfClosed = () => {
      if (connection.browserClosed && connection.gatewayClosed) upgradedSockets.delete(connection);
    };
    socket.once("close", () => {
      connection.browserClosed = true;
      forgetIfClosed();
    });

    const onProxyRequest = (proxyRequest, candidateRequest, candidateSocket) => {
      if (candidateRequest !== request || candidateSocket !== socket) return;
      proxy.off("proxyReqWs", onProxyRequest);
      const deadline = schedule(() => {
        proxyRequest.destroy(new Error("Gateway WebSocket handshake timed out."));
        socket.destroy();
      }, handshakeTimeoutMs);
      const closeUpstream = () => {
        cancel(deadline);
        proxyRequest.destroy();
      };
      const finishHandshake = (_response, gatewaySocket) => {
        cancel(deadline);
        socket.off("close", closeUpstream);
        if (gatewaySocket) {
          connection.gateway = gatewaySocket;
          connection.gatewayClosed = false;
          gatewaySocket.once("close", () => {
            connection.gatewayClosed = true;
            forgetIfClosed();
          });
        }
      };
      proxyRequest.once("upgrade", finishHandshake);
      proxyRequest.once("response", finishHandshake);
      proxyRequest.once("error", finishHandshake);
      socket.once("close", closeUpstream);
    };
    proxy.on("proxyReqWs", onProxyRequest);
    try {
      proxy.ws(request, socket, head, {
        target: gatewayUrl,
        changeOrigin: false,
        xfwd: false,
        headers: { "x-forwarded-proto": publicScheme },
      });
    } catch (error) {
      proxy.off("proxyReqWs", onProxyRequest);
      socket.destroy(error);
    }
  };
}
