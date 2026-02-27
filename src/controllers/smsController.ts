import type { Request, Response } from "express"

import {
    sendSms as sendSmsViaService,
    sendSmsToQueuedUser,
    sendTicketStatusSms,
    normalizePhilippinesMobileNumber,
    type ActorRef,
    type SendSmsOptions,
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

        const numbers =
            body.numbers ??
            body.number ??
            body.phone ??
            body.mobileNumber ??
            ""

        const message = String(body.message ?? "").trim()
        const senderName = String(body.senderName ?? "").trim()

        if (!numbers || (typeof numbers === "string" && !numbers.trim())) {
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

        const providerResponse = await sendSmsViaService(numbers, message, opts)

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
        const senderName = String(body.senderName ?? "").trim()

        const options: SendSmsOptions = {
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

        return res.status(200).json({
            ok: true,
            provider: "semaphore",
            ticketId: id,
            result,
        })
    } catch (error: any) {
        return res.status(inferHttpStatus(error)).json({
            ok: false,
            error: toErrorMessage(error),
        })
    }
}

/**
 * New unified route handler: /tickets/:id/sms-status
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
        const senderName = String(body.senderName ?? "").trim()

        const allowed = new Set(["CALLED", "HOLD", "OUT", "SERVED"])
        if (!status || !allowed.has(status)) {
            return res.status(400).json({
                ok: false,
                error: 'status is required and must be one of: "CALLED" | "HOLD" | "OUT" | "SERVED"',
            })
        }

        const options: SendSmsOptions = {
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

        return res.status(200).json({
            ok: true,
            provider: "semaphore",
            ticketId: id,
            status,
            result,
        })
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
}