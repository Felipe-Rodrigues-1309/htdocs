<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

function jsonResponse(int $status, array $payload): never
{
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function serviceUnavailable(): never
{
    jsonResponse(503, [
        'error' => 'O serviço de avaliações está temporariamente indisponível. Tente novamente mais tarde.',
    ]);
}

function unicodeLength(string $value): int
{
    if (function_exists('mb_strlen')) {
        return mb_strlen($value, 'UTF-8');
    }

    $length = preg_match_all('/./us', $value);
    return $length === false ? PHP_INT_MAX : $length;
}

function normalizeCnpj(string $value): string
{
    return strtoupper((string) preg_replace('/[.\-\/\s]/', '', trim($value)));
}

function calculateCnpjDigit(string $base, array $weights): int
{
    $sum = 0;
    foreach (str_split($base) as $index => $character) {
        $sum += (ord($character) - 48) * $weights[$index];
    }

    $remainder = $sum % 11;
    return $remainder < 2 ? 0 : 11 - $remainder;
}

function isValidCnpj(string $value): bool
{
    $cnpj = normalizeCnpj($value);
    if (
        !preg_match('/^[A-Z0-9]{12}[0-9]{2}$/D', $cnpj) ||
        preg_match('/^([A-Z0-9])\1{13}$/D', $cnpj)
    ) {
        return false;
    }

    $firstDigit = calculateCnpjDigit(
        substr($cnpj, 0, 12),
        [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    );
    $secondDigit = calculateCnpjDigit(
        substr($cnpj, 0, 12) . $firstDigit,
        [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    );

    return substr($cnpj, -2) === ((string) $firstDigit . (string) $secondDigit);
}

function loadConfig(): array
{
    $configPath = __DIR__ . '/config.local.php';
    if (!is_file($configPath) || !is_readable($configPath)) {
        serviceUnavailable();
    }

    try {
        $config = require $configPath;
    } catch (Throwable $error) {
        error_log('[evaluations.php] Configuration load failed: ' . get_class($error));
        serviceUnavailable();
    }

    if (!is_array($config)) {
        serviceUnavailable();
    }

    return $config;
}

function getDatabaseConnection(array $config): PDO
{
    $host = $config['db_host'] ?? null;
    $database = $config['db_name'] ?? null;
    $username = $config['db_user'] ?? null;
    $password = $config['db_password'] ?? null;
    $port = $config['db_port'] ?? 3306;

    if (
        !is_string($host) || trim($host) === '' ||
        !is_string($database) || trim($database) === '' ||
        !is_string($username) || trim($username) === '' ||
        !is_string($password) ||
        !is_int($port) || $port < 1 || $port > 65535
    ) {
        serviceUnavailable();
    }

    try {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            trim($host),
            $port,
            trim($database)
        );
        $pdo = new PDO($dsn, $username, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_TIMEOUT => 5,
        ]);
        $pdo->exec("SET time_zone = '+00:00'");
        return $pdo;
    } catch (Throwable $error) {
        error_log('[evaluations.php] MySQL connection failed: ' . get_class($error));
        serviceUnavailable();
    }
}

function syncAuthorized(array $config): bool
{
    $expectedToken = $config['sync_api_token'] ?? null;
    if (!is_string($expectedToken) || strlen($expectedToken) < 32) {
        serviceUnavailable();
    }

    $authorization = $_SERVER['HTTP_AUTHORIZATION']
        ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
        ?? '';
    if ($authorization === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp((string) $name, 'Authorization') === 0) {
                $authorization = $value;
                break;
            }
        }
    }

    if (
        !is_string($authorization) ||
        !preg_match('/^Bearer\s+(.+)$/i', trim($authorization), $matches) ||
        !hash_equals($expectedToken, trim($matches[1]))
    ) {
        jsonResponse(401, ['error' => 'Não autorizado.']);
    }

    return true;
}

