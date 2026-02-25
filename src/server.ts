import http from "node:http";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

import type { SSRManifest } from "astro";
import { NodeApp, applyPolyfills } from "astro/app/node";

applyPolyfills();

// Load runtime environment variables from .env file deployed with the compute bundle.
// Amplify build-time env vars aren't available at Lambda runtime, so we write them
// to a .env file during build and load them here.
try {
  // Server code is bundled into chunks/ subdirectory, so go up to compute root
  const envPath = new URL("../.env", import.meta.url);
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env file may not exist in all environments
}

export function createExports(manifest: SSRManifest, options: Options) {
  const app = new NodeApp(manifest);
  return {
    options,
    startServer: () => startServer(app, options),
  };
}

export function start(manifest: SSRManifest, options: Options) {
  const app = new NodeApp(manifest);
  startServer(app, options);
}

interface Options {
  host: string | boolean;
  port: number;
  client: string;
  server: string;
  assets: string;
}

function startServer(app: NodeApp, options: Options) {
  const port = process.env.PORT ? Number(process.env.PORT) : options.port ?? 3000;
  const host =
    process.env.HOST ??
    (typeof options.host === "boolean"
      ? options.host
        ? "0.0.0.0"
        : "localhost"
      : options.host ?? "localhost");

  const handler = createHandler(app, port);
  const server = http.createServer(handler);
  server.listen(port, host);
  console.log(`Server listening on http://${host}:${port}`);
}

function createHandler(app: NodeApp, port: number) {
  const als = new AsyncLocalStorage<string>();
  const logger = app.getAdapterLogger();

  // Create a local fetch function for pre-rendered error pages.
  // Amplify terminates TLS and forwards X-Forwarded-Proto: https,
  // so Astro constructs URLs with https:// protocol. When it tries to
  // self-fetch the error page, it connects to localhost:443 which fails.
  // This function rewrites the URL to use the local HTTP server.
  const localFetch: typeof fetch = (input, init?) => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    try {
      const parsed = new URL(url);
      parsed.protocol = "http:";
      parsed.host = `localhost:${port}`;
      url = parsed.toString();
    } catch {
      // If URL parsing fails, pass through to global fetch
    }
    return fetch(url, init);
  };

  process.on("unhandledRejection", (reason) => {
    const requestUrl = als.getStore();
    logger.error(`Unhandled rejection while rendering ${requestUrl}`);
    console.error(reason);
  });

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let request: Request;
    try {
      request = NodeApp.createRequest(req);
    } catch (err) {
      logger.error(`Could not create request for ${req.url}`);
      console.error(err);
      res.statusCode = 500;
      res.end("Internal Server Error");
      return;
    }

    const routeData = app.match(request);

    // For GET requests without a route match, redirect clean URLs to trailing
    // slash so Amplify static hosting can resolve them to index.html
    // (e.g., /about -> /about/ -> about/index.html). Only GET — POST/PUT/etc.
    // should never be redirected as the body would be lost.
    if (!routeData && req.method === "GET") {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/") && !url.pathname.includes(".")) {
        url.pathname += "/";
        res.writeHead(301, { Location: url.pathname + url.search });
        res.end();
        return;
      }
    }
    if (routeData) {
      const response = await als.run(request.url, () =>
        app.render(request, {
          addCookieHeader: true,
          routeData,
          prerenderedErrorPageFetch: localFetch,
        }),
      );
      await NodeApp.writeResponse(response, res);
    } else {
      const response = await app.render(request, {
        prerenderedErrorPageFetch: localFetch,
      });
      await NodeApp.writeResponse(response, res);
    }
  };
}
