<?php

declare(strict_types=1);

/**
 * Minimal server-side PHP client for ZombieCoder Runtime.
 *
 * No Composer package is required. Keep the API key server-side.
 */
final class ZombieCoderClient
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $apiKey,
        private readonly string $model,
        private readonly int $timeoutSeconds = 60,
    ) {}

    /**
     * Send a normal chat request and return the decoded runtime payload.
     * The caller receives the runtime's request/trace IDs for support/debugging.
     */
    public function chat(array $messages, array $options = []): array
    {
        $payload = array_merge([
            'model' => $this->model,
            'messages' => $messages,
            'stream' => false,
        ], $options);

        return $this->post('/chat/completions', $payload);
    }

    /**
     * Create a runtime session for this application.
     */
    public function createSession(?string $userId = null, array $metadata = []): array
    {
        $payload = ['metadata' => $metadata];
        if ($userId !== null && $userId !== '') {
            $payload['userId'] = $userId;
        }
        return $this->post('/sessions', $payload, 201);
    }

    private function post(string $path, array $payload, int $expectedStatus = 200): array
    {
        $url = rtrim($this->baseUrl, '/') . $path;
        $requestId = 'php_' . bin2hex(random_bytes(12));
        $traceId = 'php_trace_' . bin2hex(random_bytes(12));

        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('zombiecoder_transport_init_failed');
        }

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => min(10, $this->timeoutSeconds),
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'Content-Type: application/json',
                'Authorization: Bearer ' . $this->apiKey,
                'X-Request-ID: ' . $requestId,
                'X-Trace-ID: ' . $traceId,
                'X-Client-ID: php-server-integration',
            ],
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_THROW_ON_ERROR),
        ]);

        $raw = curl_exec($ch);
        $curlError = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($raw === false) {
            throw new RuntimeException('zombiecoder_transport_failed:' . ($curlError ?: 'unknown'));
        }

        try {
            $data = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new RuntimeException('zombiecoder_invalid_json_response');
        }

        if ($status !== $expectedStatus) {
            $error = is_array($data) ? ($data['error'] ?? 'request_failed') : 'request_failed';
            throw new RuntimeException(sprintf(
                'zombiecoder_request_failed:%s:http_%d:request_id=%s:trace_id=%s',
                (string) $error,
                $status,
                $requestId,
                $traceId,
            ));
        }

        return [
            'data' => $data,
            'request_id' => $requestId,
            'trace_id' => $traceId,
            'http_status' => $status,
        ];
    }
}
