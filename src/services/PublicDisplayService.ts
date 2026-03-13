import {
    DepartmentModel,
    ServiceWindowModel,
    SettingModel,
    TicketModel,
} from "../models/Model"
import { NameService } from "./NameService"
import { UserService } from "./UserService"

export type PublicDisplayManager = string

export type PublicDisplayDepartment = {
    id?: string
    name?: string | null
    code?: string | null
}

export type PublicDisplayTicket = {
    id: string
    queueNumber?: string | number | null
    participant?: Record<string, unknown> | null
    participantDisplay?: string | null
    participantFullName?: string | null
    participantLabel?: string | null
    studentId?: string | null
    department?: PublicDisplayDepartment | null
    windowNumber?: string | number | null
    waitingSince?: Date
    calledAt?: Date
    createdAt?: Date
    updatedAt?: Date
    status?: string
    transactionLabel?: string
    purpose?: string
    phone?: string
}

export type PublicDisplayWindow = {
    id: string
    name?: string | null
    number?: string | number | null
    departments: PublicDisplayDepartment[]
    nowServing?: PublicDisplayTicket | null
}

export type PublicDisplayAnnouncement = {
    id: string
    queueNumber?: string | number | null
    windowNumber?: string | number | null
    departmentName?: string | null
    participantName?: string | null
    createdAt?: string | null
}

export type PublicDisplayState = {
    dateKey: string
    serverTime: string
    windows: PublicDisplayWindow[]
    upNext: PublicDisplayTicket[]
    announcements: PublicDisplayAnnouncement[]
}

function toIdString(value: any): string | undefined {
    return NameService.toIdString(value?._id ?? value) ?? undefined
}

function cleanText(value: unknown): string | undefined {
    const text = String(value ?? "").trim()
    return text || undefined
}

function uniqueStrings(values: string[]) {
    return Array.from(new Set(values.filter(Boolean)))
}

function parseSince(value: unknown): Date | null {
    const raw = String(value ?? "").trim()
    if (!raw) return null

    const date = new Date(raw)
    if (Number.isNaN(date.getTime())) return null

    return date
}

function buildDepartmentView(department: any): PublicDisplayDepartment | null {
    if (!department) return null

    const id = toIdString(department)
    const name = cleanText(
        department?.name ??
            department?.departmentName ??
            department?.label
    )
    const code = cleanText(department?.code)

    if (!id && !name && !code) return null

    return {
        id,
        name: name ?? null,
        code: code ?? null,
    }
}

function getDepartmentsForWindow(window: any): PublicDisplayDepartment[] {
    const items = [
        window?.department,
        ...(Array.isArray(window?.departmentIds) ? window.departmentIds : []),
    ]

    const result: PublicDisplayDepartment[] = []
    const seen = new Set<string>()

    for (const item of items) {
        const view = buildDepartmentView(item)
        if (!view) continue

        const key = `${view.id ?? ""}:${view.name ?? ""}:${view.code ?? ""}`
        if (seen.has(key)) continue

        seen.add(key)
        result.push(view)
    }

    return result
}

function getParticipantName(ticket: any, participantNameMap?: Map<string, string>): string {
    const studentId = String(ticket?.studentId ?? "").trim()

    return (
        String(ticket?.participantLabel ?? "").trim() ||
        participantNameMap?.get(studentId) ||
        studentId ||
        "Unknown participant"
    )
}

function buildTicketView(
    ticket: any,
    participantNameMap?: Map<string, string>
): PublicDisplayTicket {
    const participantName = getParticipantName(ticket, participantNameMap)
    const department = buildDepartmentView(ticket?.department)

    return {
        id: toIdString(ticket) ?? "",
        queueNumber:
            typeof ticket?.queueNumber === "number"
                ? ticket.queueNumber
                : cleanText(ticket?.queueNumber) ?? null,
        participant: {
            fullName: participantName,
            name: participantName,
        },
        participantDisplay: participantName,
        participantFullName: participantName,
        participantLabel: participantName,
        studentId: cleanText(ticket?.studentId) ?? null,
        department,
        windowNumber:
            typeof ticket?.windowNumber === "number"
                ? ticket.windowNumber
                : cleanText(ticket?.windowNumber) ?? null,
        waitingSince: ticket?.waitingSince,
        calledAt: ticket?.calledAt,
        createdAt: ticket?.createdAt,
        updatedAt: ticket?.updatedAt,
        status: cleanText(ticket?.status),
        transactionLabel: cleanText(ticket?.transactionLabel),
        purpose: cleanText(ticket?.purpose),
        phone: cleanText(ticket?.phone),
    }
}

function buildAnnouncementView(
    ticket: any,
    participantNameMap?: Map<string, string>
): PublicDisplayAnnouncement {
    const participantName = getParticipantName(ticket, participantNameMap)

    return {
        id: `${toIdString(ticket) ?? ""}:${
            ticket?.calledAt ? new Date(ticket.calledAt).toISOString() : ""
        }`,
        queueNumber:
            typeof ticket?.queueNumber === "number"
                ? ticket.queueNumber
                : cleanText(ticket?.queueNumber) ?? null,
        windowNumber:
            typeof ticket?.windowNumber === "number"
                ? ticket.windowNumber
                : cleanText(ticket?.windowNumber) ?? null,
        departmentName:
            cleanText(
                ticket?.department?.name ??
                    ticket?.department?.departmentName
            ) ?? null,
        participantName,
        createdAt: ticket?.calledAt ? new Date(ticket.calledAt).toISOString() : null,
    }
}

