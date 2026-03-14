import { Types } from "mongoose"
import { ServiceWindowModel, UserModel } from "../models/Model"
import { NameService } from "./NameService"

export type ServiceWindowAssignedStaffView = {
    id: string
    name: string
    email?: string
    active: boolean
    role: "STAFF"
}

export type ServiceWindowView = {
    id: string
    name: string
    number: number
    displayName: string
    enabled: boolean
    primaryDepartmentId?: string
    primaryDepartmentName?: string
    departmentIds: string[]
    departmentNames: string[]
    assignedStaffIds: string[]
    assignedStaffNames: string[]
    assignedStaff: ServiceWindowAssignedStaffView[]
    createdAt?: Date
    updatedAt?: Date
}

function normalizeObjectIdString(
    value: string | Types.ObjectId | null | undefined
): string | null {
    const normalized = NameService.toIdString(value)
    if (!normalized) return null
    return Types.ObjectId.isValid(normalized) ? normalized : null
}

function collectWindowDepartments(window: any) {
    const out: Array<{ id: string; name?: string }> = []
    const seen = new Set<string>()

    const pushDepartment = (department: any) => {
        const id = NameService.toIdString(department?._id ?? department)
        if (!id || seen.has(id)) return

        seen.add(id)

        const name = String(NameService.getDepartmentName(department) ?? "").trim()

        out.push({
            id,
            name: name || undefined,
        })
    }

    pushDepartment(window?.department)

    const departments = Array.isArray(window?.departmentIds)
        ? window.departmentIds
        : []

    for (const department of departments) {
        pushDepartment(department)
    }

    return out
}

async function getAssignedStaffMap(
    ids: Array<string | Types.ObjectId | null | undefined>
): Promise<Map<string, ServiceWindowAssignedStaffView[]>> {
    const normalizedWindowIds = Array.from(
        new Set(ids.map((id) => normalizeObjectIdString(id)).filter(Boolean) as string[])
    )

    if (!normalizedWindowIds.length) return new Map()

    const staffUsers = await UserModel.find({
        role: "STAFF",
        assignedWindow: {
            $in: normalizedWindowIds.map((id) => new Types.ObjectId(id)),
        },
    })
        .select("name email active assignedWindow")
        .sort({ name: 1, email: 1, createdAt: 1 })
        .lean()

    const map = new Map<string, ServiceWindowAssignedStaffView[]>()

    for (const user of staffUsers as any[]) {
        const assignedWindowId = normalizeObjectIdString(user?.assignedWindow)
        if (!assignedWindowId) continue

        const current = map.get(assignedWindowId) || []

        current.push({
            id: NameService.toIdString(user?._id) ?? "",
            name: String(user?.name ?? "").trim(),
            email: String(user?.email ?? "").trim() || undefined,
            active: Boolean(user?.active),
            role: "STAFF",
        })

        map.set(assignedWindowId, current)
    }

    return map
}

export class ServiceWindowService {
    static toView(
        window: any,
        assignedStaff: ServiceWindowAssignedStaffView[] = []
    ): ServiceWindowView {
        const primaryDepartment = window?.department
        const departmentEntries = collectWindowDepartments(window)

        const primaryDepartmentId =
            NameService.toIdString(primaryDepartment?._id ?? primaryDepartment) ??
            departmentEntries[0]?.id

        const resolvedPrimaryDepartmentName = String(
            primaryDepartment
                ? NameService.getDepartmentName(primaryDepartment)
                : departmentEntries[0]?.name ?? ""
        ).trim()

        const normalizedAssignedStaff = assignedStaff
            .filter((staff) => Boolean(staff?.id))
            .map((staff) => ({
                id: String(staff.id).trim(),
                name: String(staff.name ?? "").trim(),
                email: String(staff.email ?? "").trim() || undefined,
                active: Boolean(staff.active),
                role: "STAFF" as const,
            }))

        return {
            id: NameService.toIdString(window?._id) ?? "",
            name: String(window?.name ?? "").trim(),
            number: Number(window?.number ?? 0),
            displayName: NameService.getWindowName(window),
            enabled: Boolean(window?.enabled),
            primaryDepartmentId: primaryDepartmentId || undefined,
            primaryDepartmentName: resolvedPrimaryDepartmentName || undefined,
            departmentIds: departmentEntries.map((department) => department.id),
            departmentNames: departmentEntries
                .map((department) => String(department.name ?? "").trim())
                .filter((value): value is string => Boolean(value)),
            assignedStaffIds: normalizedAssignedStaff.map((staff) => staff.id),
            assignedStaffNames: normalizedAssignedStaff
                .map((staff) => staff.name)
                .filter(Boolean),
            assignedStaff: normalizedAssignedStaff,
            createdAt: window?.createdAt,
            updatedAt: window?.updatedAt,
        }
    }

    static async getById(windowId: string | Types.ObjectId): Promise<ServiceWindowView | null> {
        const normalizedWindowId = normalizeObjectIdString(windowId)
        if (!normalizedWindowId) return null

        const window = await ServiceWindowModel.findById(normalizedWindowId)
            .populate("department", "name code")
            .populate("departmentIds", "name code")
            .exec()

        if (!window) return null

        const assignedStaffMap = await getAssignedStaffMap([normalizedWindowId])

        return ServiceWindowService.toView(
            window,
            assignedStaffMap.get(normalizedWindowId) || []
        )
    }

    static async list(options?: {
        includeDisabled?: boolean
        departmentId?: string | Types.ObjectId | null
    }): Promise<ServiceWindowView[]> {
        const includeDisabled = Boolean(options?.includeDisabled)
        const normalizedDepartmentId = normalizeObjectIdString(
            options?.departmentId ?? null
        )

        const filter: Record<string, unknown> = {}

        if (!includeDisabled) {
            filter.enabled = true
        }

        if (normalizedDepartmentId) {
            filter.$or = [
                { department: normalizedDepartmentId },
                { departmentIds: normalizedDepartmentId },
            ]
        }

        const windows = await ServiceWindowModel.find(filter)
            .populate("department", "name code")
            .populate("departmentIds", "name code")
            .sort({ number: 1, name: 1 })
            .exec()

        const assignedStaffMap = await getAssignedStaffMap(
            windows.map((window) => window._id)
        )

        return windows.map((window) =>
            ServiceWindowService.toView(
                window,
                assignedStaffMap.get(String(window._id)) || []
            )
        )
    }

    static async listEnabled(): Promise<ServiceWindowView[]> {
        return ServiceWindowService.list({ includeDisabled: false })
    }

    static async listByDepartment(
        departmentId: string | Types.ObjectId,
        includeDisabled = false
    ): Promise<ServiceWindowView[]> {
        return ServiceWindowService.list({
            departmentId,
            includeDisabled,
        })
    }

    static async getNameMap(
        ids: Array<string | Types.ObjectId | null | undefined>
    ): Promise<Map<string, string>> {
        const normalizedIds = Array.from(
            new Set(ids.map((id) => normalizeObjectIdString(id)).filter(Boolean) as string[])
        )

        if (!normalizedIds.length) return new Map()

        const windows = await ServiceWindowModel.find({ _id: { $in: normalizedIds } })
            .select("name number")
            .exec()

        const map = new Map<string, string>()

        for (const window of windows) {
            map.set(String(window._id), NameService.getWindowName(window))
        }

        return map
    }
}
