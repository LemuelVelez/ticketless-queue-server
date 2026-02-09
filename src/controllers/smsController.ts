import { Request, Response } from "express"
import { TicketModel } from "../models/Ticket"
import { UserModel } from "../models/User"

const SEMAPHORE_MESSAGES_ENDPOINT = "https://api.semaphore.co/api/v4/messages"

type SendSemaphoreSmsInput = {
    number: string
    message: string
    senderName?: string
}

type SmsControllerType = {
    sendSms: (req: Request, res: Response) => Promise<Response>
    sendTicketCalled: (req: Request, res: Response) => Promise<Response>
}

function getSemaphoreApiKey(): string {
    const key = (process.env.semaphore_api_key || process.env.SEMAPHORE_API_KEY || "").trim()
    if (!key) {
        throw new Error("Missing semaphore_api_key in .env")
    }
    return key
}

function normalizePHMobile(input: string): string | null {
    const digits = String(input || "").replace(/\D/g, "")

    // 09XXXXXXXXX -> 639XXXXXXXXX
    if (/^09\d{9}$/.test(digits)) return `63${digits.slice(1)}`

    // 9XXXXXXXXX -> 639XXXXXXXXX
    if (/^9\d{9}$/.test(digits)) return `63${digits}`

    // 639XXXXXXXXX
    if (/^639\d{9}$/.test(digits)) return digits

    return null
}

function defaultCalledMessage(queueNumber: number, windowNumber?: number): string {
    const windowText = typeof windowNumber === "number" ? ` at Window ${windowNumber}` : ""
    return `Queue update: Your ticket #${queueNumber} is now being served${windowText}.`
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return "Unknown error"
}

async function resolvePhoneFromTicket(studentId: string, ticketPhone?: string): Promise<string> {
    const direct = String(ticketPhone || "").trim()
    if (direct) return direct

    const user = await UserModel.findOne(
        {
            $or: [{ studentId }, { tcNumber: studentId }],
        },
        { mobileNumber: 1, phone: 1 }
    ).lean()

    return String(user?.mobileNumber || user?.phone || "").trim()
}

export async function sendSemaphoreSms(input: SendSemaphoreSmsInput): Promise<{ number: string; payload: unknown }> {
    const apiKey = getSemaphoreApiKey()

    const normalizedNumber = normalizePHMobile(input.number)
    if (!normalizedNumber) {
        throw new Error("Invalid Philippine mobile number format")
    }

    const message = String(input.message || "").trim()
    if (!message) {
        throw new Error("Message is required")
    }

    const senderName = String(input.senderName || process.env.SEMAPHORE_SENDER_NAME || "").trim()

    const body = new URLSearchParams()
    body.append("apikey", apiKey)
    body.append("number", normalizedNumber)
    body.append("message", message)
    if (senderName) body.append("sendername", senderName)

    const fetchFn = (globalThis as any).fetch
    if (typeof fetchFn !== "function") {
        throw new Error("Global fetch is not available. Please run on Node.js 18+.")
    }

    const response = await fetchFn(SEMAPHORE_MESSAGES_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    })

    const raw = await response.text()
    let payload: unknown = raw

    try {
        payload = JSON.parse(raw)
    } catch {
        // keep raw text payload
    }

    if (!response.ok) {
        const details = typeof payload === "string" ? payload : JSON.stringify(payload)
        throw new Error(`Semaphore API request failed (${response.status}): ${details}`)
    }

    return { number: normalizedNumber, payload }
}

async function sendSms(req: Request, res: Response): Promise<Response> {
    try {
        const rawNumber = String(
            req.body?.number ?? req.body?.phone ?? req.body?.mobileNumber ?? ""
        ).trim()
        const message = String(req.body?.message ?? "").trim()
        const senderName = String(req.body?.senderName ?? "").trim()

        if (!rawNumber) {
            return res.status(400).json({ ok: false, error: "number is required" })
        }

        if (!message) {
            return res.status(400).json({ ok: false, error: "message is required" })
        }

        const result = await sendSemaphoreSms({
            number: rawNumber,
            message,
            senderName: senderName || undefined,
        })

        return res.status(200).json({
            ok: true,
            provider: "semaphore",
            number: result.number,
            result: result.payload,
        })
    } catch (error) {
        return res.status(500).json({
            ok: false,
            error: toErrorMessage(error),
        })
    }
}

async function sendTicketCalled(req: Request, res: Response): Promise<Response> {
    try {
        const { id } = req.params

        const ticket = await TicketModel.findById(id).lean()
        if (!ticket) {
            return res.status(404).json({ ok: false, error: "Ticket not found" })
        }

        const rawPhone = await resolvePhoneFromTicket(ticket.studentId, ticket.phone)
        if (!rawPhone) {
            return res.status(400).json({
                ok: false,
                error: "No phone number found for this ticket",
            })
        }

        const customMessage = String(req.body?.message ?? "").trim()
        const senderName = String(req.body?.senderName ?? "").trim()

        const message =
            customMessage || defaultCalledMessage(ticket.queueNumber, ticket.windowNumber)

        const result = await sendSemaphoreSms({
            number: rawPhone,
            message,
            senderName: senderName || undefined,
        })

        return res.status(200).json({
            ok: true,
            provider: "semaphore",
            ticketId: ticket._id,
            number: result.number,
            result: result.payload,
        })
    } catch (error) {
        return res.status(500).json({
            ok: false,
            error: toErrorMessage(error),
        })
    }
}

export const smsController: SmsControllerType = {
    sendSms,
    sendTicketCalled,
}
