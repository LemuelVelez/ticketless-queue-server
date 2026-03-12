import { Types } from "mongoose"

type RefLike = Types.ObjectId | string | null | undefined

type PersonLike = {
    _id?: RefLike
    id?: string
    name?: string
    firstName?: string
    middleName?: string
    lastName?: string
    studentId?: string
    tcNumber?: string
    email?: string
}

type DepartmentLike = {
    _id?: RefLike
    id?: string
    name?: string
    code?: string
}

type WindowLike = {
    _id?: RefLike
    id?: string
    name?: string
    number?: number
}

export class NameService {
    static toIdString(value?: RefLike): string | undefined {
        if (!value) return undefined
        return typeof value === "string" ? value : value.toString()
    }

    static compact(parts: Array<string | null | undefined>): string {
        return parts
            .map((part) => String(part ?? "").trim())
            .filter(Boolean)
            .join(" ")
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null
    }

    static getPersonName(person?: PersonLike | RefLike): string {
        if (!person) return "Unknown user"

        if (!NameService.isRecord(person)) {
            return NameService.toIdString(person) ?? "Unknown user"
        }

        const directName = String(person.name ?? "").trim()
        if (directName) return directName

        const composed = NameService.compact([
            typeof person.firstName === "string" ? person.firstName : undefined,
            typeof person.middleName === "string" ? person.middleName : undefined,
            typeof person.lastName === "string" ? person.lastName : undefined,
        ])
        if (composed) return composed

        const participantId = String(person.studentId ?? person.tcNumber ?? "").trim()
        if (participantId) return participantId

        const email = String(person.email ?? "").trim()
        if (email) return email

        return NameService.toIdString((person._id as RefLike) ?? (person.id as string | undefined)) ?? "Unknown user"
    }

    static getDepartmentName(department?: DepartmentLike | RefLike): string {
        if (!department) return "Unknown department"

        if (!NameService.isRecord(department)) {
            return NameService.toIdString(department) ?? "Unknown department"
        }

        const name = String(department.name ?? "").trim()
        if (name) return name

        const code = String(department.code ?? "").trim()
        if (code) return code

        return (
            NameService.toIdString((department._id as RefLike) ?? (department.id as string | undefined)) ??
            "Unknown department"
        )
    }

    static getWindowName(window?: WindowLike | RefLike): string {
        if (!window) return "Unassigned window"

        if (!NameService.isRecord(window)) {
            return NameService.toIdString(window) ?? "Unassigned window"
        }

        const name = String(window.name ?? "").trim()
        const number =
            typeof window.number === "number" && Number.isFinite(window.number)
                ? window.number
                : undefined

        if (name && typeof number === "number") {
            return `${name} (${number})`
        }

        if (name) return name
        if (typeof number === "number") return `Window ${number}`

        return (
            NameService.toIdString((window._id as RefLike) ?? (window.id as string | undefined)) ??
            "Unassigned window"
        )
    }

    static preferName(name?: string | null, id?: RefLike, fallback = "Unknown"): string {
        const cleanName = String(name ?? "").trim()
        if (cleanName) return cleanName
        return NameService.toIdString(id) ?? fallback
    }
}