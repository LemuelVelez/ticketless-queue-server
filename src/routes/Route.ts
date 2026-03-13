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

function normalizeTransactionManager(value: unknown): string {
    return getString(value).toUpperCase()
}

function normalizeAudience(value: unknown): "INTERNAL" | "EXTERNAL" | "" {
    const raw = getString(value).toUpperCase()
    if (raw === "INTERNAL" || raw === "EXTERNAL") return raw
    return ""
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
    const out: string[] = []
    const seen = new Set<string>()

    for (const value of values) {
        const clean = getString(value)
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        out.push(clean)
    }

    return out
}

function buildTransactionPurposeId(manager: string, keyOrLabel: string): string {
    const normalizedManager = normalizeTransactionManager(manager) || "GENERAL"
    const normalizedKey = normalizeTransactionPurposeKey(keyOrLabel)
    if (!normalizedKey) return ""
    return `${normalizedManager}:${normalizedKey}`
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
        const transactionManager = normalizeTransactionManager(
            req.query.transactionManager
        )
        const includeDisabled = parseBoolean(req.query.includeDisabled, false)

        if (departmentId && !isValidObjectId(departmentId)) {
            res.status(400).json({
                message: "Invalid departmentId",
            })
            return
        }

        const departmentFilter: Record<string, unknown> = {}

        if (!includeDisabled) {
            departmentFilter.enabled = true
        }

        if (departmentId) {
            departmentFilter._id = new Types.ObjectId(departmentId)
        }

        if (transactionManager) {
            departmentFilter.transactionManager = transactionManager
        }

        const departments = await DepartmentModel.find(departmentFilter)
            .select("_id enabled name code transactionManager registrarTransactionGroups")
            .sort({ name: 1, code: 1, createdAt: -1 })
            .lean()

        const departmentIds = departments
            .map((department: any) => getString(department?._id))
            .filter(Boolean)

        const managerByDepartmentId = new Map<string, string>()
        for (const department of departments as Array<Record<string, unknown>>) {
            const id = getString(department._id)
            if (!id) continue
            managerByDepartmentId.set(
                id,
                normalizeTransactionManager(department.transactionManager)
            )
        }

        const unique = new Map<string, Record<string, unknown>>()
        let sortOrder = 1

        const upsertPurpose = (input: {
            manager: string
            key?: string
            label?: string
            purpose?: string
            scopes?: string[]
            departmentId?: string
            enabled?: boolean
        }) => {
            const manager = normalizeTransactionManager(input.manager) || "GENERAL"
            const label =
                getString(input.label) ||
                getString(input.purpose) ||
                getString(input.key)

            const key = getString(input.key) || label
            const purpose = getString(input.purpose) || label
            const departmentIdValue = getString(input.departmentId)
            const normalizedScopes = uniqueStrings(
                (input.scopes || []).map((scope) => normalizeAudience(scope))
            )

            const id = buildTransactionPurposeId(manager, key)
            const normalizedKey = normalizeTransactionPurposeKey(key)

            if (!id || !normalizedKey || !label) return

            const existing = unique.get(id)

            if (existing) {
                existing.label = getString(existing.label) || label
                existing.name = getString(existing.name) || label
                existing.purpose = getString(existing.purpose) || purpose
                existing.transactionPurpose =
                    getString(existing.transactionPurpose) || purpose

                existing.scopes = uniqueStrings([
                    ...((existing.scopes as string[]) || []),
                    ...normalizedScopes,
                ])

                existing.departmentIds = uniqueStrings([
                    ...((existing.departmentIds as string[]) || []),
                    departmentIdValue,
                ])

                existing.enabled =
                    Boolean(existing.enabled) || input.enabled !== false

                existing.sortOrder = Math.min(
                    Number(existing.sortOrder || sortOrder),
                    sortOrder
                )

                return
            }

            unique.set(id, {
                id,
                _id: id,
                key: normalizedKey,
                name: label,
                label,
                purpose,
                transactionPurpose: purpose,
                category: manager,
                transactionCategory: manager,
                scopes: normalizedScopes,
                departmentIds: departmentIdValue ? [departmentIdValue] : [],
                enabled: input.enabled !== false,
                sortOrder: sortOrder++,
            })
        }

        for (const department of departments as Array<Record<string, unknown>>) {
            const manager = normalizeTransactionManager(department.transactionManager)
            const currentDepartmentId = getString(department._id)
            const enabled = department.enabled !== false
            const registrarGroups = Array.isArray(
                department.registrarTransactionGroups
            )
                ? (department.registrarTransactionGroups as Array<Record<string, unknown>>)
                : []

            for (const group of registrarGroups) {
                const audience = normalizeAudience(group.audience)
                const items = Array.isArray(group.items) ? group.items : []

                for (const item of items) {
                    const label = getString(item)
                    if (!label) continue

                    upsertPurpose({
                        manager,
                        key: label,
                        label,
                        purpose: label,
                        scopes: audience ? [audience] : [],
                        departmentId: currentDepartmentId,
                        enabled,
                    })
                }
            }
        }

        const ticketFilter: Record<string, unknown> = {}

        if (departmentId) {
            ticketFilter.department = new Types.ObjectId(departmentId)
        } else if (departmentIds.length > 0) {
            ticketFilter.department = {
                $in: departmentIds.map((id) => new Types.ObjectId(id)),
            }
        } else if (transactionManager) {
            ticketFilter.transactionCategory = transactionManager
        }

        const tickets = await TicketModel.find(ticketFilter)
            .select(
                "department transactionCategory transactionKey transactionLabel purpose"
            )
            .sort({ transactionLabel: 1, purpose: 1, createdAt: -1 })
            .lean()

        for (const ticket of tickets as Array<Record<string, unknown>>) {
            const ticketDepartmentId = getString(ticket.department)
            const manager =
                normalizeTransactionManager(ticket.transactionCategory) ||
                managerByDepartmentId.get(ticketDepartmentId) ||
                transactionManager ||
                "GENERAL"

            const label =
                getString(ticket.transactionLabel) ||
                getString(ticket.purpose) ||
                getString(ticket.transactionKey)

            if (!label) continue

            const key = getString(ticket.transactionKey) || label
            const id = buildTransactionPurposeId(manager, key)
            if (!id || unique.has(id)) continue

            upsertPurpose({
                manager,
                key,
                label,
                purpose: getString(ticket.purpose) || label,
                scopes: ["INTERNAL", "EXTERNAL"],
                departmentId: ticketDepartmentId,
                enabled: true,
            })
        }

        const data = Array.from(unique.values()).sort((a, b) => {
            const aCategory = getString(a.category)
            const bCategory = getString(b.category)
            if (aCategory !== bCategory) return aCategory.localeCompare(bCategory)

            const aSort = Number(a.sortOrder || 1000)
            const bSort = Number(b.sortOrder || 1000)
            if (aSort !== bSort) return aSort - bSort

            return getString(a.label).localeCompare(getString(b.label))
        })

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