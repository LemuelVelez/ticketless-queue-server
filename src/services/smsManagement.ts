/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from "mongoose"

import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel } from "../models/Department"
import { TicketModel, type TicketDoc } from "../models/Ticket"
import { UserModel } from "../models/User"

/**
 * Semaphore SMS API Docs:
 * - POST https://api.semaphore.co/api/v4/messages
 * - Params: apikey, number (comma-separated), message, sendername (optional)
 * - Note: Messages that START with the word "TEST" are silently ignored by Semaphore.
 * - Limits: /messages is rate-limited (120/min); /priority and /otp are not.
 *
 * Related API (from docs):
 * - GET  https://api.semaphore.co/api/v4/messages            (retrieve messages)
 * - GET  https://api.semaphore.co/api/v4/messages/{id}       (retrieve single message)
 * - GET  https://api.semaphore.co/api/v4/account             (account info; rate-limited)
 *
 * Response includes:
 * - network: recipient phone number's network
 * - status: Queued | Pending | Sent | Failed | Refunded
 */

// We keep BOTH hosts because Semaphore docs/examples sometimes show semaphore.co and api.semaphore.co.
// Primary should be api.semaphore.co per docs.
const DEFAULT_SEMAPHORE_BASE_URLS = ["https://api.semaphore.co", "https://semaphore.co"]
const SEMAPHORE_API_V4_PREFIX = "/api/v4"

const SEMAPHORE_PATH_MESSAGES = "/messages"
const SEMAPHORE_PATH_PRIORITY = "/priority"
const SEMAPHORE_PATH_OTP = "/otp"
const SEMAPHORE_PATH_ACCOUNT = "/account"

// Semaphore says it supports all PH mobile networks (Globe, Smart, Sun, Dito).
// Network values returned by API can vary in casing/format, so we match loosely.
const DEFAULT_SUPPORTED_NETWORK_TOKENS = ["GLOBE", "SMART", "SUN", "DITO", "TM", "TNT"]

/**
 * Hardening goals (prevents 502 Bad Gateway in proxy/dev-server setups):
 * 1) Never allow this service to hang indefinitely:
 *    - Add request timeouts for Semaphore fetch()
 *    - Add timeouts for audit-log writes (Mongo can hang when unhealthy)
 * 2) Avoid throwing from common, user-facing flows:
 *    - sendSmsToQueuedUser() and sendTicketStatusSms() return structured errors instead of throwing
 *      so controllers/routes won't accidentally crash or leave unhandled promise rejections.
 */

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n))
}

function parseIntHeader(v: string | null) {
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
}

function getSemaphoreRequestTimeoutMs() {
    const raw =
        process.env.semaphore_request_timeout_ms ||
        process.env.SEMAPHORE_REQUEST_TIMEOUT_MS ||
        process.env.SEMAPHORE_TIMEOUT_MS
    // Default: 15s (fast fail so reverse proxies/dev proxies don’t timeout into 502)
    return clamp(Number(raw ?? 15_000), 3000, 60_000)
}

function getAuditLogTimeoutMs() {
    const raw = process.env.audit_log_timeout_ms || process.env.AUDIT_LOG_TIMEOUT_MS
    // Default: 800ms (audit logs must never block the API route)
    return clamp(Number(raw ?? 800), 100, 5000)
}

function getDbQueryTimeoutMs() {
    const raw = process.env.mongo_query_timeout_ms || process.env.MONGO_QUERY_TIMEOUT_MS
    // Default: 5s (avoid indefinite hangs on unhealthy Mongo)
    return clamp(Number(raw ?? 5000), 1000, 30_000)
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
    let t: any
    const timeout = new Promise<never>((_, reject) => {
        t = setTimeout(() => {
            const err: any = new Error(message)
            err.code = "ETIMEDOUT"
            reject(err)
        }, ms)
    })

    return Promise.race([promise, timeout]).finally(() => {
        if (t) clearTimeout(t)
    }) as Promise<T>
}

export type ActorRef = {
    id?: string | Types.ObjectId
    role?: "ADMIN" | "STAFF"
}

export type SemaphoreMessageStatus = "Queued" | "Pending" | "Sent" | "Failed" | "Refunded"

export type SemaphoreMessageResponse = {
    message_id: number
    user_id: number
    user: string
    account_id: number
    account: string
    recipient: string
    message: string
    sender_name: string
    network: string
    status: SemaphoreMessageStatus
    type: "single" | "bulk" | "priority" | string
    source: "api" | "webtool" | "csv" | string
    created_at: string
    updated_at: string
    code?: number | string
}

export type SemaphoreRateLimitInfo = {
    limit?: number
    remaining?: number
    retryAfter?: number
}

export type SendSmsOptions = {
    senderName?: string
    /**
     * If true, uses Semaphore priority queue endpoint (/priority).
     * Priority is 2 credits per 160 chars per Semaphore docs.
     */
    priority?: boolean
    /**
     * If true, uses OTP endpoint (/otp). Use ONLY for OTP traffic.
     * You may include "{otp}" in the message; Semaphore will replace it.
     */
    otp?: boolean
    /**
     * Optional OTP code if you want to provide your own code instead of auto-generated.
     */
    otpCode?: string | number
    /**
     * For audit logging (recommended for staff actions).
     */
    actor?: ActorRef
    /**
     * Useful for audit UI filtering.
     */
    entityType?: string
    entityId?: string | Types.ObjectId
    /**
     * Extra metadata to store in audit log.
     */
    meta?: Record<string, unknown>
    /**
     * If true (default), respects a user's smsUpdates=false when user can be resolved.
     */
    respectOptOut?: boolean
    /**
     * Optional: override supported network tokens used for reliability checks.
     */
    supportedNetworkTokens?: string[]
}

export type SmsDeliveryStatus = "QUEUED" | "PENDING" | "SENT" | "FAILED" | "REFUNDED" | "UNKNOWN"

