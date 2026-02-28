import { Router } from "express"
import type { Request, Response } from "express"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { staffController } from "../controllers/staffController"
import { smsController } from "../controllers/smsController"
import { QueueManagementController } from "../controllers/queueManagement"
import { sendSmsToQueuedUser } from "../services/smsManagement"

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

/**
 * Receipt validation (route-local)
 * Prevents false ok=true when Semaphore returns receipts with FAILED/REFUNDED/empty.
 */
type SemaphoreReceiptItem = { status?: string; [k: string]: unknown }

function normalizeSemaphoreStatus(status: unknown): string {
    return String(status ?? "").trim().toLowerCase()
}

function summarizeSemaphoreStatuses(items: Array<SemaphoreReceiptItem> = []) {
    const out: Record<string, number> = {}
    for (const it of items) {
        const key = normalizeSemaphoreStatus(it?.status) || "unknown"
        out[key] = (out[key] || 0) + 1
    }
    return out
}

function validateSemaphoreReceipts(providerResponse: unknown): {
    ok: boolean
    outcome: "sent" | "failed" | "unknown"
    statusSummary: Record<string, number>
    error?: string
} {
    const receipts = Array.isArray(providerResponse) ? (providerResponse as SemaphoreReceiptItem[]) : []

    if (!receipts.length) {
        return {
            ok: false,
            outcome: "unknown",
            statusSummary: {},
            error: "Empty provider receipt (no message receipts returned by Semaphore).",
        }
    }

    const okStatuses = new Set(["queued", "pending", "sent"])
    const failStatuses = new Set(["failed", "refunded"])

    const summary = summarizeSemaphoreStatuses(receipts)

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
    const outcome: "sent" | "failed" | "unknown" = ok ? "sent" : failCount > 0 ? "failed" : "unknown"

    const error = ok
        ? undefined
        : failCount > 0
          ? `Semaphore receipt status indicates failure (${Object.entries(summary)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ")})`
          : `Semaphore receipt status is not confirmable (${Object.entries(summary)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ")})`

    return { ok, outcome, statusSummary: summary, error }
}

// Assignment
router.get("/me/assignment", staffController.myAssignment)

// ✅ Department-to-window assignment map (aligns with queue.service.ts routing behavior)
router.get("/queue/window-assignments", staffController.windowAssignments)

// ✅ Staff display snapshot (backend-integrated source for presenter/monitor UI)
router.get("/display/snapshot", staffController.displaySnapshot)

// ✅ Alias endpoint (explicit “full” snapshot; includes participant full names + student id/mobile display fields)
router.get("/display/snapshot-full", staffController.displaySnapshot)

// ✅ New alias for UIs that want an explicit “participants-enriched” name
router.get("/display/snapshot-participants", staffController.displaySnapshot)

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

// ✅ FIX: make /sms-called use the unified safe responder (prevents 500/5xx and always returns safe JSON)
router.post("/tickets/:id/sms-called", smsController.sendTicketSms)

// Unified ticket status SMS (CALLED | HOLD | OUT | SERVED) + optional custom message override
router.post("/tickets/:id/sms-status", smsController.sendTicketStatus)

/**
 * ✅ FIX: Primary endpoint used by UI: /staff/tickets/:id/sms
 * - Now uses centralized smsManagement service (single source of truth)
 * - Fixes false "SEMAPHORE_API_KEY is missing" by supporting multiple env key variants
 * - Returns 200 with ok=false on provider failure to avoid browser "Failed to load resource"
 * - ✅ Validates Semaphore receipts to prevent false success
 */
