const CNPJ_PATTERN = /^[A-Z0-9]{12}[0-9]{2}$/;
const ALLOWED_INPUT_PATTERN = /^[A-Z0-9.\-/\s]+$/i;
const FIRST_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;
const SECOND_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export function normalizeCnpj(value: string): string {
  return value.trim().replace(/[.\-/\s]/g, "").toUpperCase();
}

function calculateDigit(base: string, weights: readonly number[]): number {
  const sum = Array.from(base).reduce(
    (total, character, index) =>
      total + (character.charCodeAt(0) - 48) * weights[index]!,
    0
  );
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCnpj(value: string): boolean {
  if (!ALLOWED_INPUT_PATTERN.test(value.trim())) return false;
  const cnpj = normalizeCnpj(value);
  if (!CNPJ_PATTERN.test(cnpj) || /^([A-Z0-9])\1{13}$/.test(cnpj)) return false;

  const firstDigit = calculateDigit(cnpj.slice(0, 12), FIRST_WEIGHTS);
  const secondDigit = calculateDigit(
    `${cnpj.slice(0, 12)}${firstDigit}`,
    SECOND_WEIGHTS
  );
  return cnpj.slice(-2) === `${firstDigit}${secondDigit}`;
}