export type SmsReliabilityInfo = {
    deliveryStatus: SmsDeliveryStatus
    providerNetwork?: string
    supportedNetwork: boolean | null
    providerMessageId?: number
    rawStatus?: SemaphoreMessageStatus
}

export type SendSmsToQueuedUserResult =
    | {
          skipped: true
          reason:
              | "opted_out"
              | "ticket_not_found"
              | "no_recipient"
              | "invalid_number"
              | "message_not_allowed"
              | "internal_error"
          error?: string
      }
    | {
          skipped: false
          sentTo: string
          provider: "semaphore"
          reliability: SmsReliabilityInfo
          providerResponse: SemaphoreMessageResponse[]
          /**
           * Present when the provider request failed (or other non-fatal issue) but we intentionally did NOT throw,
           * so API routes won't crash or time out into HTTP 502.
           */
          error?: string
      }

export type TicketStatusSmsResult = SendSmsToQueuedUserResult & {
    advanceNotice?: {
        enabled: boolean
        attempted: boolean
        // if attempted, nextTicketId is provided even when skipped/failed
        nextTicketId?: string
        nextQueueNumber?: number
        result?: SendSmsToQueuedUserResult
        error?: string
    }
}

/**
 * REQUIRED ENV:
 * - semaphore_api_key
 *
 * OPTIONAL ENV:
 * - semaphore_sendername (recommended: beginning July 1, 2024 users can no longer send from "Semaphore" sender name)
 * - semaphore_base_url (optional override, e.g. https://api.semaphore.co)
 * - queue_sms_advance_notice_enabled (true/false)  -> global toggle for advance notice SMS
 */
function getSemaphoreApiKey(): string {
    const key = (process.env.semaphore_api_key || process.env.SEMAPHORE_API_KEY || "").trim()
    if (!key) {
        throw new Error(
            "Missing Semaphore API key. Set env var `semaphore_api_key` (or `SEMAPHORE_API_KEY`)."
        )
    }
    return key
}

function getDefaultSenderName(): string | undefined {
    const name = (process.env.semaphore_sendername || process.env.SEMAPHORE_SENDERNAME || "").trim()
    return name || undefined
}

function getSemaphoreBaseUrls(): string[] {
    const envBase =
        (process.env.semaphore_base_url || process.env.SEMAPHORE_BASE_URL || "").trim() || undefined

    const bases = [envBase, ...DEFAULT_SEMAPHORE_BASE_URLS].filter(Boolean) as string[]

    // de-dupe while preserving order
    const out: string[] = []
    const seen = new Set<string>()
    for (const b of bases) {
        const normalized = String(b).trim().replace(/\/+$/, "")
        if (!normalized) continue
        if (seen.has(normalized)) continue
        seen.add(normalized)
        out.push(normalized)
    }
    return out
}

function buildSemaphoreEndpoint(baseUrl: string, pathAfterV4: string) {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "")
    if (!base) return ""
    // If user provides a URL that already contains /api/v4, don't duplicate it.
    if (/\/api\/v4$/i.test(base)) return `${base}${pathAfterV4}`
    if (/\/api$/i.test(base)) return `${base}/v4${pathAfterV4}`
    return `${base}${SEMAPHORE_API_V4_PREFIX}${pathAfterV4}`
}

function parseBooleanEnv(value: string | undefined, defaultValue = false) {
    if (!value) return defaultValue
    const v = value.trim().toLowerCase()
    if (["1", "true", "yes", "y", "on", "enabled"].includes(v)) return true
    if (["0", "false", "no", "n", "off", "disabled"].includes(v)) return false
    return defaultValue
}

function isAdvanceNoticeGloballyEnabled() {
    return parseBooleanEnv(
        process.env.queue_sms_advance_notice_enabled || process.env.QUEUE_SMS_ADVANCE_NOTICE_ENABLED,
        false
    )
}

function isRetryableHttpStatus(status?: number) {
    return (
        status === 408 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504
    )
}

function isRetryableNetworkError(e: any) {
    const name = String(e?.name || "")
    const code = String(e?.code || "")
    const msg = String(e?.message || "")
    // Abort/timeout or common transient network issues
    if (name === "AbortError") return true
    if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN" || code === "ENOTFOUND")
        return true
    if (/network error/i.test(msg)) return true
    return false
}

/**
 * Normalizes PH mobile numbers into "63XXXXXXXXXX" (no +).
 * Accepts:
 * - 09XXXXXXXXX
 * - +639XXXXXXXXX
 * - 639XXXXXXXXX
 */
export function normalizePhilippinesMobileNumber(input: string): string {
    const raw = String(input ?? "").trim()
    if (!raw) return ""

    const cleaned = raw.replace(/\s+/g, "").replace(/-/g, "")
    if (cleaned.startsWith("+63")) {
        const rest = cleaned.slice(3)
        return rest ? `63${rest}` : ""
    }

    if (cleaned.startsWith("63")) return cleaned

    if (cleaned.startsWith("09") && cleaned.length === 11) {
        return `63${cleaned.slice(1)}`
    }

    // Sometimes people store "9XXXXXXXXX" (10 digits)
    if (/^9\d{9}$/.test(cleaned)) {
        return `63${cleaned}`
    }

    // If it's already digits but unknown format, return as-is
    return cleaned
}

function isValidPhilippinesMobileNumber(normalized: string) {
    // 63 + 10 digits
    return /^63\d{10}$/.test(String(normalized || ""))
}

function maskMobileNumber(num: string): string {
    const n = String(num ?? "")
    if (n.length <= 4) return "****"
    return `${"*".repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`
}

function ensureMessageAllowed(message: string) {
    const trimmed = String(message ?? "").trim()
    if (!trimmed) throw new Error("SMS message is empty.")
    // Semaphore silently ignores messages starting with "TEST" per docs
    if (/^test\b/i.test(trimmed)) {
        throw new Error('SMS message must not start with the word "TEST" (Semaphore silently ignores these).')
    }
}

