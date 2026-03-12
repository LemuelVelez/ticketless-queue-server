import { Types } from "mongoose"
import { TicketModel } from "../models/Model"
import { NameService } from "./NameService"
import { UserService } from "./UserService"

export type TicketView = {
    id: string
    departmentId?: string
    departmentName: string
    dateKey: string
    queueNumber: number
    studentId: string
    participantName: string
    participantType?: string
    phone?: string
    status: string
    holdAttempts: number
    windowId?: string
    windowName?: string
    windowNumber?: number
    transactionCategory?: string
    transactionKey?: string
    transactionLabel?: string
    purpose?: string
    waitingSince: Date
    calledAt?: Date
    servedAt?: Date
    outAt?: Date
    createdAt?: Date
    updatedAt?: Date
}

export class TicketService {
    static toView(ticket: any, participantNameMap?: Map<string, string>): TicketView {
        const studentId = String(ticket?.studentId ?? "").trim()
        const participantName =
            String(ticket?.participantLabel ?? "").trim() ||
            participantNameMap?.get(studentId) ||
            studentId ||
            "Unknown participant"

        return {
            id: NameService.toIdString(ticket?._id) ?? "",
            departmentId: NameService.toIdString(ticket?.department?._id ?? ticket?.department),
            departmentName: ticket?.department
                ? NameService.getDepartmentName(ticket.department)
                : "Unknown department",
            dateKey: String(ticket?.dateKey ?? "").trim(),
            queueNumber: Number(ticket?.queueNumber ?? 0),
            studentId,
            participantName,
            participantType: ticket?.participantType
                ? String(ticket.participantType).trim()
                : undefined,
            phone: String(ticket?.phone ?? "").trim() || undefined,
            status: String(ticket?.status ?? "").trim(),
            holdAttempts: Number(ticket?.holdAttempts ?? 0),
            windowId: NameService.toIdString(ticket?.window?._id ?? ticket?.window),
            windowName: ticket?.window ? NameService.getWindowName(ticket.window) : undefined,
            windowNumber:
                typeof ticket?.windowNumber === "number" ? ticket.windowNumber : undefined,
            transactionCategory: ticket?.transactionCategory
                ? String(ticket.transactionCategory).trim()
                : undefined,
            transactionKey: ticket?.transactionKey
                ? String(ticket.transactionKey).trim()
                : undefined,
            transactionLabel: ticket?.transactionLabel
                ? String(ticket.transactionLabel).trim()
                : undefined,
            purpose: ticket?.purpose ? String(ticket.purpose).trim() : undefined,
            waitingSince: ticket?.waitingSince,
            calledAt: ticket?.calledAt,
            servedAt: ticket?.servedAt,
            outAt: ticket?.outAt,
            createdAt: ticket?.createdAt,
            updatedAt: ticket?.updatedAt,
        }
    }

    static async getById(ticketId: string | Types.ObjectId): Promise<TicketView | null> {
        const ticket = await TicketModel.findById(ticketId)
            .populate("department", "name code")
            .populate("window", "name number")
            .exec()

        if (!ticket) return null

        const participantNameMap = await UserService.getParticipantNameMapByStudentIds([
            String(ticket.studentId ?? ""),
        ])

        return TicketService.toView(ticket, participantNameMap)
    }

    static async listQueueByDepartment(
        departmentId: string | Types.ObjectId,
        dateKey: string
    ): Promise<TicketView[]> {
        const tickets = await TicketModel.find({
            department: departmentId,
            dateKey: String(dateKey ?? "").trim(),
        })
            .populate("department", "name code")
            .populate("window", "name number")
            .sort({ queueNumber: 1, createdAt: 1 })
            .exec()

        const participantNameMap = await UserService.getParticipantNameMapByStudentIds(
            tickets.map((ticket) => String(ticket.studentId ?? ""))
        )

        return tickets.map((ticket) => TicketService.toView(ticket, participantNameMap))
    }

    static async listActiveByDepartment(
        departmentId: string | Types.ObjectId,
        dateKey: string
    ): Promise<TicketView[]> {
        const tickets = await TicketModel.find({
            department: departmentId,
            dateKey: String(dateKey ?? "").trim(),
            status: { $in: ["WAITING", "CALLED", "HOLD"] },
        })
            .populate("department", "name code")
            .populate("window", "name number")
            .sort({ queueNumber: 1, createdAt: 1 })
            .exec()

        const participantNameMap = await UserService.getParticipantNameMapByStudentIds(
            tickets.map((ticket) => String(ticket.studentId ?? ""))
        )

        return tickets.map((ticket) => TicketService.toView(ticket, participantNameMap))
    }

    static async listRecent(limit = 50): Promise<TicketView[]> {
        const tickets = await TicketModel.find({})
            .populate("department", "name code")
            .populate("window", "name number")
            .sort({ createdAt: -1 })
            .limit(limit)
            .exec()

        const participantNameMap = await UserService.getParticipantNameMapByStudentIds(
            tickets.map((ticket) => String(ticket.studentId ?? ""))
        )

        return tickets.map((ticket) => TicketService.toView(ticket, participantNameMap))
    }
}