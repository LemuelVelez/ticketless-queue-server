import type { Request, Response } from "express"

import {
    sendSms as sendSmsViaService,
    sendSmsToQueuedUser,
    sendTicketStatusSms,
    normalizePhilippinesMobileNumber,
    type ActorRef,
    type SendSmsOptions,
    type SendSmsToQueuedUserResult,
    type TicketStatusSmsResult,
} from "../services/smsManagement"

type SendSemaphoreSmsInput = {
    number: string
    message: string
    senderName?: string
}

type SmsControllerType = {
    sendSms: (req: Request, res: Response) => Promise<Response>
    sendTicketCalled: (req: Request, res: Response) => Promise<Response>
    sendTicketStatus: (req: Request, res: Response) => Promise<Response>
    // ✅ Unified: /tickets/:id/sms
    sendTicketSms: (req: Request, res: Response) => Promise<Response>
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return "Unknown error"
}

function inferHttpStatus(error: any): number {
    const status = Number(error?.status)
    if (Number.isFinite(status) && status >= 400 && status <= 599) return status

    const msg = String(error?.message || "").toLowerCase()

    if (msg.includes("ticket not found")) return 404
    if (msg.includes("missing semaphore api key")) return 500

    // validation-ish
    if (
        msg.includes("message") ||
        msg.includes("recipient") ||
        msg.includes("phone number") ||
        msg.includes("mobile") ||
        msg.includes("invalid") ||
        msg.includes("no valid")
    ) {
        return 400
    }

    return 500
}

function getActorFromReq(req: Request): ActorRef | undefined {
    const anyReq = req as any
    const user = anyReq?.user || anyReq?.auth?.user || anyReq?.currentUser
    if (!user) return undefined

    const id = user._id || user.id
    const roleRaw = String(user.role || "").toUpperCase()
    const role: ActorRef["role"] = roleRaw === "ADMIN" ? "ADMIN" : "STAFF"

    return { id, role }
}

function parseBooleanInput(value: unknown, defaultValue: boolean): boolean {
    if (value === undefined || value === null) return defaultValue
    if (typeof value === "boolean") return value
    const v = String(value).trim().toLowerCase()
    if (["1", "true", "yes", "y", "on", "enabled"].includes(v)) return true
    if (["0", "false", "no", "n", "off", "disabled"].includes(v)) return false
    return defaultValue
}

/**
 * Semaphore response receipt validation
 * Prevents "false success" where HTTP 200 returns but receipts show FAILED/REFUNDED (or empty receipts).
 */
type SemaphoreReceiptItem = {
    status?: string
    message_id?: number | string
    recipient?: string
    [key: string]: unknown
}

type SemaphoreReceiptValidation = {
    ok: boolean
    outcome: "sent" | "failed" | "unknown"
    statusSummary: Record<string, number>
    error?: string
    // helpful debugging (lightweight)
    receiptsCount: number
}

function normalizeSemaphoreStatus(status: unknown): string {
    return String(status ?? "").trim().toLowerCase()
}

function summarizeStatuses(items: Array<{ status?: string }> = []) {
    const out: Record<string, number> = {}
    for (const it of items) {
        const key = normalizeSemaphoreStatus(it?.status) || "unknown"
        out[key] = (out[key] || 0) + 1
    }
    return out
}

function validateSemaphoreReceipts(providerResponse: unknown): SemaphoreReceiptValidation {
    const receipts = Array.isArray(providerResponse) ? (providerResponse as SemaphoreReceiptItem[]) : []

    // Empty receipt should be treated as NOT OK (prevents silent "success" cases)
    if (!receipts.length) {
        return {
            ok: false,
            outcome: "unknown",
            statusSummary: {},
            receiptsCount: 0,
            error: "Empty provider receipt (no message receipts returned by Semaphore).",
        }
    }

    const okStatuses = new Set(["queued", "pending", "sent"])
    const failStatuses = new Set(["failed", "refunded"])

    const summary = summarizeStatuses(receipts)

    let okCount = 0
    let failCount = 0
    let unknownCount = 0

    for (const r of receipts) {
        const st = normalizeSemaphoreStatus(r?.status)
        if (okStatuses.has(st)) okCount++
        else if (failStatuses.has(st)) failCount++
        else unknownCount++
    }

    const ok = okCount > 0 && failCount === 0
    const outcome: SemaphoreReceiptValidation["outcome"] = ok ? "sent" : failCount > 0 ? "failed" : "unknown"

    const error = ok
        ? undefined
        : failCount > 0
          ? `Semaphore receipt status indicates failure (${Object.entries(summary)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ")})`
          : `Semaphore receipt status is not confirmable (${Object.entries(summary)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ")})`

    return {
        ok,
        outcome,
        statusSummary: summary,
        receiptsCount: receipts.length,
        error,
    }
}