router.post("/tickets/:id/sms", async (req: Request, res: Response) => {
    try {
        const ticketId = String(req.params.id || "").trim()
        if (!ticketId) {
            res.setHeader("X-Error-Message", "Missing ticket id")
            return res.status(400).json({ ok: false, error: "Missing ticket id" })
        }

        const payload = (req.body || {}) as any
        const message = String(payload?.message ?? "").trim()

        // Sendername: prefer payload.senderName then env
        const senderFromPayload = normalizeSenderName(payload?.senderName)
        const senderFromEnv = normalizeSenderName(
            readEnvKey("SEMAPHORE_SENDERNAME", "SEMAPHORE_SENDER", "semaphore_sendername", "semaphore_sender"),
        )
        const sendername = senderFromPayload || senderFromEnv

        // Important: avoid defaulting to "Semaphore" (can be blocked). If empty, fail fast with guidance.
        if (!sendername) {
            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                reason: "Sender name is missing. Set SEMAPHORE_SENDERNAME (or semaphore_sendername) or pass senderName from UI.",
                error: "sendername_missing",
            })
        }

        // If UI doesn't send message, still allow but make it obvious
        const finalMessage = message || `Queue Update: You are being called now. Please proceed to your assigned window.`

        // Semaphore silently ignores messages that start with "TEST" (common false-success trap)
        if (/^test\b/i.test(finalMessage)) {
            return res.status(400).json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                error: 'message cannot start with "TEST" (Semaphore will silently ignore it)',
            })
        }

        const actorId = String((req as any)?.user?.id ?? "").trim() || undefined

        const result = await sendSmsToQueuedUser({
            ticketId,
            message: finalMessage,
            options: {
                senderName: sendername,
                priority: Boolean(payload?.priority),
                otp: Boolean(payload?.otp),
                otpCode: payload?.otpCode,
                actor: actorId ? { id: actorId, role: "STAFF" } : undefined,
                meta: { source: "/staff/tickets/:id/sms" },
            },
        })

        // Skipped cases: opted out, no recipient, invalid, ticket not found, message not allowed, internal error
        if ((result as any).skipped) {
            const reason = String((result as any).reason || "skipped")
            const errMsg = String((result as any).error || "")
            if (errMsg) res.setHeader("X-Error-Message", errMsg)

            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "skipped",
                reason,
                error: errMsg || undefined,
            })
        }

        // Provider error surfaced by service
        const providerError = String((result as any).error || "").trim()
        if (providerError) {
            res.setHeader("X-Error-Message", providerError)
            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                reason: providerError,
                error: "provider_error",
                result: {
                    sentTo: (result as any).sentTo,
                    reliability: (result as any).reliability,
                    providerResponse: (result as any).providerResponse,
                },
            })
        }

        // ✅ Receipt validation (prevents false ok=true)
        const receipt = validateSemaphoreReceipts((result as any).providerResponse)
        if (!receipt.ok) {
            const errMsg = receipt.error || "Semaphore receipt indicates failure"
            res.setHeader("X-Error-Message", errMsg)

            return res.json({
                ok: false,
                provider: "semaphore",
                ticketId,
                outcome: "failed",
                reason: errMsg,
                error: "receipt_invalid",
                statusSummary: receipt.statusSummary,
                result: {
                    sentTo: (result as any).sentTo,
                    reliability: (result as any).reliability,
                    providerResponse: (result as any).providerResponse,
                },
            })
        }

        return res.json({
            ok: true,
            provider: "semaphore",
            ticketId,
            outcome: "sent",
            number: (result as any).sentTo,
            statusSummary: receipt.statusSummary,
            result: {
                reliability: (result as any).reliability,
                providerResponse: (result as any).providerResponse,
            },
        })
    } catch (err: any) {
        // Never throw 502 here; keep UI stable with ok=false.
        const msg = String(err?.message || "Server error")
        return res.json({
            ok: false,
            provider: "semaphore",
            outcome: "failed",
            error: "server_error",
            reason: msg,
        })
    }
})

// ✅ Staff reports (scoped to assigned department)
router.get("/reports/summary", staffController.reportsSummary)
router.get("/reports/timeseries", staffController.reportsTimeseries)

export default router