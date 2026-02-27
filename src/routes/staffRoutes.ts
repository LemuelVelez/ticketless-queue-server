import { Router } from "express"
import type { Request, Response } from "express"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { staffController } from "../controllers/staffController"
import { smsController } from "../controllers/smsController"
import { QueueManagementController } from "../controllers/queueManagement"
import { TicketModel } from "../models/Ticket"

const router = Router()

router.use(requireAuth, requireRole("STAFF"))

function readEnvKey(...keys: string[]) {
    for (const k of keys) {
        const v = String(process.env[k] ?? "").trim()
        if (v) return v
    }
    return ""
}

function normalizeSenderName(raw: unknown) {
    const s = String(raw ?? "").trim()
    if (!s) return ""
    // Sender Names are limited and must be alphanumeric (Semaphore requirement).
    // Keep it strict to prevent provider rejections.
    const cleaned = s.replace(/[^a-z0-9]/gi, "")
    return cleaned.slice(0, 11)
}

function normalizeMobileNumberPH(raw: unknown) {
    const s0 = String(raw ?? "").trim()
    if (!s0) return ""

    // remove spaces, dashes, parentheses
    let s = s0.replace(/[^\d+]/g, "")
    if (!s) return ""

    // +63XXXXXXXXXX -> 63XXXXXXXXXX
    if (s.startsWith("+63")) s = s.slice(1)

    // 63 9XXXXXXXXX -> 639XXXXXXXXX
    if (s.startsWith("63") && s.length === 12 && s[2] === "9") return s

    // 09XXXXXXXXX -> 639XXXXXXXXX (Semaphore accepts 639... per docs examples)
    if (s.startsWith("09") && s.length === 11) return `639${s.slice(2)}`

    // 9XXXXXXXXX -> 639XXXXXXXXX
    if (s.startsWith("9") && s.length === 10) return `639${s}`

    // Already 639XXXXXXXXX
    if (s.startsWith("639") && s.length === 12) return s

    // Fallback: return digits-only
    return s
}

function isLikelyValidPHMobile(num: string) {
    // Most reliable format in Semaphore examples: 639xxxxxxxxx
    return /^639\d{9}$/.test(num)
}

async function semaphoreSendMessage(args: {
    apikey: string
    number: string
    message: string
    sendername: string
    priority?: boolean
    otp?: boolean
    otpCode?: string | number
}) {
    const url = args.otp
        ? "https://api.semaphore.co/api/v4/otp"
        : args.priority
          ? "https://api.semaphore.co/api/v4/priority"
          : "https://api.semaphore.co/api/v4/messages"

    const params = new URLSearchParams()
    params.set("apikey", args.apikey)
    params.set("number", args.number)
    params.set("message", args.message)
    params.set("sendername", args.sendername)

    // OTP optional code param (Semaphore supports a `code` parameter for OTP)
    if (args.otp && args.otpCode !== undefined && args.otpCode !== null && String(args.otpCode).trim()) {
        params.set("code", String(args.otpCode).trim())
    }

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: params.toString(),
    })

    const text = await res.text()
    let json: any = text
    try {
        json = JSON.parse(text)
    } catch {
        // keep raw text
    }

    return { ok: res.ok, status: res.status, data: json }
}

function extractSemaphoreReliability(providerResponse: any) {
    // Semaphore returns an array of message objects for send endpoints.
    const first = Array.isArray(providerResponse) ? providerResponse[0] : providerResponse
    const statusRaw = String(first?.status ?? "").trim()
    const networkRaw = String(first?.network ?? "").trim()
    const messageIdRaw = first?.message_id

    const deliveryStatus = statusRaw ? statusRaw.toUpperCase() : "UNKNOWN"
    const providerNetwork = networkRaw || undefined

    // Supported networks check requested by your UI (GLOBE/SMART).
    const supported =
        providerNetwork
            ? ["GLOBE", "SMART"].includes(providerNetwork.toUpperCase())
            : null

    const providerMessageId =
        Number.isFinite(Number(messageIdRaw)) ? Number(messageIdRaw) : undefined

    return {
        reliability: {
            deliveryStatus,
            providerNetwork,
            supportedNetwork: supported,
            providerMessageId,
        },
    }
}

// Assignment
router.get("/me/assignment", staffController.myAssignment)

// ✅ Staff display snapshot (backend-integrated source for presenter/monitor UI)
router.get("/display/snapshot", staffController.displaySnapshot)

// ✅ Alias endpoint (explicit “full” snapshot; includes participant full names)
router.get("/display/snapshot-full", staffController.displaySnapshot)

// Queue lists
router.get("/queue/waiting", staffController.listWaiting)
router.get("/queue/hold", staffController.listHold)
router.get("/queue/out", staffController.listOut)
router.get("/queue/history", staffController.listHistory)

// ✅ Explicit “full” aliases (kept consistent with snapshot-full/state-full)
router.get("/queue/waiting-full", staffController.listWaiting)
router.get("/queue/hold-full", staffController.listHold)
router.get("/queue/out-full", staffController.listOut)
router.get("/queue/history-full", staffController.listHistory)
router.get("/queue/current-called-full", staffController.currentCalledForWindow)

/**
 * ✅ CENTRALIZED REAL-TIME QUEUE (Critical Foundation)
 */
router.get("/queue/state", QueueManagementController.getStaffQueueState)

// ✅ Alias: some clients prefer an explicit "full" endpoint name
router.get("/queue/state-full", QueueManagementController.getStaffQueueState)