/**
 * If smsManagement was updated to return a first-class receipt validation, prefer that.
 * Otherwise fall back to validating providerResponse.
 */
function getReceiptValidationFromResult(result: any): SemaphoreReceiptValidation | undefined {
    if (result && typeof result === "object") {
        // common patterns we might have in updated service
        if (typeof result.receiptOk === "boolean") {
            const statusSummary =
                result.receiptStatusSummary && typeof result.receiptStatusSummary === "object"
                    ? (result.receiptStatusSummary as Record<string, number>)
                    : summarizeStatuses(Array.isArray(result.providerResponse) ? result.providerResponse : [])

            const outcome: SemaphoreReceiptValidation["outcome"] = result.receiptOk
                ? "sent"
                : String(result.receiptOutcome || "").toLowerCase() === "unknown"
                  ? "unknown"
                  : "failed"

            return {
                ok: Boolean(result.receiptOk),
                outcome,
                statusSummary,
                receiptsCount: Array.isArray(result.providerResponse) ? result.providerResponse.length : 0,
                error: typeof result.receiptError === "string" ? result.receiptError : undefined,
            }
        }

        if (result.providerResponse !== undefined) {
            return validateSemaphoreReceipts(result.providerResponse)
        }
    }

    return undefined
}

function computeOutcome(result: any): "sent" | "skipped" | "failed" | "unknown" {
    if (!result || typeof result !== "object") return "unknown"
    if (result.skipped === true) return "skipped"
    if (result.skipped === false && typeof result.error === "string" && result.error.trim()) return "failed"
    if (result.skipped === false) return "sent"
    return "unknown"
}

/**
 * ✅ SAFE responder for staff ticket SMS endpoints:
 * - NEVER returns 5xx/4xx for provider failures / internal hiccups
 * - Always returns HTTP 200 with { ok:false, ... } so the UI won't crash/throw (axios)
 * - Still includes structured reason/outcome/details for toasts and debugging
 */
function respondTicketSms(
    res: Response,
    ctx: { ticketId: string; status?: string },
    result: SendSmsToQueuedUserResult | TicketStatusSmsResult
): Response {
    const outcome = computeOutcome(result as any)

    // Skipped cases (opt-out, no recipient, invalid number, ticket not found, etc.)
    if ((result as any).skipped === true) {
        const reason = String((result as any).reason || "skipped")
        const err = String((result as any).error || "").trim()

        return res.status(200).json({
            ok: false,
            provider: "semaphore",
            ticketId: ctx.ticketId,
            status: ctx.status,
            outcome: "skipped",
            reason,
            error: err || undefined,
            result,
        })
    }

    // Provider error surfaced by service (but service didn't throw)
    if ((result as any).skipped === false && typeof (result as any).error === "string" && (result as any).error.trim()) {
        const err = String((result as any).error || "").trim()
        return res.status(200).json({
            ok: false,
            provider: "semaphore",
            ticketId: ctx.ticketId,
            status: ctx.status,
            outcome: "failed",
            reason: "provider_error",
            error: err,
            // Keep lightweight details (still helpful for UI)
            result,
        })
    }

    // Receipt validation (prevents false success); return 200 ok=false if invalid
    const receipt = getReceiptValidationFromResult(result as any)
    if (receipt && receipt.ok === false) {
        return res.status(200).json({
            ok: false,
            provider: "semaphore",
            ticketId: ctx.ticketId,
            status: ctx.status,
            outcome: "failed",
            reason: "receipt_invalid",
            error: receipt.error || "Semaphore receipt indicates failure",
            statusSummary: receipt.statusSummary,
            receiptsCount: receipt.receiptsCount,
            result,
        })
    }

    // Sent successfully
    return res.status(200).json({
        ok: true,
        provider: "semaphore",
        ticketId: ctx.ticketId,
        status: ctx.status,
        outcome,
        statusSummary: receipt?.statusSummary,
        receiptsCount: receipt?.receiptsCount,
        result,
    })
}

