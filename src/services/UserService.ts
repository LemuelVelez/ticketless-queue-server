import { Types } from "mongoose"
import { UserModel } from "../models/Model"
import { resolveStoredFileUrl } from "../s3"
import { NameService } from "./NameService"

export type UserView = {
    id: string
    name: string
    email?: string
    role: string
    active: boolean
    participantType?: string
    studentId?: string
    phone?: string
    departmentName?: string
    assignedDepartmentNames: string[]
    assignedWindowName?: string
    avatarUrl?: string
    createdAt?: Date
    updatedAt?: Date
}

export class UserService {
    static toView(user: any): UserView {
        const assignedDepartmentsSource =
            Array.isArray(user?.assignedDepartments) && user.assignedDepartments.length > 0
                ? user.assignedDepartments
                : user?.assignedDepartment
                    ? [user.assignedDepartment]
                    : []

        const assignedDepartmentNames = Array.from(
            new Set(
                assignedDepartmentsSource
                    .map((department: any) => NameService.getDepartmentName(department))
                    .filter(Boolean)
            )
        )

        return {
            id: NameService.toIdString(user?._id) ?? "",
            name: NameService.getPersonName(user),
            email: user?.email ? String(user.email).trim() : undefined,
            role: String(user?.role ?? "").trim(),
            active: Boolean(user?.active),
            participantType: user?.type ? String(user.type).trim() : undefined,
            studentId: String(user?.studentId ?? user?.tcNumber ?? "").trim() || undefined,
            phone: String(user?.phone ?? user?.mobileNumber ?? "").trim() || undefined,
            departmentName: user?.departmentId
                ? NameService.getDepartmentName(user.departmentId)
                : undefined,
            assignedDepartmentNames,
            assignedWindowName: user?.assignedWindow
                ? NameService.getWindowName(user.assignedWindow)
                : undefined,
            avatarUrl: resolveStoredFileUrl(user?.avatarUrl),
            createdAt: user?.createdAt,
            updatedAt: user?.updatedAt,
        }
    }

    static async getById(userId: string | Types.ObjectId): Promise<UserView | null> {
        const user = await UserModel.findById(userId)
            .populate("departmentId", "name code")
            .populate("assignedDepartment", "name code")
            .populate("assignedDepartments", "name code")
            .populate("assignedWindow", "name number")
            .exec()

        return user ? UserService.toView(user) : null
    }

    static async getByStudentId(studentId: string): Promise<UserView | null> {
        const cleanStudentId = String(studentId ?? "").trim()
        if (!cleanStudentId) return null

        const user = await UserModel.findOne({
            $or: [{ studentId: cleanStudentId }, { tcNumber: cleanStudentId }],
        })
            .populate("departmentId", "name code")
            .populate("assignedDepartment", "name code")
            .populate("assignedDepartments", "name code")
            .populate("assignedWindow", "name number")
            .exec()

        return user ? UserService.toView(user) : null
    }

    static async listStaff(includeInactive = false): Promise<UserView[]> {
        const filter: Record<string, unknown> = {
            role: { $in: ["ADMIN", "STAFF"] },
        }

        if (!includeInactive) filter.active = true

        const users = await UserModel.find(filter)
            .populate("departmentId", "name code")
            .populate("assignedDepartment", "name code")
            .populate("assignedDepartments", "name code")
            .populate("assignedWindow", "name number")
            .sort({ name: 1, email: 1 })
            .exec()

        return users.map((user) => UserService.toView(user))
    }

    static async listParticipants(includeInactive = false): Promise<UserView[]> {
        const filter: Record<string, unknown> = {
            role: { $in: ["STUDENT", "ALUMNI_VISITOR", "GUEST"] },
        }

        if (!includeInactive) filter.active = true

        const users = await UserModel.find(filter)
            .populate("departmentId", "name code")
            .sort({ name: 1, studentId: 1 })
            .exec()

        return users.map((user) => UserService.toView(user))
    }

    static async getNameMap(
        ids: Array<string | Types.ObjectId | null | undefined>
    ): Promise<Map<string, string>> {
        const normalizedIds = Array.from(
            new Set(ids.map((id) => NameService.toIdString(id)).filter(Boolean) as string[])
        )

        if (!normalizedIds.length) return new Map()

        const users = await UserModel.find({ _id: { $in: normalizedIds } })
            .select("name firstName middleName lastName studentId tcNumber email")
            .exec()

        const map = new Map<string, string>()

        for (const user of users) {
            map.set(String(user._id), NameService.getPersonName(user))
        }

        return map
    }

    static async getParticipantNameMapByStudentIds(studentIds: string[]): Promise<Map<string, string>> {
        const normalizedStudentIds = Array.from(
            new Set(
                studentIds
                    .map((value) => String(value ?? "").trim())
                    .filter(Boolean)
            )
        )

        if (!normalizedStudentIds.length) return new Map()

        const users = await UserModel.find({
            $or: [
                { studentId: { $in: normalizedStudentIds } },
                { tcNumber: { $in: normalizedStudentIds } },
            ],
        })
            .select("name firstName middleName lastName studentId tcNumber")
            .exec()

        const map = new Map<string, string>()

        for (const user of users) {
            const displayName = NameService.getPersonName(user)

            if (user.studentId) map.set(String(user.studentId), displayName)
            if (user.tcNumber) map.set(String(user.tcNumber), displayName)
        }

        return map
    }
}