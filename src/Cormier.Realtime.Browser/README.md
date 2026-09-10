# Cormier.Realtime.Browser

This package exposes the generated Cormier.Realtime browser SDK as ASP.NET Core static web assets.

After adding the package to an ASP.NET Core application, use the readable or production artifact beneath `_content/Cormier.Realtime.Browser/`:

```html
<script src="/_content/Cormier.Realtime.Browser/cormier-realtime.iife.min.js"></script>
```

ES modules, IIFE bundles, declarations, source maps, and `version.json` are produced deterministically from `sdk/typescript`. The browser package version follows the same compatibility policy as `@cormier/realtime`; protocol compatibility is recorded in `version.json`.