function normalizeNetworkTokens(network: string | undefined | null) {
    const raw = String(network || "").trim()
    if (!raw) return []
    // split by non-alphanumerics
    return raw
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .split(" ")
        .map((t) => t.trim())
        .filter(Boolean)
}

function checkSupportedNetwork(
    network: string | undefined | null,
    supportedTokens: string[]
): { supported: boolean | null; tokens: string[] } {
    const tokens = normalizeNetworkTokens(network)
    if (!tokens.length) return { supported: null, tokens: [] }

    const set = new Set(supportedTokens.map((x) => String(x).toUpperCase().trim()).filter(Boolean))
    const supported = tokens.some((t) => set.has(t))
    return { supported, tokens }
}

function mapDeliveryStatus(status?: SemaphoreMessageStatus): SmsDeliveryStatus {
    if (!status) return "UNKNOWN"
    if (status === "Queued") return "QUEUED"
    if (status === "Pending") return "PENDING"
    if (status === "Sent") return "SENT"
    if (status === "Failed") return "FAILED"
    if (status === "Refunded") return "REFUNDED"
    return "UNKNOWN"
}

type PostSemaphoreOptions = {
    maxAttempts?: number
    initialBackoffMs?: number
    maxBackoffMs?: number
    timeoutMs?: number
}

type PostSemaphoreResult = {
    messages: SemaphoreMessageResponse[]
    endpointUsed: string
    rateLimit?: SemaphoreRateLimitInfo
}

function extractRateLimitInfo(headers: Headers): SemaphoreRateLimitInfo | undefined {
    const limit = parseIntHeader(headers.get("x-ratelimit-limit"))
    const remaining = parseIntHeader(headers.get("x-ratelimit-remaining"))
    const retryAfter = parseIntHeader(headers.get("retry-after"))
    if (limit === undefined && remaining === undefined && retryAfter === undefined) return undefined
    return { limit, remaining, retryAfter }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const res = await fetch(url, { ...init, signal: controller.signal })
        return res
    } finally {
        clearTimeout(t)
    }
}

async function postSemaphore(
    urlCandidates: string[],
    payload: Record<string, string>,
    options: PostSemaphoreOptions = {}
): Promise<PostSemaphoreResult> {
    if (typeof (globalThis as any).fetch !== "function") {
        throw new Error(
            "Global fetch() is not available in this Node runtime. Upgrade to Node 18+ or add a fetch polyfill."
        )
    }

    const maxAttempts = clamp(Number(options.maxAttempts ?? 3), 1, 5)
    const initialBackoffMs = clamp(Number(options.initialBackoffMs ?? 600), 100, 10_000)
    const maxBackoffMs = clamp(Number(options.maxBackoffMs ?? 8000), 1000, 60_000)
    const timeoutMs = clamp(Number(options.timeoutMs ?? getSemaphoreRequestTimeoutMs()), 3000, 60_000)

    let lastErr: any

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let lastAttemptRateLimit: SemaphoreRateLimitInfo | undefined

        for (const url of urlCandidates) {
            try {
                const body = new URLSearchParams(payload)

                const res = await fetchWithTimeout(
                    url,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        body,
                    },
                    timeoutMs
                )

                const rateLimit = extractRateLimitInfo(res.headers)
                lastAttemptRateLimit = rateLimit || lastAttemptRateLimit

                const text = await res.text()
                let json: any
                try {
                    json = text ? JSON.parse(text) : null
                } catch {
                    json = null
                }

                if (!res.ok) {
                    const msg =
                        (json && (json.message || json.error)) ||
                        `Semaphore request failed (${res.status}).${
                            rateLimit?.retryAfter ? ` Retry-After: ${rateLimit.retryAfter}s.` : ""
                        }`

                    const err: any = new Error(msg)
                    err.status = res.status
                    err.data = json ?? text
                    err.retryAfter = rateLimit?.retryAfter
                    err.rateLimit = rateLimit
                    err.attempt = attempt
                    err.maxAttempts = maxAttempts
                    err.endpoint = url
                    throw err
                }

                // Semaphore commonly returns an array of message objects on success.
                if (Array.isArray(json)) {
                    return { messages: json as SemaphoreMessageResponse[], endpointUsed: url, rateLimit }
                }

                // Some variants may return a single object; normalize it to an array.
                if (json && typeof json === "object" && (json.message_id || json.status || json.recipient)) {
                    return { messages: [json as SemaphoreMessageResponse], endpointUsed: url, rateLimit }
                }

                return { messages: [], endpointUsed: url, rateLimit }
            } catch (e: any) {
                lastErr = e
                // If this candidate failed due to network/timeout, try the next candidate in the same attempt.
                if (isRetryableNetworkError(e)) continue
                // If it failed due to 404/host mismatch, try next candidate too.
                if (Number(e?.status) === 404) continue
                // Otherwise: stop iterating candidates and use retry/backoff if eligible.
                break
            }
        }

        const status = Number(lastErr?.status || 0) || undefined
        const retryAfterSec =
            typeof lastErr?.retryAfter === "number" && Number.isFinite(lastErr.retryAfter)
                ? lastErr.retryAfter
                : undefined

        const retryable =
            attempt < maxAttempts &&
            ((status ? isRetryableHttpStatus(status) : false) || isRetryableNetworkError(lastErr))

        if (!retryable) throw lastErr

        const backoff = Math.min(
            maxBackoffMs,
            retryAfterSec !== undefined
                ? clamp(retryAfterSec * 1000, 500, maxBackoffMs)
                : initialBackoffMs * Math.pow(2, attempt - 1)
        )

        await sleep(backoff)
    }

    throw lastErr || new Error("Semaphore request failed.")
}

