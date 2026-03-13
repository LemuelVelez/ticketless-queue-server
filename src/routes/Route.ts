import { Router } from "express"
import { Types } from "mongoose"
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
    DepartmentModel,
    ServiceWindowModel,
    TicketModel,
} from "../models/Model"
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
        list: "/departments",
        enabled: "/departments/enabled",
        byId: "/departments/:id",
        byTransactionManager:
            "/departments/transaction-manager/:transactionManager",
    },
    serviceWindows: {
        list: "/service-windows",
        enabled: "/service-windows/enabled",
        byId: "/service-windows/:id",
        byDepartment: "/service-windows/department/:departmentId",
    },
    transactionPurposes: {
        list: "/transaction-purposes",
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

function getString(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] ?? "").trim()
    return String(value ?? "").trim()
}

function parseBoolean(value: unknown, fallback = false): boolean {
    const raw = getString(value).toLowerCase()
    if (!raw) return fallback
    if (["1", "true", "yes", "y", "on"].includes(raw)) return true
    if (["0", "false", "no", "n", "off"].includes(raw)) return false
    return fallback
}

function isValidObjectId(value: string): boolean {
    return Types.ObjectId.isValid(String(value ?? "").trim())
}

function normalizeTransactionPurposeKey(value: string): string {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
}

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
route.get(ROUTE_PATHS.departments.list, async (req, res, next) => {
    try {
        const includeDisabled = parseBoolean(req.query.includeDisabled, false)
        const transactionManager = getString(req.query.transactionManager).toUpperCase()

        const filter: Record<string, unknown> = {}

        if (!includeDisabled) {
            filter.enabled = true
        }

        if (transactionManager) {
            filter.transactionManager = transactionManager
        }

        const departments = await DepartmentModel.find(filter)
            .sort({ name: 1, code: 1, createdAt: -1 })
            .lean()

        res.status(200).json({
            data: departments,
            count: departments.length,
        })
    } catch (error) {
        next(error)
    }
})
route.get(ROUTE_PATHS.departments.byId, DepartmentController.getById)

route.get(
    ROUTE_PATHS.serviceWindows.enabled,
    ServiceWindowController.listEnabled
)
route.get(
    ROUTE_PATHS.serviceWindows.byDepartment,
    ServiceWindowController.listByDepartment
)
route.get(ROUTE_PATHS.serviceWindows.list, async (req, res, next) => {
    try {
        const includeDisabled = parseBoolean(req.query.includeDisabled, false)
        const departmentId = getString(req.query.departmentId)

        const filter: Record<string, unknown> = {}

        if (!includeDisabled) {
            filter.enabled = true
        }

        if (departmentId) {
            if (!isValidObjectId(departmentId)) {
                res.status(400).json({
                    message: "Invalid departmentId",
                })
                return
            }

            const departmentObjectId = new Types.ObjectId(departmentId)

            filter.$or = [
                { department: departmentObjectId },
                { departmentIds: departmentObjectId },
            ]
        }

        const serviceWindows = await ServiceWindowModel.find(filter)
            .sort({ number: 1, name: 1, createdAt: -1 })
            .populate("department")
            .populate("departmentIds")
            .lean()

        res.status(200).json({
            data: serviceWindows,
            count: serviceWindows.length,
        })
    } catch (error) {
        next(error)
    }
})
route.get(ROUTE_PATHS.serviceWindows.byId, ServiceWindowController.getById)

route.get(ROUTE_PATHS.transactionPurposes.list, async (req, res, next) => {
    try {
        const departmentId = getString(req.query.departmentId)
        const transactionManager = getString(req.query.transactionManager).toUpperCase()

        const ticketFilter: Record<string, unknown> = {}

        if (departmentId) {
            if (!isValidObjectId(departmentId)) {
                res.status(400).json({
                    message: "Invalid departmentId",
                })
                return
            }

            ticketFilter.department = new Types.ObjectId(departmentId)
        } else if (transactionManager) {
            const departments = await DepartmentModel.find({
                transactionManager,
            })
                .select("_id")
                .lean()

            const departmentIds = departments
                .map((item: any) => item?._id)
                .filter(Boolean)

            if (!departmentIds.length) {
                res.status(200).json({
                    data: [],
                    count: 0,
                })
                return
            }

            ticketFilter.department = { $in: departmentIds }
        }

        const tickets = await TicketModel.find(ticketFilter)
            .select("transactionCategory transactionKey transactionLabel purpose")
            .sort({ transactionLabel: 1, purpose: 1, createdAt: -1 })
            .lean()

        const unique = new Map<string, Record<string, unknown>>()

        for (const ticket of tickets as Array<Record<string, unknown>>) {
            const transactionLabel = getString(ticket.transactionLabel)
            const purpose = getString(ticket.purpose)
            const transactionKey = getString(ticket.transactionKey)
            const transactionCategory = getString(ticket.transactionCategory)

            const label = transactionLabel || purpose || transactionKey
            if (!label) continue

            const key =
                transactionKey || normalizeTransactionPurposeKey(label)

            if (!key || unique.has(key)) continue

            unique.set(key, {
                id: key,
                key,
                name: label,
                label,
                purpose: purpose || label,
                transactionPurpose: purpose || label,
                category: transactionCategory || null,
                transactionCategory: transactionCategory || null,
                enabled: true,
            })
        }

        const data = Array.from(unique.values()).sort((a, b) =>
            String(a.label ?? "").localeCompare(String(b.label ?? ""))
        )

        res.status(200).json({
            data,
            count: data.length,
        })
    } catch (error) {
        next(error)
    }
})

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