import { Router } from "express"
import {
    AuditLogController,
    DepartmentController,
    ServiceWindowController,
    SettingController,
    TicketController,
    UserController,
} from "../controllers"

export const ROUTE_PATHS = {
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
    users: {
        byId: "/users/:id",
        byStudentId: "/users/student/:studentId",
        staff: "/users/staff",
        participants: "/users/participants",
    },
} as const

export const route = Router()

route.get(ROUTE_PATHS.settings.current, SettingController.getCurrent)

route.get(ROUTE_PATHS.auditLogs.recent, AuditLogController.listRecent)
route.get(ROUTE_PATHS.auditLogs.byActor, AuditLogController.getByActor)

route.get(ROUTE_PATHS.departments.enabled, DepartmentController.listEnabled)
route.get(ROUTE_PATHS.departments.byId, DepartmentController.getById)
route.get(
    ROUTE_PATHS.departments.byTransactionManager,
    DepartmentController.listByTransactionManager
)

route.get(
    ROUTE_PATHS.serviceWindows.enabled,
    ServiceWindowController.listEnabled
)
route.get(ROUTE_PATHS.serviceWindows.byId, ServiceWindowController.getById)
route.get(
    ROUTE_PATHS.serviceWindows.byDepartment,
    ServiceWindowController.listByDepartment
)

route.get(ROUTE_PATHS.tickets.recent, TicketController.listRecent)
route.get(ROUTE_PATHS.tickets.byId, TicketController.getById)
route.get(
    ROUTE_PATHS.tickets.queueByDepartment,
    TicketController.listQueueByDepartment
)
route.get(
    ROUTE_PATHS.tickets.activeByDepartment,
    TicketController.listActiveByDepartment
)

route.get(ROUTE_PATHS.users.byId, UserController.getById)
route.get(ROUTE_PATHS.users.byStudentId, UserController.getByStudentId)
route.get(ROUTE_PATHS.users.staff, UserController.listStaff)
route.get(ROUTE_PATHS.users.participants, UserController.listParticipants)

export default route