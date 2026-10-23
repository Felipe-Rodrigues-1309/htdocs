import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import type { Pool } from "pg";
import { createEvaluationsRouter } from "./evaluations.js";

const token = "test-sync-token-with-at-least-32-characters";
const submittedAt = new Date("2026-10-23T12:00:00.000Z");

async function startTestServer(pool: Pool | null = null) {
  const app = express();
  app.use(express.json());
  app.use("/api/evaluations.php", createEvaluationsRouter(pool, token));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/api/evaluations.php`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

test("POST grava pelo adapter PostgreSQL e preserva a resposta 201", async t => {
  let statement = "";
  let values: unknown[] = [];
  const fakePool = {
    query: async (sql: string, params: unknown[]) => {
      statement = sql;
      values = params;
      return { rows: [{ id: "42", data_envio: submittedAt }] };
    },
  } as unknown as Pool;
  const server = await startTestServer(fakePool);
  t.after(server.close);

  const response = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyName: "Empresa teste",
      cnpj: "12.ABC.345/01DE-35",
      trainingOnTime: "Sim",
      systemUsage: "Parcialmente",
      overallRating: "Bom",
      recommendationScore: 4,
      feedback: "Atendimento claro",
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    id: "42",
    submittedAt: submittedAt.toISOString(),
  });
  assert.match(statement, /INSERT INTO training_evaluations/);
  assert.equal(values[0], "Empresa teste");
  assert.equal(values[1], "12ABC34501DE35");
});

test("GET exige Bearer e mantém contrato, paginação e filtro CNPJ", async t => {
  let statement = "";
  let values: unknown[] = [];
  const fakePool = {
    query: async (sql: string, params: unknown[]) => {
      statement = sql;
      values = params;
      return {
        rows: [{
          id: "7",
          nome_empresa: "Empresa teste",
          cnpj: "12ABC34501DE35",
          treinamento_no_horario: "Sim",
          uso_sistema: "Parcialmente",
          avaliacao_geral: "Bom",
          nota_indicacao: 4,
          feedback: null,
          data_envio: submittedAt,
        }],
      };
    },
  } as unknown as Pool;
  const server = await startTestServer(fakePool);
  t.after(server.close);

  const denied = await fetch(`${server.url}?after_id=0&limit=1`);
  assert.equal(denied.status, 401);

  const response = await fetch(
    `${server.url}?after_id=6&limit=1&cnpj=12.ABC.345%2F01DE-35`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [{
      id: "7",
      companyName: "Empresa teste",
      cnpj: "12ABC34501DE35",
      trainingOnTime: "Sim",
      systemUsage: "Parcialmente",
      overallRating: "Bom",
      recommendationScore: 4,
      feedback: null,
      submittedAt: submittedAt.toISOString(),
    }],
    nextAfterId: "7",
  });
  assert.match(statement, /cnpj = \$2/);
  assert.deepEqual(values, ["6", "12ABC34501DE35", 1]);
});
