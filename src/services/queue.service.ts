import mongoose, { Schema, Types } from "mongoose"

import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel } from "../models/Department"
import { QueueCounterModel } from "../models/QueueCounter"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { TicketModel, type TicketStatus } from "../models/Ticket"
import { UserModel } from "../models/User"

import {
    buildAccountName,
    verifyParticipantSession,
    type ParticipantDoc,
    type ParticipantType,
} from "./participantAuth.service"
import { getTransactionLabelMap, validateTransactionsForParticipant } from "./registrarTransactions.service"

type TicketTransactionSelectionDoc = {
    ticket: Types.ObjectId
    participant: Types.ObjectId
    participantType: ParticipantType
    transactionKeys: string[]
    transactionLabels: string[]
    createdAt: Date
    updatedAt: Date
}

const TicketTransactionSelectionSchema = new Schema<TicketTransactionSelectionDoc>(
    {
        ticket: { type: Schema.Types.ObjectId, ref: "Ticket", required: true, unique: true, index: true },
        participant: { type: Schema.Types.ObjectId, ref: "QueueParticipant", required: true, index: true },
        participantType: { type: String, enum: ["STUDENT", "ALUMNI_VISITOR"], required: true },
        transactionKeys: [{ type: String, required: true }],
        transactionLabels: [{ type: String, required: true }],
    },
    { timestamps: true }
)

export const TicketTransactionSelectionModel =
    (mongoose.models.TicketTransactionSelection as mongoose.Model<TicketTransactionSelectionDoc>) ||
    mongoose.model<TicketTransactionSelectionDoc>("TicketTransactionSelection", TicketTransactionSelectionSchema)

export type DepartmentWindowAssignments = Record<number, string[]>

const DEFAULT_DEPARTMENT_WINDOW_ASSIGNMENTS: DepartmentWindowAssignments = {
    // Example from requirement:
    // CCS student can be routed to the window handling CCS, BEED, CAF.
    1: ["CCS", "BEED", "CAF"],
}

export function getDepartmentWindowAssignments(): DepartmentWindowAssignments {
    const raw = process.env.DEPARTMENT_WINDOW_ASSIGNMENTS_JSON
    if (!raw) return DEFAULT_DEPARTMENT_WINDOW_ASSIGNMENTS

    try {
        const parsed = JSON.parse(raw) as Record<string, string[]>
        const normalized: DepartmentWindowAssignments = {}

        for (const [windowNoStr, departmentCodes] of Object.entries(parsed)) {
            const windowNo = Number(windowNoStr)
            if (!Number.isFinite(windowNo) || windowNo <= 0) continue
            normalized[windowNo] = Array.isArray(departmentCodes)
                ? departmentCodes.map((code) => String(code).trim().toUpperCase()).filter(Boolean)
                : []
        }

        return Object.keys(normalized).length ? normalized : DEFAULT_DEPARTMENT_WINDOW_ASSIGNMENTS
    } catch {
        return DEFAULT_DEPARTMENT_WINDOW_ASSIGNMENTS
    }
}

export function getDateKeyManila(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date)

    const year = parts.find((p) => p.type === "year")?.value ?? "0000"
    const month = parts.find((p) => p.type === "month")?.value ?? "00"
    const day = parts.find((p) => p.type === "day")?.value ?? "00"

    return `${year}-${month}-${day}`
}

function identifierOfParticipant(participant: mongoose.HydratedDocument<ParticipantDoc>) {
    return participant.tcNumber || participant.mobileNumber
}

function normalizeKey(input?: string) {
    return (input || "").trim().toUpperCase()
}

async function resolveDepartmentGroupForRouting(departmentId: Types.ObjectId) {
    const department = await DepartmentModel.findById(departmentId)
    if (!department || !department.enabled) {
        throw new Error("Department is invalid or disabled.")
    }

    const assignments = getDepartmentWindowAssignments()
    const deptKey = normalizeKey(department.code || department.name)

    const matched = Object.entries(assignments).find(([, deptCodes]) =>
        deptCodes.some((code) => normalizeKey(code) === deptKey)
    )

    if (!matched) {
        return {
            targetWindowNumber: undefined as number | undefined,
            handledDepartmentIds: [department._id],
        }
    }

    const [windowNoStr, departmentCodes] = matched
    const targetWindowNumber = Number(windowNoStr)
    const normalizedCodes = new Set(departmentCodes.map((c) => normalizeKey(c)))

    const allEnabledDepts = await DepartmentModel.find({ enabled: true }).select("_id code name")
    const handledDepartmentIds = allEnabledDepts
        .filter((d) => normalizedCodes.has(normalizeKey(d.code || d.name)))
        .map((d) => d._id)

    if (!handledDepartmentIds.length) {
        handledDepartmentIds.push(department._id)
    }

    return {
        targetWindowNumber,
        handledDepartmentIds,
    }
}

