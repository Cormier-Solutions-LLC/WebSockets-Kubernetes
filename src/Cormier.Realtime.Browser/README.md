# Cormier.Realtime.Browser

This package exposes the generated Cormier.Realtime browser SDK as ASP.NET Core static web assets.

It targets `net10.0` and references the ASP.NET Core shared framework. Install it in a .NET 10 web host from your configured NuGet source:

```text
dotnet add package Cormier.Realtime.Browser --version 0.1.0
```

Enable static file serving in the consuming host, as in the repository's clean-consumer check:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.UseStaticFiles();
app.Run();
```

Publish the consuming application with its static web assets and verify the asset URL in the deployed environment. This package does not register gateway endpoints, authenticate users, or include the shared reference application's HTML/CSS; add hosting integration separately when required.

After adding the package to an ASP.NET Core application, use the readable or production artifact beneath `_content/Cormier.Realtime.Browser/`:

```html
<script src="/_content/Cormier.Realtime.Browser/cormier-realtime.iife.min.js"></script>
```

ES modules, IIFE bundles, declarations, source maps, and `version.json` are produced deterministically from `sdk/typescript`. The browser package version follows the same compatibility policy as `@cormier/realtime`; protocol compatibility is recorded in `version.json`.

The IIFE exposes `CormierRealtime.RealtimeClient` and `CormierRealtime.DiagnosticsClient`. ESM consumers can import named exports from `/_content/Cormier.Realtime.Browser/cormier-realtime.min.js`. Readable counterparts omit `.min`; declarations live under `types/`. Use a matching set of JavaScript, maps and metadata from one build. The SDK currently implements envelope version `1.0` and subprotocol `cormier.realtime.v1`; browser compatibility follows the locked Playwright matrix, with an ES2022 output target.

For repository builds, run `npm --prefix sdk/typescript ci` and `npm --prefix sdk/typescript run build` with Node.js 22+ before packing this project. The Razor project copies existing `sdk/typescript/dist` files; it does not run npm or regenerate them. Generated `wwwroot` content is not an independent source to edit. `scripts/Test-BrowserPackage.ps1` inspects package entries and builds an isolated .NET 10 consumer/static-asset manifest; SDK browser tests verify runtime behavior separately.

Serve over HTTPS outside loopback development. Allow the external script/module and configured connection origin in CSP; no `unsafe-eval` is required. Choose deliberately whether to publish source maps, never put operator tokens in public assets/storage, and redact ticket-bearing handshake URLs at the edge. See the [SDK guide](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/sdk/typescript/README.md) and [package release policy](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/package-release.md).