/**
 * Backward-compatible helper export (in case other modules still import it).
 * Now delegates to the centralized smsManagement service.
 */
export async function sendSemaphoreSms(input: SendSemaphoreSmsInput): Promise<{
    number: string
    payload: unknown
}> {
    const resp = await sendSmsViaService(input.number, input.message, {
        senderName: input.senderName,
        respectOptOut: false, // raw send; do not attempt user opt-out resolution here
    })

    const normalized =
        String(resp?.[0]?.recipient || "").trim() ||
        normalizePhilippinesMobileNumber(input.number) ||
        String(input.number || "").trim()

    return { number: normalized, payload: resp }
}

async function sendSms(req: Request, res: Response): Promise<Response> {
    try {
        const body = (req.body || {}) as any

        const rawNumbers = body.numbers ?? body.number ?? body.phone ?? body.mobileNumber ?? ""
        const message = String(body.message ?? "").trim()
        const senderNameRaw = String(body.senderName ?? "").trim()
        const senderName = senderNameRaw && senderNameRaw !== "undefined" ? senderNameRaw : ""

        if (
            !rawNumbers ||
            (typeof rawNumbers === "string" && !rawNumbers.trim()) ||
            (Array.isArray(rawNumbers) && rawNumbers.length === 0)
        ) {
            return res.status(400).json({ ok: false, error: "number(s) is required" })
        }

        if (!message) {
            return res.status(400).json({ ok: false, error: "message is required" })
        }

        // Semaphore silently ignores messages that start with "TEST" (common false-success trap)
        if (/^test\b/i.test(message)) {
            return res.status(400).json({
                ok: false,
                error: 'message cannot start with "TEST" (Semaphore will silently ignore it)',
            })
        }

        const opts: SendSmsOptions = {
            senderName: senderName || undefined,
            priority: parseBooleanInput(body.priority, false),
            otp: parseBooleanInput(body.otp, false),
            otpCode: body.otpCode,
            respectOptOut: parseBooleanInput(body.respectOptOut, true),
            supportedNetworkTokens: Array.isArray(body.supportedNetworkTokens)
                ? body.supportedNetworkTokens
                : undefined,
            actor: getActorFromReq(req),
            entityType: body.entityType ? String(body.entityType) : undefined,
            entityId: body.entityId ? String(body.entityId) : undefined,
            meta: body.meta && typeof body.meta === "object" ? body.meta : undefined,
        }

        const providerResponse = await sendSmsViaService(rawNumbers, message, opts)

        // ✅ Validate receipts so we don't return ok=true when Semaphore receipts are FAILED/REFUNDED/empty
        const receipt = validateSemaphoreReceipts(providerResponse)
        const httpStatus = receipt.ok ? 200 : 502

        return res.status(httpStatus).json({
            ok: receipt.ok,
            provider: "semaphore",
            outcome: receipt.outcome,
            statusSummary: receipt.statusSummary,
            error: receipt.error,
            result: providerResponse,
        })
    } catch (error: any) {
        return res.status(inferHttpStatus(error)).json({
            ok: false,
            error: toErrorMessage(error),
        })
    }
}

/**
 * Legacy route handler: /tickets/:id/sms-called
 * - If body.message is provided: sends that custom message to the queued user (ticket-based recipient resolution)
 * - Else: sends standardized "CALLED" ticket status SMS (with optional advance notice if enabled via env)
 *
 * ✅ SAFETY:
 * - Always returns HTTP 200 with ok=false on failures (prevents UI/axios throwing)
 */
