import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { Pool } from "pg";
import { createEvaluationsRouter } from "./evaluations.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "80kb" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  next();
});

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/platform/config.js", (_req, res, next) => {
  const siteRoot = path.resolve(process.cwd(), process.env.SITE_ROOT ?? "..");
  res.sendFile(path.join(siteRoot, "api", "platform", "config.js"), error => {
    if (error) next(error);
  });
});

app.use(
  "/api/evaluations.php",
  createEvaluationsRouter(pool, process.env.SYNC_API_TOKEN)
);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Rota da API não encontrada." });
});

const siteRoot = path.resolve(process.cwd(), process.env.SITE_ROOT ?? "..");
const indexPath = path.join(siteRoot, "index.html");
app.use(
  "/assets",
  express.static(path.join(siteRoot, "assets"), {
    fallthrough: false,
    dotfiles: "deny",
    index: false,
  })
);
app.get(["/", "/index.html"], (_req, res, next) => {
  res.sendFile(indexPath, error => {
    if (error) next(error);
  });
});
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Rota da API não encontrada." });
    return;
  }
  res.sendFile(indexPath, error => {
    if (error) next(error);
  });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : 500;
  if (status === 400) {
    res.status(400).json({ error: "Os dados enviados não são um JSON válido." });
    return;
  }
  if (status === 413) {
    res.status(413).json({ error: "O envio excede o limite permitido." });
    return;
  }
  if (status === 404) {
    res.status(404).json({ error: "Arquivo ou rota não encontrada." });
    return;
  }
  console.error("[server] Request failed:", error instanceof Error ? error.name : "unknown error");
  res.status(500).json({ error: "Não foi possível processar a solicitação." });
};
app.use(errorHandler);

const port = Number(process.env.PORT ?? 10_000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT deve ser um número válido entre 1 e 65535.");
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor da avaliação disponível na porta ${port}.`);
});
