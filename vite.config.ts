import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const RALLY_PROXY_PATH = "/__rally_proxy";
const TEAMS_PROXY_PATH = "/__teams_proxy";

function rallyProxyPlugin(): Plugin {
  return {
    name: "rally-local-proxy",
    configureServer(server) {
      server.middlewares.use(RALLY_PROXY_PATH, async (req, res, next) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        try {
          const raw = await readBody(req);
          const payload = JSON.parse(raw || "{}") as {
            url?: string;
            method?: string;
            body?: string | null;
            apiKey?: string;
          };

          if (!payload.url || !payload.apiKey) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing url or apiKey" }));
            return;
          }

          const parsed = new URL(payload.url);
          if (parsed.protocol !== "https:") {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Only https URLs are allowed" }));
            return;
          }

          if (!parsed.hostname.endsWith("rallydev.com")) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Host not allowed" }));
            return;
          }

          const upstream = await fetch(payload.url, {
            method: payload.method ?? "GET",
            headers: {
              "Content-Type": "application/json",
              ZSESSIONID: payload.apiKey
            },
            body: typeof payload.body === "string" ? payload.body : undefined
          });

          const body = await upstream.text();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              status: upstream.status,
              body
            })
          );
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Proxy failed"
            })
          );
        }
      });

      server.middlewares.use(TEAMS_PROXY_PATH, async (req, res, next) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        try {
          const raw = await readBody(req);
          const payload = JSON.parse(raw || "{}") as {
            url?: string;
            body?: string | null;
          };

          if (!payload.url) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing url" }));
            return;
          }

          const parsed = new URL(payload.url);
          if (parsed.protocol !== "https:") {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Only https URLs are allowed" }));
            return;
          }

          if (!isAllowedTeamsHost(parsed.hostname)) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Host not allowed" }));
            return;
          }

          const upstream = await fetch(payload.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: typeof payload.body === "string" ? payload.body : "{}"
          });

          const body = await upstream.text();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              status: upstream.status,
              body
            })
          );
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Proxy failed"
            })
          );
        }
      });
    }
  };
}

function isAllowedTeamsHost(hostname: string): boolean {
  const allowed = [
    "webhook.office.com",
    "outlook.office.com",
    "logic.azure.com"
  ];
  return allowed.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default defineConfig({
  clearScreen: false,
  plugins: [rallyProxyPlugin()],
  server: {
    port: 5173,
    strictPort: true
  }
});