async function resolveWindowAndStaff(departmentId: Types.ObjectId) {
    const group = await resolveDepartmentGroupForRouting(departmentId)

    let windowDoc =
        group.targetWindowNumber != null
            ? await ServiceWindowModel.findOne({
                enabled: true,
                number: group.targetWindowNumber,
                department: { $in: group.handledDepartmentIds },
            }).sort({ updatedAt: -1 })
            : null

    if (!windowDoc) {
        windowDoc = await ServiceWindowModel.findOne({
            enabled: true,
            department: departmentId,
        }).sort({ number: 1, updatedAt: -1 })
    }

    const handledDepartmentIds =
        windowDoc && group.handledDepartmentIds.length
            ? group.handledDepartmentIds
            : [new Types.ObjectId(departmentId)]

    const staffQuery: Record<string, unknown> = {
        role: "STAFF",
        active: true,
        $or: [{ assignedDepartment: { $in: handledDepartmentIds } }],
    }

    if (windowDoc) {
        ; (staffQuery.$or as Array<Record<string, unknown>>).unshift({ assignedWindow: windowDoc._id })
    }

    const staff = await UserModel.findOne(staffQuery).sort({ updatedAt: -1, name: 1 })

    return {
        window: windowDoc || undefined,
        staff: staff || undefined,
        handledDepartmentIds,
    }
}

async function getNextQueueNumber(departmentId: Types.ObjectId, dateKey: string) {
    const counter = await QueueCounterModel.findOneAndUpdate(
        { department: departmentId, dateKey },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    )

    return counter.seq
}

const ACTIVE_TICKET_STATUSES: TicketStatus[] = ["WAITING", "CALLED", "HOLD"]

export type JoinQueueInput = {
    sessionToken: string
    transactionKeys: string[]
    presentDirectlyToDisplayMonitor?: boolean

    // Optional user-editable overrides from join page.
    // Department override also updates participant profile for next sessions.
    departmentId?: string
    studentId?: string
    phone?: string
}

export type JoinQueueResult = {
    ticketId: string
    queueNumber: number
    dateKey: string
    status: TicketStatus
    windowNumber?: number
    staffAssigned?: string
    accountName: string
    nameOfPersonInCharge?: string
    canPresentDirectlyToDisplayMonitor: boolean
    voiceAnnouncement?: string
}

async function resolveJoinDepartment(
    participant: mongoose.HydratedDocument<ParticipantDoc>,
    departmentIdInput?: string
): Promise<Types.ObjectId> {
    const raw = String(departmentIdInput || "").trim()
    if (!raw) return participant.department as Types.ObjectId

    if (!Types.ObjectId.isValid(raw)) {
        throw new Error("Invalid department.")
    }

    const requested = await DepartmentModel.findById(raw)
    if (!requested || !requested.enabled) {
        throw new Error("Department is invalid or disabled.")
    }

    const current = participant.department as Types.ObjectId
    if (!current.equals(requested._id)) {
        participant.department = requested._id
        await participant.save()
    }

    return requested._id
}

export async function joinQueue(input: JoinQueueInput): Promise<JoinQueueResult> {
    const sessionState = await verifyParticipantSession(input.sessionToken)
    if (!sessionState) {
        throw new Error("Please login first before joining the queue.")
    }

    const { participant } = sessionState
    const accountName = buildAccountName(participant)
    const dateKey = getDateKeyManila()

    const settings = await SettingModel.findOne({})
    const blockDuplicate = settings?.disallowDuplicateActiveTickets ?? true

    const validation = validateTransactionsForParticipant(participant.type, input.transactionKeys || [])
    if (!input.transactionKeys?.length) {
        throw new Error("Please select at least one transaction.")
    }
    if (!validation.isValid) {
        throw new Error(`Invalid transaction selection: ${validation.invalidKeys.join(", ")}`)
    }

    const selectedDepartmentId = await resolveJoinDepartment(participant, input.departmentId)
    const providedStudentId = String(input.studentId || "").trim()
    const providedPhone = String(input.phone || "").trim()

    const studentIdentifier = providedStudentId || identifierOfParticipant(participant)
    if (!studentIdentifier) {
        throw new Error("Student ID / identifier is required.")
    }

    const phoneNumber = providedPhone || participant.mobileNumber || undefined

    if (blockDuplicate) {
        const duplicate = await TicketModel.findOne({
            department: selectedDepartmentId,
            dateKey,
            studentId: studentIdentifier,
            status: { $in: ACTIVE_TICKET_STATUSES },
        })

        if (duplicate) {
            throw new Error("You already have an active queue ticket.")
        }
    }

    const queueNumber = await getNextQueueNumber(selectedDepartmentId, dateKey)
    const routing = await resolveWindowAndStaff(selectedDepartmentId)

    const ticket = await TicketModel.create({
        department: selectedDepartmentId,
        dateKey,
        queueNumber,
        studentId: studentIdentifier,
        phone: phoneNumber,
        status: "WAITING",
        holdAttempts: 0,
        waitingSince: new Date(),
        window: routing.window?._id,
        windowNumber: routing.window?.number,
    })

    const txLabelMap = getTransactionLabelMap()
    const selectedTransactionLabels = input.transactionKeys.map((key) => txLabelMap.get(key) || key)

    await TicketTransactionSelectionModel.create({
        ticket: ticket._id,
        participant: participant._id,
        participantType: participant.type,
        transactionKeys: input.transactionKeys,
        transactionLabels: selectedTransactionLabels,
    })

    await AuditLogModel.create({
        action: "QUEUE_JOINED",
        entityType: "Ticket",
        entityId: ticket._id,
        meta: {
            participantId: participant._id.toString(),
            participantType: participant.type,
            accountName,
            departmentId: selectedDepartmentId.toString(),
            transactionKeys: input.transactionKeys,
            studentId: studentIdentifier,
            phone: phoneNumber,
            windowId: routing.window?._id?.toString(),
            windowNumber: routing.window?.number,
            staffId: routing.staff?._id?.toString(),
        },
    })

    let voiceAnnouncement: string | undefined
    if (input.presentDirectlyToDisplayMonitor) {
        const called = await presentDirectlyToDisplayMonitor(ticket._id.toString())
        voiceAnnouncement = called.voiceAnnouncement
    }

    return {
        ticketId: ticket._id.toString(),
        queueNumber: ticket.queueNumber,
        dateKey: ticket.dateKey,
        status: input.presentDirectlyToDisplayMonitor ? "CALLED" : ticket.status,
        windowNumber: routing.window?.number,
        staffAssigned: routing.staff?._id?.toString(),
        accountName,
        nameOfPersonInCharge: routing.staff?.name,
        canPresentDirectlyToDisplayMonitor: true,
        voiceAnnouncement,
    }
}

