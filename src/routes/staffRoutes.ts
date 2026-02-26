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

// Queue lists
router.get("/queue/waiting", staffController.listWaiting)
router.get("/queue/hold", staffController.listHold)
router.get("/queue/out", staffController.listOut)
router.get("/queue/history", staffController.listHistory)

/**
 * ✅ CENTRALIZED REAL-TIME QUEUE (Critical Foundation)
 * One unified queue state shared across all staff/windows:
 * - pollable staff queue state (single DB truth)
 * - race-safe "Next Queue" via backend atomic updates
 * - no separate display instances per staff window
 */
router.get("/queue/state", QueueManagementController.getStaffQueueState)
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

// ✅ SMS operations (Semaphore)
router.post("/sms/send", smsController.sendSms)
router.post("/tickets/:id/sms-called", smsController.sendTicketCalled)

// ✅ Staff reports (scoped to assigned department)
router.get("/reports/summary", staffController.reportsSummary)
router.get("/reports/timeseries", staffController.reportsTimeseries)

export default router