// ✅ FIX: unblock UI immediately by routing call-next-central to the stable implementation
router.post("/queue/call-next-central", staffController.callNext)

router.post("/queue/serve", QueueManagementController.serve)
router.post("/queue/hold", QueueManagementController.hold)
router.post("/queue/out", QueueManagementController.out)

// Queue operations (legacy endpoints)
router.post("/queue/call-next", staffController.callNext)
router.get("/queue/current-called", staffController.currentCalledForWindow)
router.post("/tickets/:id/served", staffController.markServed)
router.post("/tickets/:id/hold", staffController.holdNoShow)
router.post("/tickets/:id/return", staffController.returnFromHold)

// ✅ SMS operations (Semaphore) - powered by centralized smsManagement service
router.post("/sms/send", smsController.sendSms)

// Legacy alias: sends CALLED status (or custom message if provided)
router.post("/tickets/:id/sms-called", smsController.sendTicketCalled)

// Unified ticket status SMS (CALLED | HOLD | OUT | SERVED) + optional custom message override
router.post("/tickets/:id/sms-status", smsController.sendTicketStatus)

/**
 * ✅ FIX: Primary endpoint used by UI: /staff/tickets/:id/sms
 * - Uses correct Semaphore endpoint + form-urlencoded payload
 * - Requires a real sendername (avoid default "Semaphore" which may be blocked)
 * - Returns 200 with ok=false on provider failure to avoid browser "Failed to load resource"
 */
router.post("/tickets/:id/sms", async (req: Request, res: Response) => {
    try {
        const ticketId = String(req.params.id || "").trim()
        if (!ticketId) {
            res.setHeader("X-Error-Message", "Missing ticket id")
            return res.status(400).json({ ok: false, error: "Missing ticket id" })
        }

        const apikey = readEnvKey("SEMAPHORE_API_KEY", "SEMAPHORE_APIKEY", "SEMAPHORE_KEY")
        if (!apikey) {
            res.setHeader("X-Error-Message", "SEMAPHORE_API_KEY is missing on server")
            return res.status(500).json({ ok: false, error: "SEMAPHORE_API_KEY is missing on server" })
        }

        const payload = (req.body || {}) as any
        const message = String(payload?.message ?? "").trim()

        // Semaphore silently ignores messages starting with "TEST" (docs behavior).
        if (message && /^test\b/i.test(message)) {
            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "skipped",
                reason: 'Message starts with "TEST" (Semaphore ignores these).',
                result: { skipped: true, reason: "test_prefix" },
            })
        }

        // Sendername: prefer payload.senderName then env
        const senderFromPayload = normalizeSenderName(payload?.senderName)
        const senderFromEnv = normalizeSenderName(readEnvKey("SEMAPHORE_SENDERNAME", "SEMAPHORE_SENDER"))
        const sendername = senderFromPayload || senderFromEnv

        // Important: avoid defaulting to "Semaphore" (can be blocked). If empty, fail fast with guidance.
        if (!sendername) {
            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                reason: "Sender name is missing. Set SEMAPHORE_SENDERNAME or pass senderName from UI.",
                error: "sendername_missing",
            })
        }

        const ticket = await TicketModel.findById(ticketId)
            .select("_id queueNumber phone mobileNumber studentId participantLabel participantFullName")
            .lean()

        if (!ticket) {
            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                reason: "Ticket not found.",
                error: "ticket_not_found",
            })
        }

        const rawNumber =
            String((ticket as any)?.phone ?? "").trim() ||
            String((ticket as any)?.mobileNumber ?? "").trim()

        const number = normalizeMobileNumberPH(rawNumber)

        if (!number || !isLikelyValidPHMobile(number)) {
            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                reason: "Ticket has no valid mobile number.",
                error: "invalid_number",
                number: rawNumber || null,
            })
        }

        // If UI doesn't send message, still allow but make it obvious
        const finalMessage =
            message ||
            `Queue Update: You are being called now. Ticket #${Number((ticket as any)?.queueNumber ?? 0) || "—"}.`

        const provider = await semaphoreSendMessage({
            apikey,
            number,
            message: finalMessage,
            sendername,
            priority: Boolean(payload?.priority),
            otp: Boolean(payload?.otp),
            otpCode: payload?.otpCode,
        })

        // Provider failed => return 200 with ok=false (no 502 spam in browser)
        if (!provider.ok) {
            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                reason: "Semaphore rejected the request.",
                number,
                error: "provider_error",
                result: {
                    httpStatus: provider.status,
                    providerResponse: provider.data,
                    ...extractSemaphoreReliability(provider.data),
                },
            })
        }

        const reliabilityPack = extractSemaphoreReliability(provider.data)
        const deliveryStatus = String(reliabilityPack?.reliability?.deliveryStatus ?? "UNKNOWN").toUpperCase()
        const outcome = deliveryStatus === "FAILED" ? "failed" : "sent"

        return res.json({
            ok: outcome === "sent",
            provider: "semaphore",
            ticketId,
            outcome,
            number,
            result: {
                providerResponse: provider.data,
                ...reliabilityPack,
            },
        })
    } catch (err: any) {
        // Never throw 502 here; keep UI stable with ok=false.
        return res.json({
            ok: false,
            provider: "semaphore",
            outcome: "failed",
            error: "server_error",
            reason: String(err?.message || "Server error"),
        })
    }
})

// ✅ Staff reports (scoped to assigned department)
router.get("/reports/summary", staffController.reportsSummary)
router.get("/reports/timeseries", staffController.reportsTimeseries)

export default router