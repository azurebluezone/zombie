<?php

declare(strict_types=1);

/**
 * Server-side PHP client for the ZombieCoder Runtime — OPERATOR side.
 *
 * This class speaks with the ADMIN token. It creates applications, sets expiry,
 * and decides which tools and MCP endpoints each application may use. It is the
 * operator's control plane, not the shop's.
 *
 * SECURITY: the admin token must never reach a customer's Laravel application,
 * a browser, a log line, or a support ticket. A shop uses ZombieCoderClient with
 * its own application key and nothing else. If a shop needs something that
 * requires this class, the operator performs it.
 *
 * Every route below was probed against the running runtime (LIVE_PROBE_PASSED):
 *   POST   /v1/admin/applications                       -> {application, apiKey, warning}
 *   GET    /v1/admin/applications                       -> {applications}
 *   POST   /v1/admin/applications/{id}/rotate-key       -> {apiKey, warning}
 *   POST   /v1/admin/applications/{id}/extend           -> {application}
 *   POST   /v1/admin/applications/{id}/revoke           -> {application}
 *   GET    /v1/admin/applications/capabilities          -> {applicationId, tools}
 *   POST   /v1/admin/applications/capabilities/tools    -> {setting, decision}
 *   GET    /v1/admin/tools/permissions                  -> {permissions}
 *   POST   /v1/admin/tools/permissions                  -> {permission}
 *   DELETE /v1/admin/tools/permissions                  -> {revoked}
 *   GET    /v1/admin/mcp/permissions                    -> {permissions}
 *   POST   /v1/admin/mcp/permissions                    -> {permission}
 *   DELETE /v1/admin/mcp/permissions                    -> {revoked}
 *
 * NOT_TESTED: no `php` binary exists on the build host, so this file has never
 * been executed. Run `php -l` and a smoke call on a host that has PHP.
 */
