import { Router } from "express"
import { publicController } from "../controllers/publicController"
import { homeController } from "../controllers/HomeController"
import { requireParticipantAuth } from "../controllers/middlewares"

const router = Router()

// Departments
router.get("/departments", publicController.listDepartments)

// Home overview charts
router.get("/home/overview", homeController.overview)

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

// Queue
// join/find/getTicket are intentionally open for legacy public kiosk flow;
// controller still supports session-token flow when Authorization/sessionToken is provided.
router.post("/tickets/join", publicController.joinQueue)
router.get("/tickets", publicController.findActiveByStudent)
router.get("/tickets/:id", publicController.getTicket)

// Display-monitor actions remain participant-protected.
router.post("/tickets/present", requireParticipantAuth, publicController.presentToDisplayMonitor)
router.post("/tickets/present-to-display-monitor", requireParticipantAuth, publicController.presentToDisplayMonitor)

export default router
