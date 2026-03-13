import { Router } from "express"
import {
    AuditLogController,
    AuthController,
    DepartmentController,
    ServiceWindowController,
    SettingController,
    TicketController,
    UserController,
} from "../controllers"
import { PublicDisplayController } from "../controllers/PublicDisplayController"
import {
    requireAuth,
    requireRoles,
} from "../controllers/middlewares"

export const ROUTE_PATHS = {
    auth: {
        register: "/auth/register",
        login: "/auth/login",
        forgotPassword: "/auth/forgot-password",
        resetPassword: "/auth/reset-password",
        me: "/auth/me",
    },
    settings: {
        current: "/settings/current",
    },
    auditLogs: {
        recent: "/audit-logs/recent",
        byActor: "/audit-logs/actor/:actorId",
    },
    departments: {
        enabled: "/departments/enabled",
        byId: "/departments/:id",
        byTransactionManager:
            "/departments/transaction-manager/:transactionManager",
    },
    serviceWindows: {
        enabled: "/service-windows/enabled",
        byId: "/service-windows/:id",
        byDepartment: "/service-windows/department/:departmentId",
    },
    tickets: {
        recent: "/tickets/recent",
        byId: "/tickets/:id",
        queueByDepartment: "/tickets/department/:departmentId/queue",
        activeByDepartment: "/tickets/department/:departmentId/active",
    },
    publicDisplay: {
        managers: "/landing/managers",
        managersAlt: "/public-display/managers",
        managersAlt2: "/display/managers",
        state: "/landing/public-display/:transactionManager",
        stateByQuery: "/landing/public-display",
        stateAlt: "/public-display/:transactionManager",
        stateAltByQuery: "/public-display",
        stateAlt2: "/display/:transactionManager",
        stateAlt2ByQuery: "/display",
    },
    users: {
        byId: "/users/:id",
        byStudentId: "/users/student/:studentId",
        staff: "/users/staff",
        participants: "/users/participants",
    },
} as const

export const route = Router()

route.post(ROUTE_PATHS.auth.register, AuthController.register)
route.post(ROUTE_PATHS.auth.login, AuthController.login)
route.post(ROUTE_PATHS.auth.forgotPassword, AuthController.forgotPassword)
route.post(ROUTE_PATHS.auth.resetPassword, AuthController.resetPassword)
route.get(ROUTE_PATHS.auth.me, requireAuth, AuthController.me)

route.get(ROUTE_PATHS.settings.current, SettingController.getCurrent)

route.get(
    ROUTE_PATHS.auditLogs.recent,
    requireAuth,
    requireRoles("ADMIN", "STAFF"),
    AuditLogController.listRecent
)
route.get(
    ROUTE_PATHS.auditLogs.byActor,
    requireAuth,
    requireRoles("ADMIN", "STAFF"),
    AuditLogController.getByActor
)

route.get(ROUTE_PATHS.departments.enabled, DepartmentController.listEnabled)
route.get(
    ROUTE_PATHS.departments.byTransactionManager,
    DepartmentController.listByTransactionManager
)
route.get(ROUTE_PATHS.departments.byId, DepartmentController.getById)

route.get(
    ROUTE_PATHS.serviceWindows.enabled,
    ServiceWindowController.listEnabled
)
route.get(
    ROUTE_PATHS.serviceWindows.byDepartment,
    ServiceWindowController.listByDepartment
)
route.get(ROUTE_PATHS.serviceWindows.byId, ServiceWindowController.getById)

route.get(ROUTE_PATHS.tickets.recent, TicketController.listRecent)
route.get(
    ROUTE_PATHS.tickets.queueByDepartment,
    TicketController.listQueueByDepartment
)
route.get(
    ROUTE_PATHS.tickets.activeByDepartment,
    TicketController.listActiveByDepartment
)
route.get(ROUTE_PATHS.tickets.byId, TicketController.getById)

route.get(
    ROUTE_PATHS.publicDisplay.managers,
    PublicDisplayController.listManagers
)
route.get(
    ROUTE_PATHS.publicDisplay.managersAlt,
    PublicDisplayController.listManagers
)
route.get(
    ROUTE_PATHS.publicDisplay.managersAlt2,
    PublicDisplayController.listManagers
)

route.get(
    ROUTE_PATHS.publicDisplay.state,
    PublicDisplayController.getState
)
route.get(
    ROUTE_PATHS.publicDisplay.stateByQuery,
    PublicDisplayController.getState
)
route.get(
    ROUTE_PATHS.publicDisplay.stateAlt,
    PublicDisplayController.getState
)
route.get(
    ROUTE_PATHS.publicDisplay.stateAltByQuery,
    PublicDisplayController.getState
)
route.get(
    ROUTE_PATHS.publicDisplay.stateAlt2,
    PublicDisplayController.getState
)
route.get(
    ROUTE_PATHS.publicDisplay.stateAlt2ByQuery,
    PublicDisplayController.getState
)

route.get(
    ROUTE_PATHS.users.staff,
    requireAuth,
    requireRoles("ADMIN", "STAFF"),
    UserController.listStaff
)
route.get(
    ROUTE_PATHS.users.participants,
    requireAuth,
    requireRoles("ADMIN", "STAFF"),
    UserController.listParticipants
)
route.get(
    ROUTE_PATHS.users.byStudentId,
    requireAuth,
    requireRoles("ADMIN", "STAFF"),
    UserController.getByStudentId
)
route.get(
    ROUTE_PATHS.users.byId,
    requireAuth,
    requireRoles("ADMIN", "STAFF"),
    UserController.getById
)

export default route