/**
 * GET helpers (applies Semaphore docs):
 * - list messages
 * - get message by id
 * - get account details
 */
export type ListSemaphoreMessagesParams = {
    limit?: number
    page?: number
    startDate?: string // YYYY-MM-DD
    endDate?: string // YYYY-MM-DD
    network?: string // lowercase in docs, but we pass as-is
    status?: string // lowercase in docs, but we pass as-is
}

async function getSemaphore(
    urlCandidates: string[],
    params: Record<string, string>,
    options: { maxAttempts?: number; initialBackoffMs?: number; maxBackoffMs?: number; timeoutMs?: number } = {}
): Promise<{ json: any; endpointUsed: string; rateLimit?: SemaphoreRateLimitInfo }> {
    if (typeof (globalThis as any).fetch !== "function") {
        throw new Error(
            "Global fetch() is not available in this Node runtime. Upgrade to Node 18+ or add a fetch polyfill."
        )
    }

    const maxAttempts = clamp(Number(options.maxAttempts ?? 2), 1, 5)
    const initialBackoffMs = clamp(Number(options.initialBackoffMs ?? 600), 100, 10_000)
    const maxBackoffMs = clamp(Number(options.maxBackoffMs ?? 8000), 1000, 60_000)
    const timeoutMs = clamp(Number(options.timeoutMs ?? getSemaphoreRequestTimeoutMs()), 3000, 60_000)

    let lastErr: any

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        for (const urlBase of urlCandidates) {
            try {
                const qs = new URLSearchParams(params)
                const url = `${urlBase}?${qs.toString()}`
                const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs)
                const rateLimit = extractRateLimitInfo(res.headers)

                const text = await res.text()
                let json: any
                try {
                    json = text ? JSON.parse(text) : null
                } catch {
                    json = null
                }

                if (!res.ok) {
                    const msg =
                        (json && (json.message || json.error)) ||
                        `Semaphore request failed (${res.status}).${
                            rateLimit?.retryAfter ? ` Retry-After: ${rateLimit.retryAfter}s.` : ""
                        }`
                    const err: any = new Error(msg)
                    err.status = res.status
                    err.data = json ?? text
                    err.retryAfter = rateLimit?.retryAfter
                    err.rateLimit = rateLimit
                    err.attempt = attempt
                    err.maxAttempts = maxAttempts
                    err.endpoint = url
                    throw err
                }

                return { json, endpointUsed: urlBase, rateLimit }
            } catch (e: any) {
                lastErr = e
                if (isRetryableNetworkError(e)) continue
                if (Number(e?.status) === 404) continue
                break
            }
        }

        const status = Number(lastErr?.status || 0) || undefined
        const retryAfterSec =
            typeof lastErr?.retryAfter === "number" && Number.isFinite(lastErr.retryAfter)
                ? lastErr.retryAfter
                : undefined

        const retryable =
            attempt < maxAttempts &&
            ((status ? isRetryableHttpStatus(status) : false) || isRetryableNetworkError(lastErr))

        if (!retryable) throw lastErr

        const backoff = Math.min(
            maxBackoffMs,
            retryAfterSec !== undefined
                ? clamp(retryAfterSec * 1000, 500, maxBackoffMs)
                : initialBackoffMs * Math.pow(2, attempt - 1)
        )

        await sleep(backoff)
    }

    throw lastErr || new Error("Semaphore request failed.")
}

export async function listSemaphoreMessages(params: ListSemaphoreMessagesParams = {}) {
    const apiKey = getSemaphoreApiKey()
    const bases = getSemaphoreBaseUrls()
    const urls = bases.map((b) => buildSemaphoreEndpoint(b, SEMAPHORE_PATH_MESSAGES)).filter(Boolean)

    const q: Record<string, string> = { apikey: apiKey }
    if (params.limit !== undefined) q.limit = String(clamp(Number(params.limit), 1, 1000))
    if (params.page !== undefined) q.page = String(Math.max(1, Number(params.page)))
    if (params.startDate) q.startDate = String(params.startDate)
    if (params.endDate) q.endDate = String(params.endDate)
    if (params.network) q.network = String(params.network)
    if (params.status) q.status = String(params.status)

    const { json } = await getSemaphore(urls, q, { maxAttempts: 2 })
    return Array.isArray(json) ? (json as SemaphoreMessageResponse[]) : []
}

export async function getSemaphoreMessageById(id: string | number) {
    const apiKey = getSemaphoreApiKey()
    const bases = getSemaphoreBaseUrls()
    const suffix = `${SEMAPHORE_PATH_MESSAGES}/${encodeURIComponent(String(id))}`
    const urls = bases.map((b) => buildSemaphoreEndpoint(b, suffix)).filter(Boolean)

    const { json } = await getSemaphore(urls, { apikey: apiKey }, { maxAttempts: 2 })
    // API returns a single message object
    if (json && typeof json === "object") return json as SemaphoreMessageResponse
    return null
}

export async function getSemaphoreAccount() {
    const apiKey = getSemaphoreApiKey()
    const bases = getSemaphoreBaseUrls()
    const urls = bases.map((b) => buildSemaphoreEndpoint(b, SEMAPHORE_PATH_ACCOUNT)).filter(Boolean)

    const { json } = await getSemaphore(urls, { apikey: apiKey }, { maxAttempts: 2 })
    return json
}

/**
 * Low-level sender: send to one or many numbers (comma-separated) via Semaphore.
 * - Automatically normalizes PH numbers
 * - Supports bulk (<=1000 numbers per call, Semaphore limit)
 * - Supports priority and OTP endpoints
 *
 * Reliability enhancements:
 * - Validates PH mobile number format (63 + 10 digits); filters invalid numbers and logs them
 * - Tracks supported networks (based on Semaphore coverage), and logs unsupported/unknown
 * - Logs per-call status summary + response preview + errors (failed requests)
 */