function parseEvaluationPayload(): array
{
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (!is_string($contentType) || stripos($contentType, 'application/json') !== 0) {
        jsonResponse(400, ['error' => 'Envie os dados da avaliação em JSON.']);
    }

    $rawBody = file_get_contents('php://input');
    if (!is_string($rawBody) || $rawBody === '' || strlen($rawBody) > 80000) {
        jsonResponse(400, ['error' => 'Os dados da avaliação estão inválidos. Confira os campos e tente novamente.']);
    }

    try {
        $payload = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        jsonResponse(400, ['error' => 'Os dados da avaliação estão inválidos. Confira os campos e tente novamente.']);
    }

    if (!is_array($payload) || array_is_list($payload)) {
        jsonResponse(400, ['error' => 'Os dados da avaliação estão inválidos. Confira os campos e tente novamente.']);
    }

    $allowedFields = [
        'companyName',
        'cnpj',
        'trainingOnTime',
        'systemUsage',
        'overallRating',
        'recommendationScore',
        'feedback',
    ];
    if (array_diff(array_keys($payload), $allowedFields) !== []) {
        jsonResponse(400, ['error' => 'Os dados da avaliação estão inválidos. Confira os campos e tente novamente.']);
    }

    $companyName = $payload['companyName'] ?? null;
    $cnpj = $payload['cnpj'] ?? null;
    $trainingOnTime = $payload['trainingOnTime'] ?? null;
    $systemUsage = $payload['systemUsage'] ?? null;
    $overallRating = $payload['overallRating'] ?? null;
    $recommendationScore = $payload['recommendationScore'] ?? null;
    $feedback = $payload['feedback'] ?? null;

    if (
        !is_string($companyName) || trim($companyName) === '' || unicodeLength(trim($companyName)) > 500 ||
        ($cnpj !== null && !is_string($cnpj)) ||
        !in_array($trainingOnTime, ['Sim', 'Não'], true) ||
        !in_array($systemUsage, ['Sim', 'Parcialmente', 'Não'], true) ||
        !in_array($overallRating, ['Excelente', 'Bom', 'Mediano', 'Ruim', 'Péssimo'], true) ||
        !is_int($recommendationScore) || $recommendationScore < 1 || $recommendationScore > 5 ||
        ($feedback !== null && !is_string($feedback))
    ) {
        jsonResponse(400, ['error' => 'Os dados da avaliação estão inválidos. Confira os campos e tente novamente.']);
    }

    $cleanCnpj = null;
    if ($cnpj !== null && trim($cnpj) !== '') {
        if (!preg_match('/^[A-Z0-9.\/\s-]+$/iD', trim($cnpj)) || !isValidCnpj($cnpj)) {
            jsonResponse(400, ['error' => 'Confira o CNPJ informado.']);
        }
        $cleanCnpj = normalizeCnpj($cnpj);
    }

    $cleanFeedback = $feedback === null ? null : trim($feedback);
    if ($cleanFeedback !== null && unicodeLength($cleanFeedback) > 10000) {
        jsonResponse(400, ['error' => 'O feedback deve ter até 10.000 caracteres.']);
    }
    if ($cleanFeedback === '') {
        $cleanFeedback = null;
    }

    return [
        'companyName' => trim($companyName),
        'cnpj' => $cleanCnpj,
        'trainingOnTime' => $trainingOnTime,
        'systemUsage' => $systemUsage,
        'overallRating' => $overallRating,
        'recommendationScore' => $recommendationScore,
        'feedback' => $cleanFeedback,
    ];
}

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if (!in_array($method, ['GET', 'POST'], true)) {
    header('Allow: GET, POST');
    jsonResponse(405, ['error' => 'Método não permitido.']);
}

