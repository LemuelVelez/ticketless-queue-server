import type { Request, Response } from "express"
import { UserModel } from "../models/User"
import { signToken, verifyPassword } from "./security"

async function login(req: Request, res: Response, role: "ADMIN" | "STAFF") {
    const { email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ message: "email and password are required" })

    const user = await UserModel.findOne({ email: String(email).toLowerCase().trim(), role, active: true })
    if (!user) return res.status(401).json({ message: "Invalid credentials" })

    const ok = await verifyPassword(String(password), user.passwordSalt, user.passwordHash, user.passwordIterations)
    if (!ok) return res.status(401).json({ message: "Invalid credentials" })

    const secret = process.env.JWT_SECRET
    if (!secret) return res.status(500).json({ message: "JWT_SECRET missing" })

    const token = signToken(
        {
            sub: String(user._id),
            role: user.role,
            name: user.name,
            assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : undefined,
            assignedWindow: user.assignedWindow ? String(user.assignedWindow) : undefined,
        },
        secret,
        60 * 60 * 12
    )

    return res.json({
        token,
        user: {
            id: String(user._id),
            name: user.name,
            email: user.email,
            role: user.role,
            assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : null,
            assignedWindow: user.assignedWindow ? String(user.assignedWindow) : null,
        },
    })
}

export const authController = {
    adminLogin: (req: Request, res: Response) => login(req, res, "ADMIN"),
    staffLogin: (req: Request, res: Response) => login(req, res, "STAFF"),
    me: async (req: Request, res: Response) => {
        const u = (req as any).user
        return res.json({ user: u || null })
    },
}