export async function sendSms(
    numbers: string | string[],
    message: string,
    opts: SendSmsOptions = {}
): Promise<SemaphoreMessageResponse[]> {
    ensureMessageAllowed(message)

    const apiKey = getSemaphoreApiKey()
    const senderName = (opts.senderName || getDefaultSenderName() || "").trim() || undefined

    const list = Array.isArray(numbers) ? numbers : String(numbers ?? "").split(",")
    const normalizedAll = Array.from(
        new Set(
            list
                .map((n) => normalizePhilippinesMobileNumber(String(n)))
                .map((n) => n.trim())
                .filter(Boolean)
        )
    )

    const invalidRecipients = normalizedAll.filter((n) => !isValidPhilippinesMobileNumber(n))
    const normalized = normalizedAll.filter((n) => isValidPhilippinesMobileNumber(n))

    if (!normalized.length) {
        throw new Error(
            invalidRecipients.length
                ? "No valid PH recipient mobile numbers provided (expected 09XXXXXXXXX / +639XXXXXXXXX / 639XXXXXXXXX)."
                : "No valid recipient mobile numbers provided."
        )
    }

    // Semaphore allows up to 1000 recipients per API call for bulk messages
    const chunks: string[][] = []
    for (let i = 0; i < normalized.length; i += 1000) chunks.push(normalized.slice(i, i + 1000))

    const bases = getSemaphoreBaseUrls()
    const endpointPath = opts.otp
        ? SEMAPHORE_PATH_OTP
        : opts.priority
          ? SEMAPHORE_PATH_PRIORITY
          : SEMAPHORE_PATH_MESSAGES

    const urlCandidates = bases.map((b) => buildSemaphoreEndpoint(b, endpointPath)).filter(Boolean)

    const supportedTokens = (opts.supportedNetworkTokens?.length
        ? opts.supportedNetworkTokens
        : DEFAULT_SUPPORTED_NETWORK_TOKENS
    ).map((x) => String(x).toUpperCase().trim())

    const responses: SemaphoreMessageResponse[] = []

    // If there were invalids, log once per sendSms call (not per chunk)
    if (invalidRecipients.length) {
        await maybeAuditLog({
            actor: opts.actor,
            action: "SMS_RECIPIENT_INVALID_FORMAT",
            entityType: opts.entityType,
            entityId: opts.entityId,
            meta: {
                provider: "semaphore",
                invalidRecipientsCount: invalidRecipients.length,
                invalidRecipientsMasked: invalidRecipients.slice(0, 10).map(maskMobileNumber),
            },
        })
    }

    for (const chunk of chunks) {
        const payload: Record<string, string> = {
            apikey: apiKey,
            number: chunk.join(","),
            // normalize line breaks (safer for providers)
            message: String(message).replace(/\r\n/g, "\n"),
        }

        if (senderName) payload.sendername = senderName
        if (opts.otp && opts.otpCode !== undefined && opts.otpCode !== null) {
            payload.code = String(opts.otpCode)
        }

        let result: PostSemaphoreResult
        try {
            result = await postSemaphore(urlCandidates, payload, {
                // handle transient Semaphore 5xx/rate issues without crashing API routes immediately
                maxAttempts: 3,
                initialBackoffMs: 600,
                maxBackoffMs: 8000,
                timeoutMs: getSemaphoreRequestTimeoutMs(),
            })
        } catch (e: any) {
            await maybeAuditLog({
                actor: opts.actor,
                action: "SMS_FAILED",
                entityType: opts.entityType,
                entityId: opts.entityId,
                meta: {
                    provider: "semaphore",
                    endpointsTried: urlCandidates,
                    recipientsCount: chunk.length,
                    recipientsMasked: chunk.slice(0, 10).map(maskMobileNumber),
                    messageLen: String(message).length,
                    senderName: senderName ?? null,
                    errorMessage: String(e?.message || "Unknown error"),
                    httpStatus: e?.status ?? null,
                    rateLimit: e?.rateLimit ?? null,
                    retryAfter: e?.retryAfter ?? null,
                    attempt: e?.attempt ?? null,
                    maxAttempts: e?.maxAttempts ?? null,
                    endpointUsed: e?.endpoint ?? null,
                    providerErrorData: e?.data ?? null,
                    ...opts.meta,
                },
            })
            throw e
        }

        const r = result.messages
        responses.push(...r)

        const statusSummary = summarizeStatuses(r)
        const responsePreview = r.slice(0, 10).map((x) => ({
            recipient: maskMobileNumber(String(x?.recipient || "")),
            status: x?.status,
            network: x?.network,
            message_id: x?.message_id,
        }))

        const supportedSummary = summarizeSupportedNetworks(r, supportedTokens)
        const unsupportedPreview = r
            .filter((x) => {
                const chk = checkSupportedNetwork(x?.network, supportedTokens)
                return chk.supported === false
            })
            .slice(0, 10)
            .map((x) => ({
                recipient: maskMobileNumber(String(x?.recipient || "")),
                network: x?.network,
            }))

        // Audit per API call (not per recipient) to avoid spammy logs
        await maybeAuditLog({
            actor: opts.actor,
            action: "SMS_SENT",
            entityType: opts.entityType,
            entityId: opts.entityId,
            meta: {
                provider: "semaphore",
                endpointUsed: result.endpointUsed,
                endpointsTried: urlCandidates,
                rateLimit: result.rateLimit ?? null,
                recipientsCount: chunk.length,
                recipientsMasked: chunk.slice(0, 10).map(maskMobileNumber),
                messageLen: String(message).length,
                senderName: senderName ?? null,
                statusSummary,
                supportedNetworkSummary: supportedSummary,
                responsePreview,
                ...(unsupportedPreview.length
                    ? {
                          unsupportedNetworkPreview: unsupportedPreview,
                          unsupportedNetworkCount: supportedSummary.unsupported,
                      }
                    : {}),
                ...opts.meta,
            },
        })

        // If there are unsupported/unknown networks, log a specific action for easier filtering
        if (supportedSummary.unsupported > 0 || supportedSummary.unknown > 0) {
            await maybeAuditLog({
                actor: opts.actor,
                action: "SMS_NETWORK_CHECK",
                entityType: opts.entityType,
                entityId: opts.entityId,
                meta: {
                    provider: "semaphore",
                    endpointUsed: result.endpointUsed,
                    supportedNetworkSummary: supportedSummary,
                    unsupportedNetworkPreview: unsupportedPreview,
                },
            })
        }
    }

    return responses
}