if ($method === 'GET') {
    $config = loadConfig();
    syncAuthorized($config);

    $afterRaw = $_GET['after_id'] ?? '0';
    $limitRaw = $_GET['limit'] ?? '100';
    $cnpjRaw = $_GET['cnpj'] ?? null;
    if (!is_string($afterRaw) || !preg_match('/^\d{1,19}$/', $afterRaw)) {
        jsonResponse(400, ['error' => 'O parâmetro after_id deve ser um inteiro não negativo.']);
    }
    if (!is_string($limitRaw) || !preg_match('/^\d{1,3}$/', $limitRaw)) {
        jsonResponse(400, ['error' => 'O parâmetro limit deve estar entre 1 e 500.']);
    }

    $afterId = filter_var($afterRaw, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
    $limit = filter_var($limitRaw, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 500]]);
    if ($afterId === false || $limit === false) {
        jsonResponse(400, ['error' => 'Os parâmetros de paginação são inválidos.']);
    }

    $cnpjFilter = null;
    if ($cnpjRaw !== null) {
        if (
            !is_string($cnpjRaw) || trim($cnpjRaw) === '' ||
            !preg_match('/^[A-Z0-9.\/\s-]+$/iD', trim($cnpjRaw)) ||
            !isValidCnpj($cnpjRaw)
        ) {
            jsonResponse(400, ['error' => 'O parâmetro cnpj deve conter um CNPJ válido.']);
        }
        $cnpjFilter = normalizeCnpj($cnpjRaw);
    }

    $pdo = getDatabaseConnection($config);
    try {
        $query = 'SELECT id, nome_empresa, cnpj, treinamento_no_horario, uso_sistema, avaliacao_geral,
                         nota_indicacao, feedback, data_envio
                  FROM training_evaluations
                  WHERE id > :after_id';
        if ($cnpjFilter !== null) {
            $query .= ' AND cnpj = :cnpj';
        }
        $query .= ' ORDER BY id ASC LIMIT :limit';

        $statement = $pdo->prepare($query);
        $statement->bindValue(':after_id', $afterId, PDO::PARAM_INT);
        $statement->bindValue(':limit', $limit, PDO::PARAM_INT);
        if ($cnpjFilter !== null) {
            $statement->bindValue(':cnpj', $cnpjFilter, PDO::PARAM_STR);
        }
        $statement->execute();

        $items = [];
        while ($row = $statement->fetch()) {
            $submittedAt = new DateTimeImmutable((string) $row['data_envio'], new DateTimeZone('UTC'));
            $items[] = [
                'id' => (string) $row['id'],
                'companyName' => $row['nome_empresa'],
                'cnpj' => $row['cnpj'],
                'trainingOnTime' => $row['treinamento_no_horario'],
                'systemUsage' => $row['uso_sistema'],
                'overallRating' => $row['avaliacao_geral'],
                'recommendationScore' => (int) $row['nota_indicacao'],
                'feedback' => $row['feedback'],
                'submittedAt' => $submittedAt->format('Y-m-d\TH:i:s\Z'),
            ];
        }

        $nextAfterId = $items === [] ? (string) $afterId : $items[count($items) - 1]['id'];
        jsonResponse(200, ['items' => $items, 'nextAfterId' => $nextAfterId]);
    } catch (Throwable $error) {
        error_log('[evaluations.php] MySQL read failed: ' . get_class($error));
        serviceUnavailable();
    }
}

$evaluation = parseEvaluationPayload();
$config = loadConfig();
$pdo = getDatabaseConnection($config);

try {
    $submittedAt = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $sqlTimestamp = $submittedAt->format('Y-m-d H:i:s');
    $statement = $pdo->prepare(
        'INSERT INTO training_evaluations
                    (nome_empresa, cnpj, treinamento_no_horario, uso_sistema, avaliacao_geral,
             nota_indicacao, feedback, data_envio)
         VALUES
            (:nome_empresa, :cnpj, :treinamento_no_horario, :uso_sistema, :avaliacao_geral,
             :nota_indicacao, :feedback, :data_envio)'
    );
    $statement->execute([
        ':nome_empresa' => $evaluation['companyName'],
        ':cnpj' => $evaluation['cnpj'],
        ':treinamento_no_horario' => $evaluation['trainingOnTime'],
        ':uso_sistema' => $evaluation['systemUsage'],
        ':avaliacao_geral' => $evaluation['overallRating'],
        ':nota_indicacao' => $evaluation['recommendationScore'],
        ':feedback' => $evaluation['feedback'],
        ':data_envio' => $sqlTimestamp,
    ]);

    $id = $pdo->lastInsertId();
    if ($id === '0' || $id === '') {
        serviceUnavailable();
    }

    jsonResponse(201, [
        'id' => $id,
        'submittedAt' => $submittedAt->format('Y-m-d\TH:i:s\Z'),
    ]);
} catch (Throwable $error) {
    error_log('[evaluations.php] MySQL write failed: ' . get_class($error));
    serviceUnavailable();
}