async function sendTicketCalled(req: Request, res: Response): Promise<Response> {
    const { id } = req.params
    try {
        const body = (req.body || {}) as any

        const customMessage = String(body.message ?? "").trim()
        const senderNameRaw = String(body.senderName ?? "").trim()
        const senderName = senderNameRaw && senderNameRaw !== "undefined" ? senderNameRaw : ""

        // Semaphore silently ignores messages that start with "TEST" (false-success trap)
        if (customMessage && /^test\b/i.test(customMessage)) {
            return res.status(200).json({
                ok: false,
                provider: "semaphore",
                ticketId: id,
                outcome: "failed",
                reason: "message_not_allowed",
                error: 'message cannot start with "TEST" (Semaphore will silently ignore it)',
            })
        }

        const options: Omit<SendSmsOptions, "entityType" | "entityId"> = {
            senderName: senderName || undefined,
            priority: parseBooleanInput(body.priority, false),
            otp: parseBooleanInput(body.otp, false),
            otpCode: body.otpCode,
            respectOptOut: parseBooleanInput(body.respectOptOut, true),
            supportedNetworkTokens: Array.isArray(body.supportedNetworkTokens)
                ? body.supportedNetworkTokens
                : undefined,
            actor: getActorFromReq(req),
            meta: body.meta && typeof body.meta === "object" ? body.meta : undefined,

            // ✅ Critical: never throw to the route for provider failures
            throwOnProviderFailure: false,
        }

        const result = customMessage
            ? await sendSmsToQueuedUser({
                  ticketId: id,
                  message: customMessage,
                  options,
              })
            : await sendTicketStatusSms({
                  ticketId: id,
                  status: "CALLED",
                  options,
              })

        return respondTicketSms(res, { ticketId: id, status: customMessage ? undefined : "CALLED" }, result)
    } catch (error: any) {
        // ✅ Never surface 500 for this endpoint; keep UI stable
        return res.status(200).json({
            ok: false,
            provider: "semaphore",
            ticketId: id,
            outcome: "failed",
            reason: "internal_error",
            error: toErrorMessage(error),
        })
    }
}

/**
 * Route handler: /tickets/:id/sms-status
 * Body:
 * - status: "CALLED" | "HOLD" | "OUT" | "SERVED"
 * - message?: custom override (if provided, it will send custom message instead of templated status SMS)
 *
 * ✅ SAFETY: always HTTP 200 with ok=false on failures
 */
async function sendTicketStatus(req: Request, res: Response): Promise<Response> {
    const { id } = req.params
    try {
        const body = (req.body || {}) as any

        const status = String(body.status ?? "").trim().toUpperCase()
        const customMessage = String(body.message ?? "").trim()
        const senderNameRaw = String(body.senderName ?? "").trim()
        const senderName = senderNameRaw && senderNameRaw !== "undefined" ? senderNameRaw : ""

        const allowed = new Set(["CALLED", "HOLD", "OUT", "SERVED"])
        if (!status || !allowed.has(status)) {
            return res.status(200).json({
                ok: false,
                provider: "semaphore",
                ticketId: id,
                outcome: "failed",
                reason: "invalid_status",
                error: 'status is required and must be one of: "CALLED" | "HOLD" | "OUT" | "SERVED"',
            })
        }

        // Semaphore silently ignores messages that start with "TEST" (false-success trap)
        if (customMessage && /^test\b/i.test(customMessage)) {
            return res.status(200).json({
                ok: false,
                provider: "semaphore",
                ticketId: id,
                outcome: "failed",
                reason: "message_not_allowed",
                error: 'message cannot start with "TEST" (Semaphore will silently ignore it)',
            })
        }

        const options: Omit<SendSmsOptions, "entityType" | "entityId"> = {
            senderName: senderName || undefined,
            priority: parseBooleanInput(body.priority, false),
            otp: parseBooleanInput(body.otp, false),
            otpCode: body.otpCode,
            respectOptOut: parseBooleanInput(body.respectOptOut, true),
            supportedNetworkTokens: Array.isArray(body.supportedNetworkTokens)
                ? body.supportedNetworkTokens
                : undefined,
            actor: getActorFromReq(req),
            meta: body.meta && typeof body.meta === "object" ? body.meta : undefined,

            // ✅ Critical: never throw to the route for provider failures
            throwOnProviderFailure: false,
        }

        const result = customMessage
            ? await sendSmsToQueuedUser({
                  ticketId: id,
                  message: customMessage,
                  options,
              })
            : await sendTicketStatusSms({
                  ticketId: id,
                  status: status as "CALLED" | "HOLD" | "OUT" | "SERVED",
                  options,
              })

        return respondTicketSms(res, { ticketId: id, status: customMessage ? undefined : status }, result)
    } catch (error: any) {
        return res.status(200).json({
            ok: false,
            provider: "semaphore",
            ticketId: id,
            outcome: "failed",
            reason: "internal_error",
            error: toErrorMessage(error),
        })
    }
}