function summarizeStatuses(items: SemaphoreMessageResponse[]) {
    const out: Record<string, number> = {}
    for (const it of items || []) {
        const key = String(it?.status ?? "unknown")
        out[key] = (out[key] || 0) + 1
    }
    return out
}

function summarizeSupportedNetworks(items: SemaphoreMessageResponse[], supportedTokens: string[]) {
    let supported = 0
    let unsupported = 0
    let unknown = 0

    for (const it of items || []) {
        const chk = checkSupportedNetwork(it?.network, supportedTokens)
        if (chk.supported === null) unknown += 1
        else if (chk.supported) supported += 1
        else unsupported += 1
    }

    return { supported, unsupported, unknown }
}

async function maybeAuditLog(args: {
    actor?: ActorRef
    action: string
    entityType?: string
    entityId?: string | Types.ObjectId
    meta?: Record<string, unknown>
}) {
    // NEVER let audit logging block SMS routes; Mongo can hang and cause proxy/dev-server 502s.
    const timeoutMs = getAuditLogTimeoutMs()

    try {
        await withTimeout(
            AuditLogModel.create({
                actor: args.actor?.id ? new Types.ObjectId(String(args.actor.id)) : undefined,
                actorRole: args.actor?.role,
                action: args.action,
                entityType: args.entityType,
                entityId: args.entityId ? new Types.ObjectId(String(args.entityId)) : undefined,
                meta: args.meta,
                createdAt: new Date(),
            }),
            timeoutMs,
            "Audit log write timed out"
        )
    } catch {
        // Don't block SMS sending if audit logging fails or times out
    }
}

async function resolveRecipientFromTicket(
    ticket: TicketDoc,
    respectOptOut: boolean
): Promise<{ number: string; userId?: string; optedOut?: boolean } | null> {
    // 1) Ticket phone has priority (guest/manual entry)
    if ((ticket as any).phone) {
        const num = normalizePhilippinesMobileNumber(String((ticket as any).phone))
        if (num) return { number: num }
    }

    // 2) Attempt to resolve from UserModel (participant record)
    const dbTimeoutMs = getDbQueryTimeoutMs()
    const user = await withTimeout(
        UserModel.findOne({
            $or: [{ tcNumber: (ticket as any).studentId }, { studentId: (ticket as any).studentId }],
        })
            .select({ _id: 1, smsUpdates: 1, mobileNumber: 1, phone: 1 })
            .lean()
            .exec(),
        dbTimeoutMs,
        "User lookup timed out"
    )

    if (!user) return null

    const optedOut = (user as any).smsUpdates === false
    if (respectOptOut && optedOut) {
        return { number: "", userId: String((user as any)._id), optedOut: true }
    }

    const candidate = String((user as any).mobileNumber || (user as any).phone || "")
    const normalized = normalizePhilippinesMobileNumber(candidate)
    if (!normalized) return null

    return { number: normalized, userId: String((user as any)._id), optedOut }
}

function buildReliabilityInfoFromProvider(
    providerResponse: SemaphoreMessageResponse[],
    supportedTokens: string[]
): SmsReliabilityInfo {
    const first = providerResponse?.[0]
    const rawStatus = first?.status
    const deliveryStatus = mapDeliveryStatus(rawStatus)
    const providerNetwork = first?.network ? String(first.network) : undefined
    const supported = checkSupportedNetwork(providerNetwork, supportedTokens).supported
    const providerMessageId = typeof first?.message_id === "number" ? first.message_id : undefined

    return {
        deliveryStatus,
        providerNetwork,
        supportedNetwork: supported,
        providerMessageId,
        rawStatus,
    }
}

function buildFailedReliabilityInfo(): SmsReliabilityInfo {
    return {
        deliveryStatus: "FAILED",
        providerNetwork: undefined,
        supportedNetwork: null,
        providerMessageId: undefined,
        rawStatus: undefined,
    }
}

/**
 * Staff helper: Send a custom message to the currently queued participant (by ticketId).
 * - Uses ticket.phone first, else resolves via UserModel
 * - Respects smsUpdates=false when user can be resolved (default)
 * - Adds reliability info: status/network/support
 *
 * IMPORTANT:
 * - This function is hardened to avoid throwing for common cases (prevents API crashes/timeouts -> 502).
 * - It returns structured results with `error` instead.
 */
