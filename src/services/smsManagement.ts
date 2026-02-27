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
 */
const SEMAPHORE_MESSAGES_URL = "https://api.semaphore.co/api/v4/messages"
const SEMAPHORE_PRIORITY_URL = "https://api.semaphore.co/api/v4/priority"
const SEMAPHORE_OTP_URL = "https://api.semaphore.co/api/v4/otp"

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
}

/**
 * REQUIRED ENV:
 * - semaphore_api_key
 *
 * OPTIONAL ENV:
 * - semaphore_sendername  (recommended: since "Semaphore" sender name is no longer allowed in many cases)
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

async function postSemaphore(
    url: string,
    payload: Record<string, string>
): Promise<SemaphoreMessageResponse[]> {
    if (typeof (globalThis as any).fetch !== "function") {
        throw new Error(
            "Global fetch() is not available in this Node runtime. Upgrade to Node 18+ or add a fetch polyfill."
        )
    }

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
            `Semaphore request failed (${res.status}).${retryAfter ? ` Retry-After: ${retryAfter}s.` : ""}`
        const err = new Error(msg)
        ;(err as any).status = res.status
        ;(err as any).data = json ?? text
        ;(err as any).retryAfter = retryAfter ? Number(retryAfter) : undefined
        throw err
    }

    // Semaphore returns an array of message objects on success
    if (!Array.isArray(json)) return []
    return json as SemaphoreMessageResponse[]
}

/**
 * Low-level sender: send to one or many numbers (comma-separated) via Semaphore.
 * - Automatically normalizes PH numbers
 * - Supports bulk (<=1000 numbers per call, Semaphore limit)
 * - Supports priority and OTP endpoints
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
    const normalized = Array.from(
        new Set(
            list
                .map((n) => normalizePhilippinesMobileNumber(String(n)))
                .map((n) => n.trim())
                .filter(Boolean)
        )
    )

    if (!normalized.length) throw new Error("No valid recipient mobile numbers provided.")

    // Semaphore allows up to 1000 recipients per API call for bulk messages
    const chunks: string[][] = []
    for (let i = 0; i < normalized.length; i += 1000) chunks.push(normalized.slice(i, i + 1000))

    const url = opts.otp ? SEMAPHORE_OTP_URL : opts.priority ? SEMAPHORE_PRIORITY_URL : SEMAPHORE_MESSAGES_URL

    const responses: SemaphoreMessageResponse[] = []
    for (const chunk of chunks) {
        const payload: Record<string, string> = {
            apikey: apiKey,
            number: chunk.join(","),
            message: String(message),
        }

        if (senderName) payload.sendername = senderName
        if (opts.otp && opts.otpCode !== undefined && opts.otpCode !== null) {
            payload.code = String(opts.otpCode)
        }

        const r = await postSemaphore(url, payload)
        responses.push(...r)

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
                recipientsMasked: chunk.slice(0, 10).map(maskMobileNumber), // keep small
                messageLen: String(message).length,
                senderName: senderName ?? null,
                responseStatuses: summarizeStatuses(r),
                ...opts.meta,
            },
        })
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

/**
 * Staff helper: Send a custom message to the currently queued participant (by ticketId).
 * - Uses ticket.phone first, else resolves via UserModel
 * - Respects smsUpdates=false when user can be resolved (default)
 */
export async function sendSmsToQueuedUser(params: {
    ticketId: string
    message: string
    options?: Omit<SendSmsOptions, "entityType" | "entityId">
}) {
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

    const resp = await sendSms(resolved.number, message, options)
    return {
        skipped: false,
        sentTo: resolved.number,
        provider: "semaphore",
        providerResponse: resp,
    } as const
}

/**
 * Staff helper: Send a friendly status SMS based on ticket state (called/hold/out/served).
 * This is ideal for queue updates like "You are being called now".
 */
export async function sendTicketStatusSms(params: {
    ticketId: string
    status: "CALLED" | "HOLD" | "OUT" | "SERVED"
    options?: Omit<SendSmsOptions, "entityType" | "entityId">
}) {
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

    return sendSmsToQueuedUser({
        ticketId,
        message: msg,
        options,
    })
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