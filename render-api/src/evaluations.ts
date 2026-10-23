import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { isValidCnpj, normalizeCnpj } from "./cnpj.js";

const MAX_BIGINT = 9_223_372_036_854_775_807n;

export type EvaluationInput = {
  companyName: string;
  cnpj: string | null;
  trainingOnTime: "Sim" | "Não";
  systemUsage: "Sim" | "Parcialmente" | "Não";
  overallRating: "Excelente" | "Bom" | "Mediano" | "Ruim" | "Péssimo";
  recommendationScore: number;
  feedback: string | null;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textLength(value: string): number {
  return Array.from(value).length;
}

export function validateEvaluationPayload(payload: unknown): EvaluationInput {
  if (!isRecord(payload)) {
    throw new ApiError(400, "Os dados da avaliação estão inválidos. Confira os campos e tente novamente.");
  }

  const allowed = new Set([
    "companyName",
    "cnpj",
    "trainingOnTime",
    "systemUsage",
    "overallRating",
    "recommendationScore",
    "feedback",
  ]);
  if (Object.keys(payload).some(key => !allowed.has(key))) {
    throw new ApiError(400, "Os dados da avaliação estão inválidos. Confira os campos e tente novamente.");
  }

  const companyName = payload.companyName;
  const rawCnpj = payload.cnpj;
  const trainingOnTime = payload.trainingOnTime;
  const systemUsage = payload.systemUsage;
  const overallRating = payload.overallRating;
  const recommendationScore = payload.recommendationScore;
  const rawFeedback = payload.feedback;

  if (
    typeof companyName !== "string" ||
    companyName.trim().length === 0 ||
    textLength(companyName.trim()) > 500 ||
    (rawCnpj !== undefined && rawCnpj !== null && typeof rawCnpj !== "string") ||
    !["Sim", "Não"].includes(String(trainingOnTime)) ||
    !["Sim", "Parcialmente", "Não"].includes(String(systemUsage)) ||
    !["Excelente", "Bom", "Mediano", "Ruim", "Péssimo"].includes(String(overallRating)) ||
    typeof recommendationScore !== "number" ||
    !Number.isInteger(recommendationScore) ||
    recommendationScore < 1 ||
    recommendationScore > 5 ||
    (rawFeedback !== undefined && rawFeedback !== null && typeof rawFeedback !== "string")
  ) {
    throw new ApiError(400, "Os dados da avaliação estão inválidos. Confira os campos e tente novamente.");
  }

  let cnpj: string | null = null;
  if (typeof rawCnpj === "string" && rawCnpj.trim() !== "") {
    if (!isValidCnpj(rawCnpj)) {
      throw new ApiError(400, "Confira o CNPJ informado.");
    }
    cnpj = normalizeCnpj(rawCnpj);
  }

  const feedback = typeof rawFeedback === "string" ? rawFeedback.trim() : null;
  if (feedback !== null && textLength(feedback) > 10_000) {
    throw new ApiError(400, "O feedback deve ter até 10.000 caracteres.");
  }

  return {
    companyName: companyName.trim(),
    cnpj,
    trainingOnTime: trainingOnTime as EvaluationInput["trainingOnTime"],
    systemUsage: systemUsage as EvaluationInput["systemUsage"],
    overallRating: overallRating as EvaluationInput["overallRating"],
    recommendationScore,
    feedback: feedback || null,
  };
}

function getSingleQueryParam(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new ApiError(400, "Os parâmetros da consulta são inválidos.");
  }
  return value;
}