final class ZombieCoderAdminClient
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $adminToken,
        private readonly int $timeoutSeconds = 30,
    ) {}

    /* ------------------------------------------------------------------ */
    /* Applications — the unit of a subscription                           */
    /* ------------------------------------------------------------------ */

    /** @return array<int,array<string,mixed>> */
    public function applications(): array
    {
        return $this->request('GET', '/admin/applications')['applications'] ?? [];
    }

    /**
     * Create one application = one client's shop.
     *
     * The returned `apiKey` is shown ONCE and never stored in plaintext by the
     * runtime (only its hash is kept). Hand it to the shop over a secure channel
     * and store it in the shop's own .env.
     *
     * @param string|null $expiresAt ISO-8601, e.g. '2026-11-17T00:00:00.000Z'.
     *                               null means "never expires".
     */
    public function createApplication(string $name, ?string $expiresAt = null): array
    {
        return $this->request('POST', '/admin/applications', [
            'name' => $name,
            'expiresAt' => $expiresAt,
        ], 201);
    }

    /** Give the subscription another period. */
    public function extendApplication(string $applicationId, string $expiresAt): array
    {
        return $this->request('POST', "/admin/applications/{$applicationId}/extend", [
            'expiresAt' => $expiresAt,
        ])['application'] ?? [];
    }

    /**
     * Stop the subscription now.
     *
     * A revoked application fails authentication immediately: every chat call
     * returns 401 `application_unauthorized_or_expired`. It is also what happens
     * automatically when `expiresAt` passes.
     */
    public function revokeApplication(string $applicationId): array
    {
        return $this->request('POST', "/admin/applications/{$applicationId}/revoke")['application'] ?? [];
    }

    /** Issue a fresh key for an application. The old key stops working at once. */
    public function rotateApplicationKey(string $applicationId): array
    {
        return $this->request('POST', "/admin/applications/{$applicationId}/rotate-key");
    }

    /* ------------------------------------------------------------------ */
    /* Feature entitlement — which of the 10 features a client bought      */
    /* ------------------------------------------------------------------ */

    /**
     * The effective on/off state of every tool for one application, with the
     * reason it is on or off (`database`, `environment`, `environment-list`).
     *
     * @return array<string,mixed>  ['<toolId>' => ['enabled'=>bool,'source'=>string,...]]
     */
    public function capabilities(string $applicationId): array
    {
        $query = http_build_query(['applicationId' => $applicationId]);
        return $this->request('GET', '/admin/applications/capabilities?' . $query)['tools'] ?? [];
    }

    /**
     * Turn one feature on or off for one application.
     *
     * This is the "Rahim bought 5 features for 700 BDT" switch. A stored value
     * here wins over the environment defaults, and it survives a runtime restart.
     */
    public function setTool(string $applicationId, string $toolId, bool $enabled): array
    {
        return $this->request('POST', '/admin/applications/capabilities/tools', [
            'applicationId' => $applicationId,
            'toolId' => $toolId,
            'enabled' => $enabled,
        ]);
    }

    /* ------------------------------------------------------------------ */
    /* Tool permissions                                                    */
    /* ------------------------------------------------------------------ */

    /** @return array<int,array<string,mixed>> */
    public function toolPermissions(): array
    {
        return $this->request('GET', '/admin/tools/permissions')['permissions'] ?? [];
    }

    public function grantTool(string $applicationId, string $toolId): array
    {
        return $this->request('POST', '/admin/tools/permissions', [
            'applicationId' => $applicationId,
            'toolId' => $toolId,
        ], 201)['permission'] ?? [];
    }

    public function revokeTool(string $applicationId, string $toolId): bool
    {
        return (bool) ($this->request('DELETE', '/admin/tools/permissions', [
            'applicationId' => $applicationId,
            'toolId' => $toolId,
        ])['revoked'] ?? false);
    }

    /* ------------------------------------------------------------------ */
    /* External MCP permissions — Facebook Ads, WhatsApp, TTS, OCR          */
    /* ------------------------------------------------------------------ */

    /** @return array<int,array<string,mixed>> */
    public function mcpPermissions(): array
    {
        return $this->request('GET', '/admin/mcp/permissions')['permissions'] ?? [];
    }

    /**
     * Allow one application to call one discovered external MCP tool.
     *
     * `$qualifiedName` is the name the runtime reports for a discovered tool
     * (for example `mcp_facebook-ads_create_campaign`). The MCP execution
     * adapter checks this per call, so an application can never reach an
     * endpoint it was not granted — even if the tool was discovered.
     */
    public function grantMcpTool(string $applicationId, string $qualifiedName): array
    {
        return $this->request('POST', '/admin/mcp/permissions', [
            'applicationId' => $applicationId,
            'qualifiedName' => $qualifiedName,
        ], 201)['permission'] ?? [];
    }

    public function revokeMcpTool(string $applicationId, string $qualifiedName): bool
    {
        return (bool) ($this->request('DELETE', '/admin/mcp/permissions', [
            'applicationId' => $applicationId,
            'qualifiedName' => $qualifiedName,
        ])['revoked'] ?? false);
    }

    /* ------------------------------------------------------------------ */
    /* Transport                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * @return array<string,mixed>  the decoded JSON body
     */
    private function request(string $method, string $path, ?array $payload = null, int $expectedStatus = 200): array
    {
        $url = rtrim($this->baseUrl, '/') . $path;
        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('zombiecoder_transport_init_failed');
        }

        $headers = [
            'Accept: application/json',
            'Authorization: Bearer ' . $this->adminToken,
            'X-Client-ID: php-operator-control-plane',
        ];

        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => min(10, $this->timeoutSeconds),
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
        ]);

        if ($payload !== null) {
            $headers[] = 'Content-Type: application/json';
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_THROW_ON_ERROR));
        }

        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

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

        if ($status === 401) {
            throw new RuntimeException('zombiecoder_admin_unauthorized');
        }
        if ($status !== $expectedStatus) {
            $error = is_array($data) ? ($data['error'] ?? 'request_failed') : 'request_failed';
            throw new RuntimeException(sprintf('zombiecoder_request_failed:%s:http_%d', (string) $error, $status));
        }

        return is_array($data) ? $data : [];
    }
}
