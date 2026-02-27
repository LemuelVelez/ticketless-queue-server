import mongoose, { Schema, Types } from "mongoose"

import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel } from "../models/Department"
import { QueueCounterModel } from "../models/QueueCounter"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { TicketModel, type TicketStatus } from "../models/Ticket"
import { UserModel } from "../models/User"

import {
    verifyParticipantSession,
    type ParticipantDoc,
    type ParticipantType,
} from "./participantAuth.service"
import {
    getTransactionLabelMapForDepartment,
    validateTransactionsForParticipantInDepartment,
} from "./registrarTransactions.service"

/**
 * Some codebases define ParticipantType without "GUEST" even if the app supports it.
 * We safely widen here so queue join works for Student / Alumni-Visitor / Guest.
 */
type QueueJoinParticipantType = ParticipantType | "GUEST"

type TicketTransactionSelectionDoc = {
    ticket: Types.ObjectId
    participant: Types.ObjectId
    participantType: QueueJoinParticipantType
    transactionKeys: string[]
    transactionLabels: string[]
    createdAt: Date
    updatedAt: Date
}

const TicketTransactionSelectionSchema = new Schema<TicketTransactionSelectionDoc>(
    {
        ticket: { type: Schema.Types.ObjectId, ref: "Ticket", required: true, unique: true, index: true },
        participant: { type: Schema.Types.ObjectId, ref: "QueueParticipant", required: true, index: true },

        // ✅ Allow STUDENT / ALUMNI_VISITOR / GUEST (fixes Guest join failures)
        participantType: { type: String, enum: ["STUDENT", "ALUMNI_VISITOR", "GUEST"], required: true },

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
    // ✅ Students usually have tcNumber; Alumni/Guest usually have mobileNumber
    const anyP = participant as any
    return anyP.tcNumber || anyP.studentId || anyP.mobileNumber || anyP.phone
}

function normalizeKey(input?: string) {
    return (input || "").trim().toUpperCase()
}

function titleCaseWords(input?: string) {
    const s = String(input || "").trim()
    if (!s) return ""
    return s
        .toLowerCase()
        .split(/[\s_]+/g)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
}

function participantTypeLabel(t?: string) {
    const type = String(t || "").toUpperCase()
    if (type === "STUDENT") return "Student"
    if (type === "ALUMNI_VISITOR") return "Alumni / Visitor"
    if (type === "GUEST") return "Guest"
    return "Participant"
}

function joinList(items: string[], max = 6) {
    const clean = (items || []).map((x) => String(x || "").trim()).filter(Boolean)
    if (!clean.length) return ""
    if (clean.length <= max) return clean.join(", ")
    return `${clean.slice(0, max).join(", ")} +${clean.length - max} more`
}

function buildPersonFullName(personLike: any): string {
    /**
     * ✅ Prefer explicit name parts when available (first/middle/last),
     * because `name` can sometimes be a placeholder/identifier.
     */
    const first = String(personLike?.firstName ?? "").trim()
    const middle = String(personLike?.middleName ?? "").trim()
    const last = String(personLike?.lastName ?? "").trim()

    const composed = [first, middle, last].filter(Boolean).join(" ").trim()
    if (composed) return composed

    const name = String(personLike?.name ?? "").trim()
    if (name) return name

    return ""
}

function buildTicketWhereToGo(params: {
    status: TicketStatus
    queueNumber: number
    participantType?: string
    departmentName?: string
    departmentCode?: string
    transactionManager?: string
    windowNumber?: number
    windowName?: string
    staffName?: string
    servedDepartments?: string[]
    transactionLabels?: string[]
}) {
    const pLabel = participantTypeLabel(params.participantType)

    const deptLabel = params.departmentName
        ? params.departmentCode
            ? `${params.departmentName} (${params.departmentCode})`
            : params.departmentName
        : ""

    const officeLabel = params.transactionManager ? titleCaseWords(params.transactionManager) : ""

    const windowLabel = params.windowName
        ? params.windowNumber
            ? `${params.windowName} (Window ${params.windowNumber})`
            : params.windowName
        : params.windowNumber
          ? `Window ${params.windowNumber}`
          : ""

    const served = joinList(params.servedDepartments || [])
    const tx = joinList(params.transactionLabels || [])

    const staffLine = params.staffName ? `Staff in charge: ${params.staffName}.` : ""
    const servedLine = served ? `This window serves: ${served}.` : ""
    const txLine = tx ? `Transactions: ${tx}.` : ""

    const statusLine =
        params.status === "CALLED"
            ? "Proceed now."
            : params.status === "WAITING"
              ? "When your number is called, proceed."
              : "Proceed when instructed."

    // If no window is assigned yet, give a clearer instruction.
    if (!windowLabel) {
        const where = [
            `${statusLine}`,
            "Please check the display monitor for your assigned window.",
            deptLabel ? `Department: ${deptLabel}.` : "",
            officeLabel ? `Office: ${officeLabel}.` : "",
            txLine,
            staffLine,
        ]
            .map((x) => String(x || "").trim())
            .filter(Boolean)
            .join(" ")

        return {
            whereToGo: where,
            participantTypeLabel: pLabel,
            departmentName: params.departmentName,
            departmentCode: params.departmentCode,
            transactionManager: params.transactionManager,
            windowNumber: params.windowNumber,
            windowName: params.windowName,
            staffName: params.staffName,
            servedDepartments: params.servedDepartments || [],
            transactionLabels: params.transactionLabels || [],
        }
    }

    const where = [
        `${statusLine}`,
        `Go to ${windowLabel}.`,
        deptLabel ? `Department: ${deptLabel}.` : "",
        officeLabel ? `Office: ${officeLabel}.` : "",
        servedLine,
        txLine,
        staffLine,
        `Queue number: ${params.queueNumber}.`,
    ]
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .join(" ")

    return {
        whereToGo: where,
        participantTypeLabel: pLabel,
        departmentName: params.departmentName,
        departmentCode: params.departmentCode,
        transactionManager: params.transactionManager,
        windowNumber: params.windowNumber,
        windowName: params.windowName,
        staffName: params.staffName,
        servedDepartments: params.servedDepartments || [],
        transactionLabels: params.transactionLabels || [],
    }
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
        ;(staffQuery.$or as Array<Record<string, unknown>>).unshift({ assignedWindow: windowDoc._id })
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

export type TicketGuidanceDetails = {
    whereToGo: string
    participantTypeLabel: string
    departmentName?: string
    departmentCode?: string
    transactionManager?: string
    windowNumber?: number
    windowName?: string
    staffName?: string
    servedDepartments: string[]
    transactionLabels: string[]
}

export type JoinQueueResult = {
    ticketId: string
    queueNumber: number
    dateKey: string
    status: TicketStatus

    // ✅ user-friendly details (names > ids)
    departmentName?: string
    departmentCode?: string
    transactionManager?: string

    windowNumber?: number
    windowName?: string

    // kept for compatibility, but now returns a display value (name)
    staffAssigned?: string
    staffAssignedId?: string

    // ✅ participant full name (Student / Alumni-Visitor / Guest)
    participantFullName: string

    // ✅ now also used as a friendly display name
    accountName: string

    nameOfPersonInCharge?: string

    participantType?: QueueJoinParticipantType
    transactionKeys?: string[]
    transactionLabels?: string[]

    // ✅ single “ready-to-display” guidance string + structured details
    guidance: TicketGuidanceDetails

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

function participantTypeForTransactions(t: QueueJoinParticipantType) {
    // ✅ If registrar transaction rules don’t explicitly include GUEST,
    // treat it like Alumni/Visitor (least surprising behavior).
    return (t === "GUEST" ? "ALUMNI_VISITOR" : t) as any
}

export async function joinQueue(input: JoinQueueInput): Promise<JoinQueueResult> {
    const sessionState = await verifyParticipantSession(input.sessionToken)
    if (!sessionState) {
        throw new Error("Please login first before joining the queue.")
    }

    const { participant } = sessionState
    const anyP = participant as any

    const participantType = ((anyP.type || anyP.role || "GUEST") as string).toUpperCase() as QueueJoinParticipantType

    // ✅ Display full name for Student / Alumni-Visitor / Guest
    const participantFullName = buildPersonFullName(anyP) || buildPersonFullName(participant)
    const accountName = participantFullName || String(anyP?.name || "").trim() || "Participant"

    const dateKey = getDateKeyManila()

    const settings = await SettingModel.findOne({})
    const blockDuplicate = settings?.disallowDuplicateActiveTickets ?? true

    if (!input.transactionKeys?.length) {
        throw new Error("Please select at least one transaction.")
    }

    const selectedDepartmentId = await resolveJoinDepartment(participant, input.departmentId)

    const txType = participantTypeForTransactions(participantType)

    const validation = await validateTransactionsForParticipantInDepartment(
        txType,
        selectedDepartmentId,
        input.transactionKeys || []
    )
    if (!validation.isValid) {
        throw new Error(`Invalid transaction selection: ${validation.invalidKeys.join(", ")}`)
    }

    const providedIdentifier = String(input.studentId || "").trim()
    const providedPhone = String(input.phone || "").trim()

    // ✅ Identifier rules:
    // - STUDENT: tcNumber/studentId preferred
    // - ALUMNI_VISITOR/GUEST: mobileNumber preferred
    const candidateStudent = String(anyP.tcNumber || anyP.studentId || "").trim()
    const candidateMobile = String(anyP.mobileNumber || anyP.phone || "").trim()

    const participantIdentifier =
        providedIdentifier ||
        (participantType === "STUDENT"
            ? candidateStudent || candidateMobile
            : candidateMobile || candidateStudent) ||
        String(identifierOfParticipant(participant) || "").trim()

    if (!participantIdentifier) {
        if (participantType === "STUDENT") {
            throw new Error("Student ID is required.")
        }
        throw new Error("Mobile number is required.")
    }

    const phoneNumber = providedPhone || candidateMobile || undefined

    // For non-students, ensure we have a phone/mobile to contact (better UX)
    if ((participantType === "ALUMNI_VISITOR" || participantType === "GUEST") && !phoneNumber) {
        throw new Error("Mobile number is required.")
    }

    if (blockDuplicate) {
        const duplicate = await TicketModel.findOne({
            department: selectedDepartmentId,
            dateKey,
            studentId: participantIdentifier,
            status: { $in: ACTIVE_TICKET_STATUSES },
        })

        if (duplicate) {
            throw new Error("You already have an active queue ticket.")
        }
    }

    const queueNumber = await getNextQueueNumber(selectedDepartmentId, dateKey)
    const routing = await resolveWindowAndStaff(selectedDepartmentId)

    // ✅ Persist participant display name directly on the ticket
    // so ANY controller (even non-enriched ones) can display full name.
    const ticketPayload: any = {
        department: selectedDepartmentId,
        dateKey,
        queueNumber,

        // ✅ Field name stays "studentId" for backward compatibility,
        // but now stores the participant identifier (Student ID or Mobile # for Alumni/Guest)
        studentId: participantIdentifier,

        phone: phoneNumber,

        // ✅ Important for staff visibility (Student / Alumni-Visitor / Guest)
        participantType: participantType as any,

        // ✅ Full name for UI display (best UX)
        participantLabel: participantFullName || accountName,

        status: "WAITING",
        holdAttempts: 0,
        waitingSince: new Date(),
        window: routing.window?._id,
        windowNumber: routing.window?.number,
    }

    const ticket = await TicketModel.create(ticketPayload)

    const txLabelMap = await getTransactionLabelMapForDepartment(selectedDepartmentId, {
        participantType: txType,
    })
    const selectedTransactionLabels = input.transactionKeys.map((key) => txLabelMap.get(key) || key)

    await TicketTransactionSelectionModel.create({
        ticket: ticket._id,
        participant: participant._id,
        participantType,
        transactionKeys: input.transactionKeys,
        transactionLabels: selectedTransactionLabels,
    })

    await AuditLogModel.create({
        action: "QUEUE_JOINED",
        entityType: "Ticket",
        entityId: ticket._id,
        meta: {
            participantId: participant._id.toString(),
            participantType,
            participantFullName,
            accountName,
            departmentId: selectedDepartmentId.toString(),
            transactionKeys: input.transactionKeys,
            identifier: participantIdentifier,
            phone: phoneNumber,
            windowId: routing.window?._id?.toString(),
            windowNumber: routing.window?.number,
            staffId: routing.staff?._id?.toString(),
            staffName: routing.staff?.name,
        },
    })

    let effectiveStatus: TicketStatus = ticket.status
    let voiceAnnouncement: string | undefined

    if (input.presentDirectlyToDisplayMonitor) {
        const called = await presentDirectlyToDisplayMonitor(ticket._id.toString())
        effectiveStatus = called.status
        voiceAnnouncement = called.voiceAnnouncement
    }

    // ✅ Resolve friendly names for UI (names > ids)
    const department = await DepartmentModel.findById(selectedDepartmentId).select("name code transactionManager enabled")
    const servedDepts = routing.handledDepartmentIds?.length
        ? await DepartmentModel.find({ _id: { $in: routing.handledDepartmentIds }, enabled: true })
              .select("name code")
              .sort({ name: 1 })
        : []

    const servedDepartments = (servedDepts || [])
        .map((d) => String((d as any).code || (d as any).name || "").trim())
        .filter(Boolean)

    const windowName = routing.window?.name
    const windowNumber = routing.window?.number

    const staffAssignedId = routing.staff?._id?.toString()
    const staffAssignedName = routing.staff?.name

    const guidance = buildTicketWhereToGo({
        status: effectiveStatus,
        queueNumber: ticket.queueNumber,
        participantType,
        departmentName: department?.name,
        departmentCode: department?.code,
        transactionManager: department?.transactionManager,
        windowNumber,
        windowName,
        staffName: staffAssignedName,
        servedDepartments,
        transactionLabels: selectedTransactionLabels,
    })

    return {
        ticketId: ticket._id.toString(),
        queueNumber: ticket.queueNumber,
        dateKey: ticket.dateKey,
        status: effectiveStatus,

        departmentName: department?.name,
        departmentCode: department?.code,
        transactionManager: department?.transactionManager,

        windowNumber,
        windowName,

        // ✅ user-friendly (name), plus explicit id if needed
        staffAssigned: staffAssignedName,
        staffAssignedId,

        participantFullName,
        accountName,

        nameOfPersonInCharge: staffAssignedName,

        participantType,
        transactionKeys: input.transactionKeys,
        transactionLabels: selectedTransactionLabels,

        guidance,

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

    // ✅ Add friendly “where to go” details for display clients
    const department = await DepartmentModel.findById(ticket.department).select("name code transactionManager enabled")
    const windowDoc = ticket.window
        ? await ServiceWindowModel.findById(ticket.window).select("name number enabled")
        : await ServiceWindowModel.findOne({
              enabled: true,
              department: ticket.department,
              number: windowNumber,
          }).select("name number enabled")

    const selection = await TicketTransactionSelectionModel.findOne({ ticket: ticket._id })
        .populate({ path: "participant", select: "name firstName middleName lastName" })
        .select("participant participantType transactionLabels")

    const participantFullName = buildPersonFullName((selection as any)?.participant)

    // ✅ Backfill ticket participantLabel if missing (helps controllers that don't enrich)
    if (participantFullName && !(ticket as any).participantLabel) {
        ;(ticket as any).participantLabel = participantFullName
        await ticket.save()
    }

    const guidance = buildTicketWhereToGo({
        status: ticket.status,
        queueNumber: ticket.queueNumber,
        participantType: (ticket as any).participantType || selection?.participantType,
        departmentName: department?.name,
        departmentCode: department?.code,
        transactionManager: department?.transactionManager,
        windowNumber: windowDoc?.number || windowNumber,
        windowName: windowDoc?.name,
        staffName: undefined,
        servedDepartments: [],
        transactionLabels: selection?.transactionLabels || [],
    })

    return {
        ticketId: ticket._id.toString(),
        queueNumber: ticket.queueNumber,
        windowNumber,
        status: ticket.status,
        voiceAnnouncement,

        // ✅ participant full name (Student / Alumni-Visitor / Guest)
        participantFullName,

        // ✅ extra details (safe, additive)
        departmentName: department?.name,
        departmentCode: department?.code,
        transactionManager: department?.transactionManager,
        windowName: windowDoc?.name,
        participantType: (ticket as any).participantType || selection?.participantType,
        transactionLabels: selection?.transactionLabels || [],
        guidance,
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