export class PublicDisplayService {
    static async listManagers(): Promise<PublicDisplayManager[]> {
        const departments = await DepartmentModel.find({ enabled: true })
            .select("transactionManager")
            .sort({ transactionManager: 1 })
            .lean()
            .exec()

        return uniqueStrings(
            departments
                .map((department) =>
                    String(department?.transactionManager ?? "")
                        .trim()
                        .toUpperCase()
                )
                .filter(Boolean)
        )
    }

    static async getState(
        transactionManager: string,
        dateKey: string,
        since?: string
    ): Promise<PublicDisplayState> {
        const normalizedManager = String(transactionManager ?? "").trim().toUpperCase()
        const sinceDate = parseSince(since)

        const departments = await DepartmentModel.find({
            enabled: true,
            transactionManager: normalizedManager,
        })
            .select("name code transactionManager")
            .sort({ name: 1 })
            .exec()

        if (!departments.length) {
            return {
                dateKey,
                serverTime: new Date().toISOString(),
                windows: [],
                upNext: [],
                announcements: [],
            }
        }

        const departmentIds = departments.map((department) => department._id)

        const windows = await ServiceWindowModel.find({
            enabled: true,
            $or: [
                { department: { $in: departmentIds } },
                { departmentIds: { $in: departmentIds } },
            ],
        })
            .populate("department", "name code")
            .populate("departmentIds", "name code")
            .sort({ number: 1, name: 1 })
            .exec()

        const windowIds = windows.map((window) => window._id)

        const settings = await SettingModel.findOne({})
            .sort({ updatedAt: -1, createdAt: -1 })
            .select("upNextCount")
            .lean()
            .exec()

        const upNextCount = Math.max(Number(settings?.upNextCount ?? 5), 1)

        const [activeTickets, waitingTickets] = await Promise.all([
            windowIds.length
                ? TicketModel.find({
                      dateKey,
                      department: { $in: departmentIds },
                      window: { $in: windowIds },
                      status: { $in: ["CALLED", "HOLD"] },
                  })
                      .populate("department", "name code")
                      .populate("window", "name number")
                      .sort({ calledAt: -1, updatedAt: -1, queueNumber: 1 })
                      .exec()
                : Promise.resolve([]),
            TicketModel.find({
                dateKey,
                department: { $in: departmentIds },
                status: "WAITING",
            })
                .populate("department", "name code")
                .populate("window", "name number")
                .sort({ waitingSince: 1, queueNumber: 1, createdAt: 1 })
                .limit(upNextCount)
                .exec(),
        ])

        let announcementQuery = TicketModel.find({
            dateKey,
            department: { $in: departmentIds },
            calledAt: sinceDate ? { $gt: sinceDate } : { $ne: null },
        })
            .populate("department", "name code")
            .populate("window", "name number")

        if (sinceDate) {
            announcementQuery = announcementQuery.sort({ calledAt: 1, _id: 1 }).limit(50)
        } else {
            announcementQuery = announcementQuery.sort({ calledAt: -1, _id: -1 }).limit(20)
        }

        let announcementTickets = await announcementQuery.exec()

        if (!sinceDate) {
            announcementTickets = announcementTickets.reverse()
        }

        const participantStudentIds = uniqueStrings(
            [...activeTickets, ...waitingTickets, ...announcementTickets]
                .map((ticket: any) => String(ticket?.studentId ?? "").trim())
                .filter(Boolean)
        )

        const participantNameMap =
            await UserService.getParticipantNameMapByStudentIds(participantStudentIds)

        const activeTicketByWindowId = new Map<string, any>()
        for (const ticket of activeTickets) {
            const key = toIdString(ticket?.window)
            if (!key) continue
            if (!activeTicketByWindowId.has(key)) {
                activeTicketByWindowId.set(key, ticket)
            }
        }

        const windowsView: PublicDisplayWindow[] = windows.map((window) => {
            const windowId = toIdString(window) ?? ""
            const nowServingTicket = activeTicketByWindowId.get(windowId)

            return {
                id: windowId,
                name: cleanText(window?.name) ?? `Window ${Number(window?.number ?? 0)}`,
                number:
                    typeof window?.number === "number"
                        ? window.number
                        : cleanText(window?.number) ?? null,
                departments: getDepartmentsForWindow(window),
                nowServing: nowServingTicket
                    ? buildTicketView(nowServingTicket, participantNameMap)
                    : null,
            }
        })

        const upNextView = waitingTickets.map((ticket) =>
            buildTicketView(ticket, participantNameMap)
        )

        const announcementsView = announcementTickets.map((ticket) =>
            buildAnnouncementView(ticket, participantNameMap)
        )

        return {
            dateKey,
            serverTime: new Date().toISOString(),
            windows: windowsView,
            upNext: upNextView,
            announcements: announcementsView,
        }
    }
}