export async function sendSmsToQueuedUser(params: {
    ticketId: string
    message: string
    options?: Omit<SendSmsOptions, "entityType" | "entityId">
}): Promise<SendSmsToQueuedUserResult> {
    const { ticketId, message } = params
    const options: SendSmsOptions = {
        respectOptOut: true,
        ...(params.options || {}),
        entityType: "TICKET",
        entityId: ticketId,
    }

    // Validate message early so routes don’t crash
    try {
        ensureMessageAllowed(message)
    } catch (e: any) {
        const errorMessage = String(e?.message || "Message not allowed")
        await maybeAuditLog({
            actor: options.actor,
            action: "SMS_MESSAGE_NOT_ALLOWED",
            entityType: "TICKET",
            entityId: ticketId,
            meta: {
                provider: "semaphore",
                errorMessage,
            },
        })
        return { skipped: true, reason: "message_not_allowed", error: errorMessage } as const
    }

    const dbTimeoutMs = getDbQueryTimeoutMs()

    let ticket: any | null
    try {
        ticket = await withTimeout(
            TicketModel.findById(ticketId).lean().exec(),
            dbTimeoutMs,
            "Ticket lookup timed out"
        )
    } catch (e: any) {
        const errorMessage = String(e?.message || "Ticket lookup failed")
        await maybeAuditLog({
            actor: options.actor,
            action: "SMS_TICKET_LOOKUP_FAILED",
            entityType: "TICKET",
            entityId: ticketId,
            meta: { errorMessage },
        })
        return { skipped: true, reason: "internal_error", error: errorMessage } as const
    }

    if (!ticket) {
        return { skipped: true, reason: "ticket_not_found", error: "Ticket not found." } as const
    }

    let resolved: { number: string; userId?: string; optedOut?: boolean } | null = null
    try {
        resolved = await resolveRecipientFromTicket(ticket, options.respectOptOut !== false)
    } catch (e: any) {
        const errorMessage = String(e?.message || "Recipient resolution failed")
        await maybeAuditLog({
            actor: options.actor,
            action: "SMS_RECIPIENT_RESOLUTION_FAILED",
            entityType: "TICKET",
            entityId: ticketId,
            meta: { errorMessage },
        })
        return { skipped: true, reason: "internal_error", error: errorMessage } as const
    }

    if (!resolved) {
        return {
            skipped: true,
            reason: "no_recipient",
            error: "No recipient phone number found for this ticket.",
        } as const
    }

    if (resolved.optedOut) {
        await maybeAuditLog({
            actor: options.actor,
            action: "SMS_SKIPPED_OPT_OUT",
            entityType: "TICKET",
            entityId: ticketId,
            meta: {
                reason: "smsUpdates=false",
                userId: resolved.userId ?? null,
            },
        })
        return {
            skipped: true,
            reason: "opted_out",
        } as const
    }

    if (!resolved.number) {
        return {
            skipped: true,
            reason: "invalid_number",
            error: "No valid recipient phone number found for this ticket.",
        } as const
    }

    const supportedTokens = (options.supportedNetworkTokens?.length
        ? options.supportedNetworkTokens
        : DEFAULT_SUPPORTED_NETWORK_TOKENS
    ).map((x) => String(x).toUpperCase().trim())

    try {
        const resp = await sendSms(resolved.number, message, options)
        const reliability = buildReliabilityInfoFromProvider(resp, supportedTokens)

        // If unsupported/unknown, create a focused audit entry (helps UI filters)
        if (reliability.supportedNetwork === false || reliability.supportedNetwork === null) {
            await maybeAuditLog({
                actor: options.actor,
                action: "SMS_UNSUPPORTED_OR_UNKNOWN_NETWORK",
                entityType: "TICKET",
                entityId: ticketId,
                meta: {
                    provider: "semaphore",
                    providerNetwork: reliability.providerNetwork ?? null,
                    supportedNetwork: reliability.supportedNetwork,
                    deliveryStatus: reliability.deliveryStatus,
                    providerMessageId: reliability.providerMessageId ?? null,
                },
            })
        }

        return {
            skipped: false,
            sentTo: resolved.number,
            provider: "semaphore",
            reliability,
            providerResponse: resp,
        } as const
    } catch (e: any) {
        const errorMessage = String(e?.message || "SMS provider request failed")

        await maybeAuditLog({
            actor: options.actor,
            action: "SMS_PROVIDER_REQUEST_FAILED",
            entityType: "TICKET",
            entityId: ticketId,
            meta: {
                provider: "semaphore",
                sentToMasked: maskMobileNumber(resolved.number),
                errorMessage,
                httpStatus: e?.status ?? null,
                rateLimit: e?.rateLimit ?? null,
                retryAfter: e?.retryAfter ?? null,
                attempt: e?.attempt ?? null,
                maxAttempts: e?.maxAttempts ?? null,
                endpointUsed: e?.endpoint ?? null,
                providerErrorData: e?.data ?? null,
                ...(options.meta || {}),
            },
        })

        // Return (do NOT throw) -> avoids API 500/timeout and lets UI show a friendly toast.
        return {
            skipped: false,
            sentTo: resolved.number,
            provider: "semaphore",
            reliability: buildFailedReliabilityInfo(),
            providerResponse: [],
            error: errorMessage,
        } as const
    }
}

/**
 * Staff helper: Send a friendly status SMS based on ticket state (called/hold/out/served).
 *
 * Optional Enhancement: Advance notice SMS (toggleable)
 * - When sending SMS for the current live queue (usually status=CALLED),
 *   automatically notify the NEXT WAITING ticket (smallest queueNumber > current.queueNumber).
 * - Toggle priority:
 *    1) env queue_sms_advance_notice_enabled = true/false (global toggle)
 *
 * HARDENED:
 * - returns structured results instead of throwing (prevents route crashes -> 502)
 */