function authorizeSync(req: Request, res: Response, syncToken: string | undefined): boolean {
  if (!syncToken || syncToken.length < 32) {
    res.status(503).json({ error: "O serviço de sincronização está temporariamente indisponível." });
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization")?.trim() ?? "");
  const received = match?.[1]?.trim();
  if (!received) {
    res.status(401).json({ error: "Não autorizado." });
    return false;
  }

  const expectedBuffer = Buffer.from(syncToken, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    res.status(401).json({ error: "Não autorizado." });
    return false;
  }
  return true;
}

function requirePool(pool: Pool | null): Pool {
  if (!pool) {
    throw new ApiError(503, "O serviço de avaliações está temporariamente indisponível. Tente novamente mais tarde.");
  }
  return pool;
}

export function createEvaluationsRouter(
  pool: Pool | null,
  syncToken: string | undefined
): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    try {
      const evaluation = validateEvaluationPayload(req.body);
      const db = requirePool(pool);
      const result = await db.query<{ id: string; data_envio: Date }>(
        `INSERT INTO training_evaluations
          (nome_empresa, cnpj, treinamento_no_horario, uso_sistema, avaliacao_geral,
           nota_indicacao, feedback, data_envio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
         RETURNING id::text AS id, data_envio`,
        [
          evaluation.companyName,
          evaluation.cnpj,
          evaluation.trainingOnTime,
          evaluation.systemUsage,
          evaluation.overallRating,
          evaluation.recommendationScore,
          evaluation.feedback,
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Insert did not return an evaluation row");
      res.status(201).json({ id: row.id, submittedAt: row.data_envio.toISOString() });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[evaluations] PostgreSQL write failed:", error instanceof Error ? error.name : "unknown error");
      res.status(503).json({
        error: "O serviço de avaliações está temporariamente indisponível. Tente novamente mais tarde.",
      });
    }
  });

  router.get("/", async (req, res) => {
    if (!authorizeSync(req, res, syncToken)) return;

    try {
      const db = requirePool(pool);
      const afterRaw = getSingleQueryParam(req.query.after_id, "0");
      const limitRaw = getSingleQueryParam(req.query.limit, "100");
      if (!/^\d{1,19}$/.test(afterRaw)) {
        throw new ApiError(400, "O parâmetro after_id deve ser um inteiro não negativo.");
      }
      const afterId = BigInt(afterRaw);
      if (afterId > MAX_BIGINT) {
        throw new ApiError(400, "O parâmetro after_id deve ser um inteiro não negativo.");
      }
      if (!/^\d{1,3}$/.test(limitRaw)) {
        throw new ApiError(400, "O parâmetro limit deve estar entre 1 e 500.");
      }
      const limit = Number(limitRaw);
      if (limit < 1 || limit > 500) {
        throw new ApiError(400, "O parâmetro limit deve estar entre 1 e 500.");
      }

      const rawCnpj = req.query.cnpj;
      let cnpj: string | null = null;
      if (rawCnpj !== undefined) {
        if (typeof rawCnpj !== "string" || !isValidCnpj(rawCnpj)) {
          throw new ApiError(400, "O parâmetro cnpj deve conter um CNPJ válido.");
        }
        cnpj = normalizeCnpj(rawCnpj);
      }

      const values: Array<string | number> = [afterId.toString()];
      let query = `SELECT id::text AS id, nome_empresa, cnpj, treinamento_no_horario,
                          uso_sistema, avaliacao_geral, nota_indicacao, feedback, data_envio
                   FROM training_evaluations
                   WHERE id > $1::bigint`;
      if (cnpj !== null) {
        values.push(cnpj);
        query += ` AND cnpj = $${values.length}`;
      }
      values.push(limit);
      query += ` ORDER BY id ASC LIMIT $${values.length}`;

      const result = await db.query<{
        id: string;
        nome_empresa: string;
        cnpj: string | null;
        treinamento_no_horario: EvaluationInput["trainingOnTime"];
        uso_sistema: EvaluationInput["systemUsage"];
        avaliacao_geral: EvaluationInput["overallRating"];
        nota_indicacao: number;
        feedback: string | null;
        data_envio: Date;
      }>(query, values);

      const items = result.rows.map(row => ({
        id: row.id,
        companyName: row.nome_empresa,
        cnpj: row.cnpj,
        trainingOnTime: row.treinamento_no_horario,
        systemUsage: row.uso_sistema,
        overallRating: row.avaliacao_geral,
        recommendationScore: Number(row.nota_indicacao),
        feedback: row.feedback,
        submittedAt: row.data_envio.toISOString(),
      }));
      const nextAfterId = items.length ? items[items.length - 1]!.id : afterId.toString();
      res.status(200).json({ items, nextAfterId });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[evaluations] PostgreSQL read failed:", error instanceof Error ? error.name : "unknown error");
      res.status(503).json({
        error: "O serviço de avaliações está temporariamente indisponível. Tente novamente mais tarde.",
      });
    }
  });

  return router;
}
