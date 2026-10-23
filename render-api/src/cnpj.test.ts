import assert from "node:assert/strict";
import test from "node:test";
import { isValidCnpj, normalizeCnpj } from "./cnpj.js";

test("valida e normaliza CNPJ numérico tradicional", () => {
  assert.equal(normalizeCnpj("00.000.000/0001-91"), "00000000000191");
  assert.equal(isValidCnpj("00.000.000/0001-91"), true);
});

test("aceita CNPJ alfanumérico com dígitos verificadores válidos", () => {
  assert.equal(normalizeCnpj("12.ABC.345/01DE-35"), "12ABC34501DE35");
  assert.equal(isValidCnpj("12.ABC.345/01DE-35"), true);
});

test("rejeita estrutura inválida, caracteres fora do formato e dígito incorreto", () => {
  assert.equal(isValidCnpj("12.ABC.345/01DE-36"), false);
  assert.equal(isValidCnpj("12.ABC.345/01DE-AA"), false);
  assert.equal(isValidCnpj("11.111.111/1111-11"), false);
  assert.equal(isValidCnpj("12.ABC.345/01DE-3X"), false);
});