export async function sendTicketStatusSms(params: {
    ticketId: string
    status: "CALLED" | "HOLD" | "OUT" | "SERVED"
    options?: Omit<SendSmsOptions, "entityType" | "entityId">
}): Promise<TicketStatusSmsResult> {
    const { ticketId, status } = params
    const options: SendSmsOptions = {
        respectOptOut: true,
        ...(params.options || {}),
        entityType: "TICKET",
        entityId: ticketId,
    }

    const dbTimeoutMs = getDbQueryTimeoutMs()

    let ticket: any | null
    try {
        ticket = await withTimeout(
            TicketModel.findById(ticketId).lean().exec(),
            dbTimeoutMs,
            "Ticket lookup timed out"
        )
    } catch (e: any) {
        const errorMessage = String(e?.message || "Ticket lookup failed")
        return {
            skipped: true,
            reason: "internal_error",
            error: errorMessage,
            advanceNotice: { enabled: isAdvanceNoticeGloballyEnabled(), attempted: false },
        } as const
    }

    if (!ticket) {
        return {
            skipped: true,
            reason: "ticket_not_found",
            error: "Ticket not found.",
            advanceNotice: { enabled: isAdvanceNoticeGloballyEnabled(), attempted: false },
        } as const
    }

    let dept: any | null = null
    try {
        dept = await withTimeout(
            DepartmentModel.findById(ticket.department).select({ name: 1, code: 1 }).lean().exec(),
            dbTimeoutMs,
            "Department lookup timed out"
        )
    } catch {
        dept = null
    }

    const deptLabel = dept?.name || dept?.code || "your office"

    const q = ticket.queueNumber
    const windowNo = ticket.windowNumber

    const msg = buildTicketStatusMessage({
        status,
        departmentLabel: deptLabel,
        queueNumber: q,
        windowNumber: windowNo,
    })

    // Send to CURRENT ticket (never throws for provider failures now)
    const currentResult = await sendSmsToQueuedUser({
        ticketId,
        message: msg,
        options,
    })

    // Optional: Advance notice to NEXT ticket (only meaningful when calling current)
    const advanceEnabled = isAdvanceNoticeGloballyEnabled()

    // If current was skipped OR provider failed, do NOT attempt advance notice.
    const currentProviderFailed =
        !currentResult.skipped && typeof (currentResult as any).error === "string" && !!(currentResult as any).error

    const shouldAttemptAdvance =
        advanceEnabled && status === "CALLED" && !currentResult.skipped && !currentProviderFailed

    let advanceNotice:
        | {
              enabled: boolean
              attempted: boolean
              nextTicketId?: string
              nextQueueNumber?: number
              result?: SendSmsToQueuedUserResult
              error?: string
          }
        | undefined

    if (!shouldAttemptAdvance) {
        advanceNotice = {
            enabled: advanceEnabled,
            attempted: false,
        }
        return { ...(currentResult as any), advanceNotice }
    }

    try {
        const nextTicket = await withTimeout(
            TicketModel.findOne({
                department: ticket.department,
                dateKey: ticket.dateKey,
                status: "WAITING",
                queueNumber: { $gt: ticket.queueNumber },
            })
                .sort({ queueNumber: 1 })
                .lean()
                .exec(),
            dbTimeoutMs,
            "Next ticket lookup timed out"
        )

        if (!nextTicket) {
            advanceNotice = {
                enabled: true,
                attempted: false,
            }
            return { ...(currentResult as any), advanceNotice }
        }

        const nextMsg = buildAdvanceNoticeMessage({
            departmentLabel: deptLabel,
            queueNumber: nextTicket.queueNumber,
        })

        const nextResult = await sendSmsToQueuedUser({
            ticketId: String((nextTicket as any)._id),
            message: nextMsg,
            options: {
                ...options,
                meta: {
                    ...(options.meta || {}),
                    advanceNotice: true,
                    relatedCurrentTicketId: ticketId,
                    relatedCurrentQueueNumber: ticket.queueNumber,
                },
            },
        })

        advanceNotice = {
            enabled: true,
            attempted: true,
            nextTicketId: String((nextTicket as any)._id),
            nextQueueNumber: nextTicket.queueNumber,
            result: nextResult,
        }

        await maybeAuditLog({
            actor: options.actor,
            action: "SMS_ADVANCE_NOTICE_SENT",
            entityType: "TICKET",
            entityId: String((nextTicket as any)._id),
            meta: {
                provider: "semaphore",
                relatedCurrentTicketId: ticketId,
                relatedCurrentQueueNumber: ticket.queueNumber,
                nextQueueNumber: nextTicket.queueNumber,
                nextTicketId: String((nextTicket as any)._id),
                outcome: (nextResult as any)?.skipped ? "skipped" : (nextResult as any)?.error ? "failed" : "sent",
            },
        })

        return { ...(currentResult as any), advanceNotice }
    } catch (e: any) {
        advanceNotice = {
            enabled: true,
            attempted: true,
            error: String(e?.message || "Advance notice failed"),
        }

        await maybeAuditLog({
            actor: options.actor,
            action: "SMS_ADVANCE_NOTICE_FAILED",
            entityType: "TICKET",
            entityId: ticketId,
            meta: {
                provider: "semaphore",
                errorMessage: String(e?.message || "Unknown error"),
                status: status,
            },
        })

        // Do NOT fail the main SMS if advance notice fails
        return { ...(currentResult as any), advanceNotice }
    }
}

function buildAdvanceNoticeMessage(args: { departmentLabel: string; queueNumber: number }) {
    const dept = args.departmentLabel
    const q = args.queueNumber
    return `Queue Update (${dept}): Advance notice — you're next. Ticket #${q}. Please be ready.`
}

function buildTicketStatusMessage(args: {
    status: "CALLED" | "HOLD" | "OUT" | "SERVED"
    departmentLabel: string
    queueNumber: number
    windowNumber?: number
}) {
    const dept = args.departmentLabel
    const q = args.queueNumber
    const w = args.windowNumber

    if (args.status === "CALLED") {
        if (w) {
            return `Queue Update (${dept}): You are now being called. Ticket #${q}. Please proceed to Window ${w}.`
        }
        return `Queue Update (${dept}): You are now being called. Ticket #${q}. Please proceed to the service window.`
    }

    if (args.status === "HOLD") {
        return `Queue Update (${dept}): Your ticket #${q} is on HOLD. Please stay nearby. We will notify you when you're called again.`
    }

    if (args.status === "OUT") {
        return `Queue Update (${dept}): Your ticket #${q} was marked as OUT. If you still need assistance, please re-queue at the kiosk/QR.`
    }

    // SERVED
    return `Queue Update (${dept}): Ticket #${q} is now SERVED. Thank you!`
}