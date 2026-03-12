import type { NextFunction, Response } from "express"

export class ControllerUtils {
    static getValue(...values: unknown[]): string | undefined {
        for (const value of values) {
            if (Array.isArray(value)) {
                const first = value.find((item) => String(item ?? "").trim())
                if (first !== undefined) {
                    const normalized = String(first).trim()
                    if (normalized) return normalized
                }
                continue
            }

            const normalized = String(value ?? "").trim()
            if (normalized) return normalized
        }

        return undefined
    }

    static parseBoolean(value: unknown, fallback = false): boolean {
        const normalized = ControllerUtils.getValue(value)?.toLowerCase()

        if (!normalized) return fallback
        if (["true", "1", "yes", "y", "on"].includes(normalized)) return true
        if (["false", "0", "no", "n", "off"].includes(normalized)) return false

        return fallback
    }

    static parseLimit(
        value: unknown,
        fallback = 50,
        options?: { min?: number; max?: number }
    ): number {
        const min = options?.min ?? 1
        const max = options?.max ?? 200

        const normalized = Number(ControllerUtils.getValue(value))

        if (!Number.isFinite(normalized)) return fallback

        return Math.min(Math.max(Math.floor(normalized), min), max)
    }

    static getDateKey(value: unknown): string {
        const provided = ControllerUtils.getValue(value)
        if (provided) return provided

        const now = new Date()
        const year = now.getFullYear()
        const month = String(now.getMonth() + 1).padStart(2, "0")
        const day = String(now.getDate()).padStart(2, "0")

        return `${year}-${month}-${day}`
    }

    static sendBadRequest(res: Response, message: string): Response {
        return res.status(400).json({ message })
    }

    static sendNotFound(res: Response, message: string): Response {
        return res.status(404).json({ message })
    }

    static forwardError(error: unknown, next: NextFunction): void {
        next(error)
    }
}