import { Router } from "express"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { staffController } from "../controllers/staffController"
import { smsController } from "../controllers/smsController"
import { QueueManagementController } from "../controllers/queueManagement"

const router = Router()

router.use(requireAuth, requireRole("STAFF"))

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
 * One unified queue state shared across all staff/windows:
 * - pollable staff queue state (single DB truth)
 * - race-safe "Next Queue" via backend atomic updates
 * - no separate display instances per staff window
 */
router.get("/queue/state", QueueManagementController.getStaffQueueState)

// ✅ Alias: some clients prefer an explicit "full" endpoint name
router.get("/queue/state-full", QueueManagementController.getStaffQueueState)

router.post("/queue/call-next-central", QueueManagementController.callNext)
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

// ✅ Primary endpoint used by UI: status OR custom message, defaults to CALLED if none
router.post("/tickets/:id/sms", smsController.sendTicketSms)

// ✅ Staff reports (scoped to assigned department)
router.get("/reports/summary", staffController.reportsSummary)
router.get("/reports/timeseries", staffController.reportsTimeseries)

export default router