/**
 * ✅ Unified alias route handler: /tickets/:id/sms
 * Supports:
 * - body.message (custom message)
 * - body.status (CALLED|HOLD|OUT|SERVED)
 * - if neither is provided: defaults to status=CALLED (matches legacy expectation)
 *
 * ✅ SAFETY: always HTTP 200 with ok=false on failures
 */
async function sendTicketSms(req: Request, res: Response): Promise<Response> {
    const { id } = req.params
    try {
        const body = (req.body || {}) as any

        const customMessage = String(body.message ?? "").trim()
        const statusRaw = String(body.status ?? "").trim().toUpperCase()
        const senderNameRaw = String(body.senderName ?? "").trim()
        const senderName = senderNameRaw && senderNameRaw !== "undefined" ? senderNameRaw : ""

        const allowed = new Set(["CALLED", "HOLD", "OUT", "SERVED"])
        const hasStatus = !!statusRaw
        const status = hasStatus ? statusRaw : "CALLED"

        if (hasStatus && !allowed.has(status)) {
            return res.status(200).json({
                ok: false,
                provider: "semaphore",
                ticketId: id,
                outcome: "failed",
                reason: "invalid_status",
                error: 'status must be one of: "CALLED" | "HOLD" | "OUT" | "SERVED"',
            })
        }

        // Semaphore silently ignores messages that start with "TEST" (false-success trap)
        if (customMessage && /^test\b/i.test(customMessage)) {
            return res.status(200).json({
                ok: false,
                provider: "semaphore",
                ticketId: id,
                outcome: "failed",
                reason: "message_not_allowed",
                error: 'message cannot start with "TEST" (Semaphore will silently ignore it)',
            })
        }

        const options: Omit<SendSmsOptions, "entityType" | "entityId"> = {
            senderName: senderName || undefined,
            priority: parseBooleanInput(body.priority, false),
            otp: parseBooleanInput(body.otp, false),
            otpCode: body.otpCode,
            respectOptOut: parseBooleanInput(body.respectOptOut, true),
            supportedNetworkTokens: Array.isArray(body.supportedNetworkTokens)
                ? body.supportedNetworkTokens
                : undefined,
            actor: getActorFromReq(req),
            meta: body.meta && typeof body.meta === "object" ? body.meta : undefined,

            // ✅ Critical: never throw to the route for provider failures
            throwOnProviderFailure: false,
        }

        const result = customMessage
            ? await sendSmsToQueuedUser({
                  ticketId: id,
                  message: customMessage,
                  options,
              })
            : await sendTicketStatusSms({
                  ticketId: id,
                  status: status as "CALLED" | "HOLD" | "OUT" | "SERVED",
                  options,
              })

        return respondTicketSms(res, { ticketId: id, status: customMessage ? undefined : status }, result)
    } catch (error: any) {
        return res.status(200).json({
            ok: false,
            provider: "semaphore",
            ticketId: id,
            outcome: "failed",
            reason: "internal_error",
            error: toErrorMessage(error),
        })
    }
}

export const smsController: SmsControllerType = {
    sendSms,
    sendTicketCalled,
    sendTicketStatus,
    sendTicketSms,
}