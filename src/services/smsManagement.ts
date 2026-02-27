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
 * - Limits: /messages is rate-limited; /priority and /otp are not. (See Semaphore docs.)
 *
 * Response includes:
 * - network: recipient phone number's network
 * - status: Queued | Pending | Sent | Failed | Refunded
 */
const SEMAPHORE_MESSAGES_URL = "https://api.semaphore.co/api/v4/messages"
const SEMAPHORE_PRIORITY_URL = "https://api.semaphore.co/api/v4/priority"
const SEMAPHORE_OTP_URL = "https://api.semaphore.co/api/v4/otp"

// Semaphore says it supports all PH mobile networks (Globe, Smart, Sun, Dito).
// Network values returned by API can vary in casing/format, so we match loosely.
const DEFAULT_SUPPORTED_NETWORK_TOKENS = ["GLOBE", "SMART", "SUN", "DITO", "TM", "TNT"]

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
          reason: "opted_out"
      }
    | {
          skipped: false
          sentTo: string
          provider: "semaphore"
          reliability: SmsReliabilityInfo
          providerResponse: SemaphoreMessageResponse[]
          /**
           * Present when the provider request failed but we intentionally did NOT throw,
           * so API routes won't return HTTP 500.
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
 * - semaphore_sendername (recommended: starting July 1, 2024 users can no longer send from "Semaphore" sender name)
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

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function isRetryableHttpStatus(status?: number) {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n))
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

    // If it's already digits but unknown format, return as-is (Semaphore may still accept, but best to store PH formats)
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
}

async function postSemaphore(
    url: string,
    payload: Record<string, string>,
    options: PostSemaphoreOptions = {}
): Promise<SemaphoreMessageResponse[]> {
    if (typeof (globalThis as any).fetch !== "function") {
        throw new Error(
            "Global fetch() is not available in this Node runtime. Upgrade to Node 18+ or add a fetch polyfill."
        )
    }

    const maxAttempts = clamp(Number(options.maxAttempts ?? 3), 1, 5)
    const initialBackoffMs = clamp(Number(options.initialBackoffMs ?? 600), 100, 10_000)
    const maxBackoffMs = clamp(Number(options.maxBackoffMs ?? 8000), 1000, 60_000)

    let lastErr: any

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const body = new URLSearchParams(payload)

            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
            })

            const text = await res.text()
            let json: any
            try {
                json = text ? JSON.parse(text) : null
            } catch {
                json = null
            }

            if (!res.ok) {
                const retryAfter = res.headers.get("retry-after")
                const msg =
                    (json && (json.message || json.error)) ||
                    `Semaphore request failed (${res.status}).${
                        retryAfter ? ` Retry-After: ${retryAfter}s.` : ""
                    }`
                const err = new Error(msg)
                ;(err as any).status = res.status
                ;(err as any).data = json ?? text
                ;(err as any).retryAfter = retryAfter ? Number(retryAfter) : undefined
                ;(err as any).attempt = attempt
                ;(err as any).maxAttempts = maxAttempts
                throw err
            }

            // Semaphore commonly returns an array of message objects on success.
            if (Array.isArray(json)) return json as SemaphoreMessageResponse[]

            // Some variants/endpoints may return a single object; normalize it to an array.
            if (json && typeof json === "object" && (json.message_id || json.status || json.recipient)) {
                return [json as SemaphoreMessageResponse]
            }

            return []
        } catch (e: any) {
            lastErr = e

            const status = Number(e?.status || 0) || undefined
            const retryAfterSec =
                typeof e?.retryAfter === "number" && Number.isFinite(e.retryAfter) ? e.retryAfter : undefined

            const shouldRetry = attempt < maxAttempts && (status ? isRetryableHttpStatus(status) : false)

            if (!shouldRetry) throw e

            const backoff = Math.min(
                maxBackoffMs,
                retryAfterSec !== undefined
                    ? clamp(retryAfterSec * 1000, 500, maxBackoffMs)
                    : initialBackoffMs * Math.pow(2, attempt - 1)
            )

            await sleep(backoff)
        }
    }

    throw lastErr || new Error("Semaphore request failed.")
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

    const url = opts.otp ? SEMAPHORE_OTP_URL : opts.priority ? SEMAPHORE_PRIORITY_URL : SEMAPHORE_MESSAGES_URL
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

        let r: SemaphoreMessageResponse[] = []
        try {
            r = await postSemaphore(url, payload, {
                // handle transient Semaphore 5xx/rate issues without crashing API routes immediately
                maxAttempts: 3,
                initialBackoffMs: 600,
                maxBackoffMs: 8000,
            })
        } catch (e: any) {
            await maybeAuditLog({
                actor: opts.actor,
                action: "SMS_FAILED",
                entityType: opts.entityType,
                entityId: opts.entityId,
                meta: {
                    provider: "semaphore",
                    endpoint: url,
                    recipientsCount: chunk.length,
                    recipientsMasked: chunk.slice(0, 10).map(maskMobileNumber),
                    messageLen: String(message).length,
                    senderName: senderName ?? null,
                    errorMessage: String(e?.message || "Unknown error"),
                    httpStatus: e?.status ?? null,
                    retryAfter: e?.retryAfter ?? null,
                    attempt: e?.attempt ?? null,
                    maxAttempts: e?.maxAttempts ?? null,
                    providerErrorData: e?.data ?? null,
                    ...opts.meta,
                },
            })
            throw e
        }

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
                endpoint: url,
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
                    endpoint: url,
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
    try {
        await AuditLogModel.create({
            actor: args.actor?.id ? new Types.ObjectId(String(args.actor.id)) : undefined,
            actorRole: args.actor?.role,
            action: args.action,
            entityType: args.entityType,
            entityId: args.entityId ? new Types.ObjectId(String(args.entityId)) : undefined,
            meta: args.meta,
            createdAt: new Date(),
        })
    } catch {
        // Don't block SMS sending if audit logging fails
    }
}

async function resolveRecipientFromTicket(
    ticket: TicketDoc,
    respectOptOut: boolean
): Promise<{ number: string; userId?: string; optedOut?: boolean } | null> {
    // 1) Ticket phone has priority (guest/manual entry)
    if (ticket.phone) {
        const num = normalizePhilippinesMobileNumber(ticket.phone)
        if (num) return { number: num }
    }

    // 2) Attempt to resolve from UserModel (participant record)
    const user = await UserModel.findOne({
        $or: [{ tcNumber: ticket.studentId }, { studentId: ticket.studentId }],
    })
        .select({ _id: 1, smsUpdates: 1, mobileNumber: 1, phone: 1 })
        .lean()

    if (!user) return null

    const optedOut = user.smsUpdates === false
    if (respectOptOut && optedOut) {
        return { number: "", userId: String(user._id), optedOut: true }
    }

    const candidate = String(user.mobileNumber || user.phone || "")
    const normalized = normalizePhilippinesMobileNumber(candidate)
    if (!normalized) return null

    return { number: normalized, userId: String(user._id), optedOut }
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
 * IMPORTANT CHANGE:
 * - If Semaphore/provider request fails, we return a structured result with `error`
 *   instead of throwing, so API routes won't respond with HTTP 500.
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

    const ticket = await TicketModel.findById(ticketId).lean()
    if (!ticket) throw new Error("Ticket not found.")

    const resolved = await resolveRecipientFromTicket(ticket, options.respectOptOut !== false)

    if (!resolved) throw new Error("No recipient phone number found for this ticket.")
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

    if (!resolved.number) throw new Error("No valid recipient phone number found for this ticket.")

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
                retryAfter: e?.retryAfter ?? null,
                attempt: e?.attempt ?? null,
                maxAttempts: e?.maxAttempts ?? null,
                providerErrorData: e?.data ?? null,
                ...(options.meta || {}),
            },
        })

        // Return (do NOT throw) -> avoids API 500 and lets UI show a friendly toast.
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
 *    1) explicit param options.meta.advanceNoticeEnabled (boolean) is NOT used (we keep it simple)
 *    2) env queue_sms_advance_notice_enabled = true/false (global toggle)
 *
 * Reliability Checks:
 * - Network supported/unknown is logged (uses provider response `network`)
 * - Provider response preview + status summary are logged by sendSms()
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

    const ticket = await TicketModel.findById(ticketId).lean()
    if (!ticket) throw new Error("Ticket not found.")

    const dept = await DepartmentModel.findById(ticket.department).select({ name: 1, code: 1 }).lean()
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

    // If current was skipped (opt-out) OR provider failed, do NOT attempt advance notice.
    const currentProviderFailed =
        !currentResult.skipped && typeof (currentResult as any).error === "string" && !!(currentResult as any).error

    const shouldAttemptAdvance = advanceEnabled && status === "CALLED" && !currentResult.skipped && !currentProviderFailed

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
        const nextTicket = await TicketModel.findOne({
            department: ticket.department,
            dateKey: ticket.dateKey,
            status: "WAITING",
            queueNumber: { $gt: ticket.queueNumber },
        })
            .sort({ queueNumber: 1 })
            .lean()

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
                outcome: (nextResult as any)?.skipped
                    ? "skipped"
                    : (nextResult as any)?.error
                      ? "failed"
                      : "sent",
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