export async function presentDirectlyToDisplayMonitor(ticketId: string) {
    if (!Types.ObjectId.isValid(ticketId)) {
        throw new Error("Invalid ticket id.")
    }

    const ticket = await TicketModel.findById(ticketId)
    if (!ticket) throw new Error("Ticket not found.")

    if (ticket.status === "OUT" || ticket.status === "SERVED") {
        throw new Error("Ticket can no longer be called.")
    }

    if (!ticket.windowNumber) {
        const routing = await resolveWindowAndStaff(ticket.department as Types.ObjectId)
        if (routing.window) {
            ticket.window = routing.window._id
            ticket.windowNumber = routing.window.number
        }
    }

    ticket.status = "CALLED"
    ticket.calledAt = new Date()
    await ticket.save()

    const windowNumber = ticket.windowNumber || 1
    const voiceAnnouncement = buildVoiceAnnouncement(ticket.queueNumber, windowNumber)

    await AuditLogModel.create({
        action: "TICKET_PRESENTED_TO_MONITOR",
        entityType: "Ticket",
        entityId: ticket._id,
        meta: {
            queueNumber: ticket.queueNumber,
            windowNumber,
            status: ticket.status,
        },
    })

    return {
        ticketId: ticket._id.toString(),
        queueNumber: ticket.queueNumber,
        windowNumber,
        status: ticket.status,
        voiceAnnouncement,
    }
}

export function numberToWords(num: number): string {
    if (!Number.isFinite(num)) return String(num)
    if (num < 0) return `minus ${numberToWords(Math.abs(num))}`

    const ones = [
        "Zero",
        "One",
        "Two",
        "Three",
        "Four",
        "Five",
        "Six",
        "Seven",
        "Eight",
        "Nine",
        "Ten",
        "Eleven",
        "Twelve",
        "Thirteen",
        "Fourteen",
        "Fifteen",
        "Sixteen",
        "Seventeen",
        "Eighteen",
        "Nineteen",
    ]
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

    const n = Math.floor(num)

    if (n < 20) return ones[n]
    if (n < 100) {
        const t = Math.floor(n / 10)
        const r = n % 10
        return r ? `${tens[t]} ${ones[r]}` : tens[t]
    }
    if (n < 1000) {
        const h = Math.floor(n / 100)
        const r = n % 100
        return r ? `${ones[h]} Hundred ${numberToWords(r)}` : `${ones[h]} Hundred`
    }
    if (n < 1000000) {
        const th = Math.floor(n / 1000)
        const r = n % 1000
        return r ? `${numberToWords(th)} Thousand ${numberToWords(r)}` : `${numberToWords(th)} Thousand`
    }

    return String(n)
}

export function formatQueueNumberLabel(queueNumber: number) {
    return `Number ${numberToWords(queueNumber)}`
}

export function buildVoiceAnnouncement(queueNumber: number, windowNumber: number) {
    return `Number ${numberToWords(queueNumber)}, please proceed to Window ${numberToWords(windowNumber)}.`
}

export function getJoinQueueQrPayload(baseUrl: string, departmentCode?: string) {
    const root = baseUrl.replace(/\/+$/, "")
    const query = new URLSearchParams()
    query.set("source", "qr")
    if (departmentCode) query.set("department", departmentCode)

    return {
        joinUrl: `${root}/queue/join?${query.toString()}`,
        shouldDisplayImmediately: true,
        label: "Scan QR Code to Join Queue",
    }
}
