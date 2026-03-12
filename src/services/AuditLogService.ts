import { Types } from "mongoose"
import {
    AuditLogModel,
    DepartmentModel,
    ServiceWindowModel,
    TicketModel,
    UserModel,
} from "../models/Model"
import { NameService } from "./NameService"

export type AuditLogView = {
    id: string
    actorName: string
    actorRole?: string
    action: string
    entityType?: string
    entityId?: string
    entityDisplay?: string
    meta?: Record<string, unknown>
    createdAt: Date
}

export class AuditLogService {
    static async resolveEntityDisplayMap(logs: any[]): Promise<Map<string, string>> {
        const entityBuckets = {
            USER: new Set<string>(),
            DEPARTMENT: new Set<string>(),
            SERVICE_WINDOW: new Set<string>(),
            TICKET: new Set<string>(),
        }

        for (const log of logs) {
            const entityType = String(log?.entityType ?? "").trim().toUpperCase()
            const entityId = NameService.toIdString(log?.entityId)

            if (!entityId) continue

            if (entityType === "USER") entityBuckets.USER.add(entityId)
            if (entityType === "DEPARTMENT") entityBuckets.DEPARTMENT.add(entityId)
            if (entityType === "SERVICEWINDOW" || entityType === "SERVICE_WINDOW") {
                entityBuckets.SERVICE_WINDOW.add(entityId)
            }
            if (entityType === "TICKET") entityBuckets.TICKET.add(entityId)
        }

        const map = new Map<string, string>()

        if (entityBuckets.USER.size) {
            const users = await UserModel.find({ _id: { $in: Array.from(entityBuckets.USER) } })
                .select("name firstName middleName lastName studentId tcNumber email")
                .exec()

            for (const user of users) {
                map.set(`USER:${String(user._id)}`, NameService.getPersonName(user))
            }
        }

        if (entityBuckets.DEPARTMENT.size) {
            const departments = await DepartmentModel.find({
                _id: { $in: Array.from(entityBuckets.DEPARTMENT) },
            })
                .select("name code")
                .exec()

            for (const department of departments) {
                map.set(
                    `DEPARTMENT:${String(department._id)}`,
                    NameService.getDepartmentName(department)
                )
            }
        }

        if (entityBuckets.SERVICE_WINDOW.size) {
            const windows = await ServiceWindowModel.find({
                _id: { $in: Array.from(entityBuckets.SERVICE_WINDOW) },
            })
                .select("name number")
                .exec()

            for (const window of windows) {
                map.set(
                    `SERVICE_WINDOW:${String(window._id)}`,
                    NameService.getWindowName(window)
                )
            }
        }

        if (entityBuckets.TICKET.size) {
            const tickets = await TicketModel.find({
                _id: { $in: Array.from(entityBuckets.TICKET) },
            })
                .populate("department", "name code")
                .select("participantLabel studentId queueNumber department")
                .exec()

            const studentIds = tickets.map((ticket) => String(ticket.studentId ?? ""))
            const users = await UserModel.find({
                $or: [{ studentId: { $in: studentIds } }, { tcNumber: { $in: studentIds } }],
            })
                .select("name firstName middleName lastName studentId tcNumber")
                .exec()

            const participantNameMap = new Map<string, string>()
            for (const user of users) {
                const displayName = NameService.getPersonName(user)
                if (user.studentId) participantNameMap.set(String(user.studentId), displayName)
                if (user.tcNumber) participantNameMap.set(String(user.tcNumber), displayName)
            }

            for (const ticket of tickets) {
                const participantName =
                    String(ticket.participantLabel ?? "").trim() ||
                    participantNameMap.get(String(ticket.studentId ?? "")) ||
                    String(ticket.studentId ?? "").trim() ||
                    "Unknown participant"

                const departmentName = ticket.department
                    ? NameService.getDepartmentName(ticket.department)
                    : "Unknown department"

                map.set(
                    `TICKET:${String(ticket._id)}`,
                    `${departmentName} #${ticket.queueNumber} - ${participantName}`
                )
            }
        }

        return map
    }

    static async toView(log: any, entityDisplayMap: Map<string, string>): Promise<AuditLogView> {
        const entityTypeRaw = String(log?.entityType ?? "").trim()
        const entityType = entityTypeRaw.toUpperCase()
        const entityId = NameService.toIdString(log?.entityId)

        const normalizedEntityKey =
            entityType === "SERVICEWINDOW"
                ? `SERVICE_WINDOW:${entityId}`
                : `${entityType}:${entityId}`

        return {
            id: NameService.toIdString(log?._id) ?? "",
            actorName: log?.actor ? NameService.getPersonName(log.actor) : "System",
            actorRole: log?.actorRole ? String(log.actorRole).trim() : undefined,
            action: String(log?.action ?? "").trim(),
            entityType: entityTypeRaw || undefined,
            entityId,
            entityDisplay: entityId ? entityDisplayMap.get(normalizedEntityKey) ?? entityId : undefined,
            meta: log?.meta ?? undefined,
            createdAt: log?.createdAt,
        }
    }

    static async listRecent(limit = 50): Promise<AuditLogView[]> {
        const logs = await AuditLogModel.find({})
            .populate("actor", "name firstName middleName lastName studentId tcNumber email")
            .sort({ createdAt: -1 })
            .limit(limit)
            .exec()

        const entityDisplayMap = await AuditLogService.resolveEntityDisplayMap(logs)

        return Promise.all(logs.map((log) => AuditLogService.toView(log, entityDisplayMap)))
    }

    static async getByActor(
        actorId: string | Types.ObjectId,
        limit = 50
    ): Promise<AuditLogView[]> {
        const logs = await AuditLogModel.find({ actor: actorId })
            .populate("actor", "name firstName middleName lastName studentId tcNumber email")
            .sort({ createdAt: -1 })
            .limit(limit)
            .exec()

        const entityDisplayMap = await AuditLogService.resolveEntityDisplayMap(logs)

        return Promise.all(logs.map((log) => AuditLogService.toView(log, entityDisplayMap)))
    }
}