import { Router } from "express"
import { publicController } from "../controllers/publicController"
import { requireParticipantAuth } from "../controllers/middlewares"

const router = Router()

// Departments
router.get("/departments", publicController.listDepartments)

// Participant auth/session
router.post("/auth/signup/student", publicController.signupStudent)
router.post("/auth/signup/alumni-visitor", publicController.signupAlumniVisitor)
router.post("/auth/signup/guest", publicController.signupAlumniVisitor) // alias

router.post("/auth/login/student", publicController.loginStudent)
router.post("/auth/login/alumni-visitor", publicController.loginAlumniVisitor)
router.post("/auth/login/guest", publicController.loginAlumniVisitor) // alias

router.get("/auth/session", publicController.participantSession)
router.post("/auth/session", publicController.participantSession)
router.post("/auth/logout", publicController.logoutParticipant)

// Queue (participant-auth required)
router.post("/tickets/join", requireParticipantAuth, publicController.joinQueue)
router.post("/tickets/present", requireParticipantAuth, publicController.presentToDisplayMonitor)
router.post("/tickets/present-to-display-monitor", requireParticipantAuth, publicController.presentToDisplayMonitor)

// Optional helper
router.get("/tickets", requireParticipantAuth, publicController.findActiveByStudent)

// Ticket details (keep dynamic route last among /tickets/* paths)
router.get("/tickets/:id", requireParticipantAuth, publicController.getTicket)

export default router
