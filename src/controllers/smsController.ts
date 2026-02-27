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

function summarizeStatuses(items: Array<{ status?: string }> = []) {
    const out: Record<string, number> = {}
    for (const it of items) {
        const key = String(it?.status ?? "unknown")
        out[key] = (out[key] || 0) + 1
    }
    return out
}

function computeOutcome(result: any): "sent" | "skipped" | "failed" | "unknown" {
    if (!result || typeof result !== "object") return "unknown"
    if (result.skipped === true) return "skipped"
    if (result.skipped === false && typeof result.error === "string" && result.error.trim()) return "failed"
    if (result.skipped === false) return "sent"
    return "unknown"
}

function skippedReasonToHttpStatus(reason: string | undefined) {
    if (!reason) return 400
    if (reason === "opted_out") return 200
    if (reason === "ticket_not_found") return 404
    if (reason === "internal_error") return 500
    // no_recipient | invalid_number | message_not_allowed
    return 400
}

function respondTicketSms(
    res: Response,
    ctx: { ticketId: string; status?: string },
    result: SendSmsToQueuedUserResult | TicketStatusSmsResult
): Response {
    const outcome = computeOutcome(result as any)

    // ✅ New service behavior: it returns structured "skipped" results (no throw).
    // Controller must map those to proper HTTP responses.
    if ((result as any).skipped === true) {
        const reason = String((result as any).reason || "unknown")
        const httpStatus = skippedReasonToHttpStatus(reason)
        const ok = httpStatus === 200 // only opted_out becomes ok=true

        return res.status(httpStatus).json({
            ok,
            provider: "semaphore",
            ticketId: ctx.ticketId,
            status: ctx.status,
            outcome,
            reason,
            error: (result as any).error,
            result,
        })
    }

    // Provider failure (upstream) -> HTTP 502 but include structured payload for UI
    if ((result as any).skipped === false && typeof (result as any).error === "string" && (result as any).error.trim()) {
        return res.status(502).json({
            ok: false,
            provider: "semaphore",
            ticketId: ctx.ticketId,
            status: ctx.status,
            outcome,
            error: (result as any).error,
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

        return res.status(200).json({
            ok: true,
            provider: "semaphore",
            statusSummary: summarizeStatuses(providerResponse),
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
 */
async function sendTicketCalled(req: Request, res: Response): Promise<Response> {
    try {
        const { id } = req.params
        const body = (req.body || {}) as any

        const customMessage = String(body.message ?? "").trim()
        const senderNameRaw = String(body.senderName ?? "").trim()
        const senderName = senderNameRaw && senderNameRaw !== "undefined" ? senderNameRaw : ""

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
        return res.status(inferHttpStatus(error)).json({
            ok: false,
            error: toErrorMessage(error),
        })
    }
}

/**
 * Route handler: /tickets/:id/sms-status
 * Body:
 * - status: "CALLED" | "HOLD" | "OUT" | "SERVED"
 * - message?: custom override (if provided, it will send custom message instead of templated status SMS)
 */
async function sendTicketStatus(req: Request, res: Response): Promise<Response> {
    try {
        const { id } = req.params
        const body = (req.body || {}) as any

        const status = String(body.status ?? "").trim().toUpperCase()
        const customMessage = String(body.message ?? "").trim()
        const senderNameRaw = String(body.senderName ?? "").trim()
        const senderName = senderNameRaw && senderNameRaw !== "undefined" ? senderNameRaw : ""

        const allowed = new Set(["CALLED", "HOLD", "OUT", "SERVED"])
        if (!status || !allowed.has(status)) {
            return res.status(400).json({
                ok: false,
                error: 'status is required and must be one of: "CALLED" | "HOLD" | "OUT" | "SERVED"',
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
        return res.status(inferHttpStatus(error)).json({
            ok: false,
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
 */
async function sendTicketSms(req: Request, res: Response): Promise<Response> {
    try {
        const { id } = req.params
        const body = (req.body || {}) as any

        const customMessage = String(body.message ?? "").trim()
        const statusRaw = String(body.status ?? "").trim().toUpperCase()
        const senderNameRaw = String(body.senderName ?? "").trim()
        const senderName = senderNameRaw && senderNameRaw !== "undefined" ? senderNameRaw : ""

        const allowed = new Set(["CALLED", "HOLD", "OUT", "SERVED"])
        const hasStatus = !!statusRaw
        const status = hasStatus ? statusRaw : "CALLED"

        if (hasStatus && !allowed.has(status)) {
            return res.status(400).json({
                ok: false,
                error: 'status must be one of: "CALLED" | "HOLD" | "OUT" | "SERVED"',
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
        return res.status(inferHttpStatus(error)).json({
            ok: false,
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