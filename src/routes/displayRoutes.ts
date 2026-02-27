import { Router } from "express"
import { displayController } from "../controllers/displayController"

const router = Router()

/**
 * PUBLIC DISPLAY (manager-based)
 * - Switch managers
 * - View windows + now serving
 * - Up next
 * - Voice announcements via announcements[].voiceText
 */
router.get("/managers", displayController.managers)
router.get("/manager/:manager/departments", displayController.departmentsByManager)
router.get("/manager/:manager/windows", displayController.windowsByManager)
router.get("/manager/:manager/state", displayController.managerState)
router.get("/manager/:manager/announcements", displayController.managerAnnouncements)

// Legacy monitor endpoints (now manager-based; requires ?manager=...)
router.get("/monitor/snapshot", displayController.monitorSnapshot)
router.get("/monitor/text", displayController.monitorText)

// Legacy voice announcement (supports query param or path param ticketId; also supports batch via ?manager=...&since=...)
router.get("/voice-announcement", displayController.voiceAnnouncement)
router.get("/voice-announcement/:ticketId", displayController.voiceAnnouncement)

// Department display (keep dynamic route last)
router.get("/:departmentId", displayController.departmentDisplay)

export default router