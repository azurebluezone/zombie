<?php

declare(strict_types=1);

/**
 * Server-side PHP client for the ZombieCoder Runtime — CLIENT side.
 *
 * This class speaks for ONE ecommerce application, using that application's own
 * key. It can chat, stream, and manage its own sessions. It can NOT create
 * applications, change expiry, or grant tools: those belong to the operator and
 * live in ZombieCoderAdminClient (which needs the admin token).
 *
 * Keep the application key on the server. The browser must never receive it.
 *
 * Verified against the running runtime (LIVE_PROBE_PASSED):
 *   POST /v1/chat/completions   (stream:false and stream:true)
 *   POST /v1/sessions           -> {session:{id,applicationId,userId,status,...}}
 *
 * NOT_TESTED: no `php` binary exists on the build host, so this file has never
 * been executed. The HTTP contract it targets was probed live; the PHP code was
 * not. Run `php -l` and a smoke call on a host that has PHP before trusting it.
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
     *
     * @param array<int,array{role:string,content:string}> $messages
     * @param array<string,mixed> $options  e.g. agent, autoToolLoop, consent,
     *                                      toolIds, provider, sessionId, userId
     * @return array{data:array<string,mixed>,request_id:string,trace_id:string,http_status:int}
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
     * Stream a chat answer over SSE, invoking $onDelta for every token.
     *
     * A token travels on the `data:` channel ONLY. `event: runtime` frames are
     * lifecycle metadata (`assistant`, `tool_result`, `tool_error`,
     * `stream_chunk`, `complete`) and carry no token text. Do not concatenate
     * both channels — that doubled every answer before runtime phase 72.
     *
     * This is the method a Laravel controller uses when it wants to push tokens
     * to the browser through Pusher instead of buffering the whole answer.
     *
     * @param callable(string,array<string,mixed>):void $onDelta  ($text, $frame)
     * @param callable(array<string,mixed>):void|null   $onEvent  runtime events
     * @return array{text:string,request_id:string,trace_id:string,http_status:int}
     */
    public function chatStream(array $messages, callable $onDelta, array $options = [], ?callable $onEvent = null): array
    {
        $payload = array_merge([
            'model' => $this->model,
            'messages' => $messages,
            'stream' => true,
        ], $options);

        $url = rtrim($this->baseUrl, '/') . '/chat/completions';
        $requestId = 'php_' . bin2hex(random_bytes(12));
        $traceId = 'php_trace_' . bin2hex(random_bytes(12));

        $text = '';
        $buffer = '';

        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('zombiecoder_transport_init_failed');
        }

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_CONNECTTIMEOUT => min(10, $this->timeoutSeconds),
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_HTTPHEADER => [
                'Accept: text/event-stream',
                'Content-Type: application/json',
                'Authorization: Bearer ' . $this->apiKey,
                'X-Request-ID: ' . $requestId,
                'X-Trace-ID: ' . $traceId,
                'X-Client-ID: php-server-integration',
            ],
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_THROW_ON_ERROR),
            CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$buffer, &$text, $onDelta, $onEvent): int {
                $buffer .= $chunk;

                while (($cut = strpos($buffer, "\n\n")) !== false) {
                    $frame = substr($buffer, 0, $cut);
                    $buffer = substr($buffer, $cut + 2);
                    if (trim($frame) === '') {
                        continue;
                    }

                    $event = null;
                    $data = null;
                    foreach (explode("\n", $frame) as $line) {
                        if (str_starts_with($line, 'event:')) {
                            $event = trim(substr($line, 6));
                        } elseif (str_starts_with($line, 'data:')) {
                            $data = ltrim(substr($line, 5));
                        }
                    }
                    if ($data === null || $data === '[DONE]') {
                        continue;
                    }

                    $decoded = json_decode($data, true);
                    if (!is_array($decoded)) {
                        continue;
                    }

                    if ($event === 'runtime') {
                        if ($onEvent !== null) {
                            $onEvent($decoded);
                        }
                        continue;
                    }

                    $delta = $decoded['choices'][0]['delta']['content'] ?? null;
                    if (is_string($delta) && $delta !== '') {
                        $text .= $delta;
                        $onDelta($delta, $decoded);
                    }
                }

                return strlen($chunk);
            },
        ]);

        $ok = curl_exec($ch);
        $curlError = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($ok === false) {
            throw new RuntimeException('zombiecoder_transport_failed:' . ($curlError ?: 'unknown'));
        }
        if ($status !== 200) {
            throw new RuntimeException(sprintf(
                'zombiecoder_stream_failed:http_%d:request_id=%s:trace_id=%s',
                $status,
                $requestId,
                $traceId,
            ));
        }

        return [
            'text' => $text,
            'request_id' => $requestId,
            'trace_id' => $traceId,
            'http_status' => $status,
        ];
    }

    /**
     * Create a runtime session for this application.
     *
     * `$userId` is the ONLY customer identity the runtime ever stores. Pass an
     * opaque support PIN (e.g. "PIN-0005") and keep the mapping from PIN to the
     * real customer inside your own database. The model then never receives a
     * name, phone number or address — only the PIN.
     */
    public function createSession(?string $userId = null, array $metadata = []): array
    {
        $payload = [];
        if ($userId !== null && $userId !== '') {
            $payload['userId'] = $userId;
        }
        if ($metadata !== []) {
            $payload['metadata'] = $metadata;
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
            throw new RuntimeException(sprintf(
                'zombiecoder_request_failed:%s:http_%d:request_id=%s:trace_id=%s',
                self::errorCode($data),
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

    /**
     * The runtime answers with an OpenAI-shaped error body:
     *   {"error":{"message":"…","type":"…","param":null,"code":"…"}}
     * An older build answered {"error":"code"}. Both shapes are read, so a client
     * keeps working across the change, and the machine code is what lands in the
     * exception message.
     *
     * @param mixed $data
     */
    private static function errorCode($data): string
    {
        if (!is_array($data) || !array_key_exists('error', $data)) {
            return 'request_failed';
        }
        $error = $data['error'];
        if (is_string($error) && $error !== '') {
            return $error;
        }
        if (is_array($error)) {
            $code = $error['code'] ?? $error['message'] ?? null;
            if (is_string($code) && $code !== '') {
                return $code;
            }
        }
        return 'request_failed';
    }
}
