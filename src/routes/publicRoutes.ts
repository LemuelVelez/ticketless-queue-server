import { Router } from "express"
import { publicController } from "../controllers/publicController"

const router = Router()

// Departments
router.get("/departments", publicController.listDepartments)

// Participant auth/session
router.post("/auth/signup/student", publicController.signupStudent)
router.post("/auth/signup/alumni-visitor", publicController.signupAlumniVisitor)
router.post("/auth/login/student", publicController.loginStudent)
router.post("/auth/login/alumni-visitor", publicController.loginAlumniVisitor)
router.get("/auth/session", publicController.participantSession)
router.post("/auth/session", publicController.participantSession)
router.post("/auth/logout", publicController.logoutParticipant)

// Queue
router.post("/tickets/join", publicController.joinQueue)
router.post("/tickets/present", publicController.presentToDisplayMonitor)
router.post("/tickets/present-to-display-monitor", publicController.presentToDisplayMonitor)

// Optional helper
router.get("/tickets", publicController.findActiveByStudent)

// Ticket details (keep dynamic route last among /tickets/* paths)
router.get("/tickets/:id", publicController.getTicket)

export default router
