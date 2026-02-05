import { Types } from "mongoose"

import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { TicketModel } from "../models/Ticket"

import { ParticipantModel, buildAccountName } from "./participantAuth.service"
import {
    buildVoiceAnnouncement,
    formatQueueNumberLabel,
    getDateKeyManila,
    getDepartmentWindowAssignments,
    numberToWords,
} from "./queue.service"

export type QueueDisplayItem = {
    ticketId: string
    queueNumber: number
    queueLabel: string
    studentId: string
    studentName: string
}

export type WindowDisplaySnapshot = {
    windowId: string
    windowName: string
    windowNumber: number
    nowServing?: QueueDisplayItem
    upNext: QueueDisplayItem[]
    onHold: QueueDisplayItem[]
    sampleVoiceAnnouncement?: string
}

function normalizeKey(v?: string) {
    return (v || "").trim().toUpperCase()
}

async function resolveHandledDepartmentIds(windowNumber: number, fallbackDepartmentId: Types.ObjectId) {
    const assignments = getDepartmentWindowAssignments()
    const groupCodes = assignments[windowNumber]

    if (!groupCodes?.length) return [fallbackDepartmentId]

    const allEnabled = await DepartmentModel.find({ enabled: true }).select("_id code name")
    const codes = new Set(groupCodes.map((x) => normalizeKey(x)))

    const ids = allEnabled
        .filter((d) => codes.has(normalizeKey(d.code || d.name)))
        .map((d) => d._id)

    return ids.length ? ids : [fallbackDepartmentId]
}

async function resolveParticipantNames(identifiers: string[]) {
    if (!identifiers.length) return new Map<string, string>()

    const participants = await ParticipantModel.find({
        $or: [{ tcNumber: { $in: identifiers } }, { mobileNumber: { $in: identifiers } }],
    }).select("firstName middleName lastName tcNumber mobileNumber")

    const map = new Map<string, string>()
    for (const p of participants) {
        const fullName = buildAccountName(p)
        if (p.tcNumber) map.set(p.tcNumber, fullName)
        if (p.mobileNumber) map.set(p.mobileNumber, fullName)
    }

    return map
}

function toDisplayItem(
    ticket: { _id: Types.ObjectId; queueNumber: number; studentId: string },
    nameMap: Map<string, string>
): QueueDisplayItem {
    return {
        ticketId: ticket._id.toString(),
        queueNumber: ticket.queueNumber,
        queueLabel: formatQueueNumberLabel(ticket.queueNumber),
        studentId: ticket.studentId,
        studentName: nameMap.get(ticket.studentId) || ticket.studentId,
    }
}

export async function getPublicDisplayMonitorSnapshot(dateKey = getDateKeyManila()) {
    const settings = await SettingModel.findOne({})
    const upNextCount = settings?.upNextCount ?? 5

    const windows = await ServiceWindowModel.find({ enabled: true }).sort({ number: 1, name: 1 })

    const snapshots: WindowDisplaySnapshot[] = []

    for (const windowDoc of windows) {
        const handledDepartmentIds = await resolveHandledDepartmentIds(windowDoc.number, windowDoc.department as Types.ObjectId)

        const nowServing = await TicketModel.findOne({
            dateKey,
            status: "CALLED",
            department: { $in: handledDepartmentIds },
            $or: [{ window: windowDoc._id }, { windowNumber: windowDoc.number }],
        }).sort({ calledAt: -1, updatedAt: -1 })

        const upNext = await TicketModel.find({
            dateKey,
            status: "WAITING",
            department: { $in: handledDepartmentIds },
        })
            .sort({ queueNumber: 1, waitingSince: 1 })
            .limit(upNextCount)

        const onHold = await TicketModel.find({
            dateKey,
            status: "HOLD",
            department: { $in: handledDepartmentIds },
        })
            .sort({ updatedAt: -1, queueNumber: 1 })
            .limit(upNextCount)

        const ids = [
            ...(nowServing ? [nowServing.studentId] : []),
            ...upNext.map((t) => t.studentId),
            ...onHold.map((t) => t.studentId),
        ]

        const nameMap = await resolveParticipantNames(ids)

        const row: WindowDisplaySnapshot = {
            windowId: windowDoc._id.toString(),
            windowName: windowDoc.name,
            windowNumber: windowDoc.number,
            nowServing: nowServing ? toDisplayItem(nowServing, nameMap) : undefined,
            upNext: upNext.map((t) => toDisplayItem(t, nameMap)),
            onHold: onHold.map((t) => toDisplayItem(t, nameMap)),
            sampleVoiceAnnouncement: nowServing
                ? buildVoiceAnnouncement(nowServing.queueNumber, windowDoc.number)
                : undefined,
        }

        snapshots.push(row)
    }

    return snapshots
}

export function buildPublicDisplayMonitorText(snapshot: WindowDisplaySnapshot[]) {
    const lines: string[] = []

    for (const row of snapshot) {
        lines.push(`Window ${numberToWords(row.windowNumber)}`)
        lines.push(`Now Serving: ${row.nowServing?.queueLabel || "—"}`)
        lines.push(`${row.nowServing?.studentName || "—"}`)
        lines.push(`Up Next: ${row.upNext.length ? row.upNext.map((x) => x.queueLabel).join(", ") : "—"}`)
        lines.push(`On Hold: ${row.onHold.length ? row.onHold.map((x) => x.queueLabel).join(", ") : "—"}`)
        lines.push("")
    }

    return lines.join("\n").trim()
}

export async function getVoiceAnnouncementForTicket(ticketId: string) {
    const ticket = await TicketModel.findById(ticketId)
    if (!ticket) throw new Error("Ticket not found.")

    const windowNumber = ticket.windowNumber || 1
    return buildVoiceAnnouncement(ticket.queueNumber, windowNumber)
}
